import { Router } from 'express'
import { requireAuth } from '@clerk/express'
import crypto from 'crypto'
import { pool, getOrCreateUser } from '../db.js'
import {
  exchangeToken,
  fetchGoogleAccountEmail,
  googleCalendarConfig,
  OAUTH_SCOPES,
} from '../services/googleCalendarSync.js'
import { getAppBaseUrl } from '../services/appUrl.js'
import { encryptToken } from '../utils/tokenEncryption.js'

/**
 * Google Calendar connect / disconnect — one-way, write-only habit sync.
 *
 * Deliberately a separate router and a separate OAuth client from the Google
 * Health flow in routes/fitbit.js: a client may connect either integration
 * independently, and revoking one must not disturb the other. The structure
 * below intentionally mirrors fitbit.js so the two stay easy to compare.
 *
 * There is no route here that reads the client's calendar, and none should be
 * added — see the note at the top of services/googleCalendarSync.js.
 */

const router = Router()

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

function forwardedHeaderValue(req, name) {
  const value = req.get(name)
  return value?.split(',')[0]?.trim()
}

function urlHost(value) {
  if (!value) return null
  try {
    return new URL(value).host
  } catch {
    return null
  }
}

function requestBaseUrl(req) {
  const host = forwardedHeaderValue(req, 'x-forwarded-host') || req.get('host')
  if (!host) return null

  const proto = forwardedHeaderValue(req, 'x-forwarded-proto') || req.protocol || 'https'
  const base = `${proto}://${host}`.replace(/\/+$/, '')

  try {
    const url = new URL(base)
    const hostname = url.hostname.toLowerCase()
    const allowedHost =
      hostname === 'app.lwcvip.com'
      || hostname === 'metacoach-staging.up.railway.app'
      || hostname === 'metacoach-production.up.railway.app'
      || /^localhost$|^127\.0\.0\.1$/.test(hostname)
    return allowedHost ? url.origin : null
  } catch {
    return null
  }
}

function appBaseUrl(req) {
  return requestBaseUrl(req) || getAppBaseUrl()
}

function googleCalendarRedirectUri(req) {
  const requestBase = requestBaseUrl(req)
  const explicitRedirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI

  if (explicitRedirectUri) {
    if (!requestBase) return explicitRedirectUri

    try {
      const explicitHost = new URL(explicitRedirectUri).host
      const requestHost = new URL(requestBase).host
      if (explicitHost === requestHost) return explicitRedirectUri

      console.warn('[calendar oauth] GOOGLE_CALENDAR_REDIRECT_URI host differs from request host; using request callback', {
        configuredHost: explicitHost,
        requestHost,
      })
    } catch {
      console.warn('[calendar oauth] GOOGLE_CALENDAR_REDIRECT_URI is not a valid URL; using request callback')
    }
  }

  return `${appBaseUrl(req).replace(/\/$/, '')}/api/calendar/callback`
}

function frontendUrl(req, path, params = {}) {
  const base = appBaseUrl(req)
  const url = new URL(path, `${base}/`)
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function redirectToSettingsError(req, res, message) {
  const reason = message || 'connection_failed'
  const redirectUrl = frontendUrl(req, '/settings', { calendar_error: reason })
  console.warn('[calendar redirect] settings error:', {
    reason,
    redirectHost: new URL(redirectUrl).host,
  })
  return res.redirect(redirectUrl)
}

function addSeconds(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000)
}

async function currentDbUserId(req) {
  return getOrCreateUser(req.effectiveClerkUserId)
}

async function createGoogleCalendarOAuthUrl(req) {
  const { GOOGLE_CALENDAR_CLIENT_ID } = googleCalendarConfig()
  const GOOGLE_CALENDAR_REDIRECT_URI = googleCalendarRedirectUri(req)
  const baseUrl = appBaseUrl(req)
  console.log('[calendar connect] config:', {
    appBaseUrl: baseUrl,
    requestBaseUrl: requestBaseUrl(req),
    configuredAppBaseUrl: process.env.APP_BASE_URL || null,
    redirectUriHost: new URL(GOOGLE_CALENDAR_REDIRECT_URI).host,
    hasClientId: Boolean(GOOGLE_CALENDAR_CLIENT_ID),
    hasClientSecret: Boolean(process.env.GOOGLE_CALENDAR_CLIENT_SECRET),
    hasExplicitRedirectUri: Boolean(process.env.GOOGLE_CALENDAR_REDIRECT_URI),
    explicitRedirectUriHost: urlHost(process.env.GOOGLE_CALENDAR_REDIRECT_URI),
  })
  const dbUserId = await currentDbUserId(req)
  const state = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  await pool.query('DELETE FROM google_calendar_oauth_state WHERE user_id=$1 OR expires_at < NOW()', [dbUserId])
  await pool.query(
    'INSERT INTO google_calendar_oauth_state (state, user_id, expires_at) VALUES ($1, $2, $3)',
    [state, dbUserId, expiresAt],
  )

  const url = new URL(GOOGLE_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', GOOGLE_CALENDAR_CLIENT_ID)
  url.searchParams.set('redirect_uri', GOOGLE_CALENDAR_REDIRECT_URI)
  url.searchParams.set('scope', OAUTH_SCOPES)
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  // select_account forces Google's account chooser every time (not just on first
  // consent) — without it, a user signed into one Google account in their browser
  // may never see the chooser and silently connect the same (wrong) account.
  url.searchParams.set('prompt', 'consent select_account')
  return url.toString()
}

// GET /api/calendar/connect
router.get('/connect', requireAuth(), async (req, res, next) => {
  try {
    res.redirect(await createGoogleCalendarOAuthUrl(req))
  } catch (err) {
    next(err)
  }
})

// POST /api/calendar/connect
router.post('/connect', requireAuth(), async (req, res, next) => {
  try {
    res.json({ url: await createGoogleCalendarOAuthUrl(req) })
  } catch (err) {
    next(err)
  }
})

// GET /api/calendar/callback
router.get('/callback', async (req, res, next) => {
  try {
    googleCalendarConfig()
    const GOOGLE_CALENDAR_REDIRECT_URI = googleCalendarRedirectUri(req)
    console.log('[calendar callback] token exchange redirect_uri:', {
      redirectUriHost: new URL(GOOGLE_CALENDAR_REDIRECT_URI).host,
      requestBaseUrl: requestBaseUrl(req),
      postCallbackHost: new URL(frontendUrl(req, '/settings')).host,
    })
    const { code, state, error, error_description } = req.query
    if (error) {
      const reason = error_description || error
      console.warn('[calendar callback] oauth error:', reason)
      return redirectToSettingsError(req, res, reason)
    }
    if (!code || !state) {
      console.warn('[calendar callback] missing callback params:', {
        hasCode: Boolean(code),
        hasState: Boolean(state),
      })
      return redirectToSettingsError(req, res, 'missing_authorization_code_or_state')
    }

    // One-time use — the DELETE ... RETURNING both validates and consumes it.
    const { rows } = await pool.query(
      `DELETE FROM google_calendar_oauth_state
       WHERE state=$1 AND expires_at > NOW()
       RETURNING user_id`,
      [state],
    )
    const dbUserId = rows[0]?.user_id
    if (!dbUserId) {
      console.warn('[calendar callback] invalid or expired oauth state')
      return redirectToSettingsError(req, res, 'invalid_or_expired_state')
    }

    const data = await exchangeToken({
      grant_type:   'authorization_code',
      redirect_uri: GOOGLE_CALENDAR_REDIRECT_URI,
      code:         String(code),
    })
    if (!data.refresh_token) {
      console.warn('[calendar callback] token response missing refresh token')
      return redirectToSettingsError(req, res, 'missing_refresh_token')
    }

    const googleEmail = await fetchGoogleAccountEmail(data.access_token)
    const grantedScope = data.scope || OAUTH_SCOPES
    console.log('[calendar callback] token granted:', {
      user_id:         dbUserId,
      google_email:    googleEmail ?? '(could not fetch — userinfo call failed or email scope not granted)',
      requested_scope: OAUTH_SCOPES,
      granted_scope:   grantedScope,
    })

    await pool.query(
      `INSERT INTO google_calendar_tokens
        (user_id, access_token, refresh_token, scope, expires_at, google_email, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         access_token=EXCLUDED.access_token,
         refresh_token=EXCLUDED.refresh_token,
         scope=EXCLUDED.scope,
         expires_at=EXCLUDED.expires_at,
         google_email=EXCLUDED.google_email,
         last_sync_error=NULL,
         last_sync_error_at=NULL,
         updated_at=NOW()`,
      [dbUserId, encryptToken(data.access_token), encryptToken(data.refresh_token),
       grantedScope, addSeconds(data.expires_in), googleEmail],
    )

    const successRedirectUrl = frontendUrl(req, '/settings', { connected: 'calendar' })
    console.log('[calendar callback] success redirect:', {
      redirectHost: new URL(successRedirectUrl).host,
    })
    res.redirect(successRedirectUrl)
  } catch (err) {
    console.error('[calendar callback]', err.message)
    return redirectToSettingsError(req, res, err.message || 'connection_failed')
  }
})

// GET /api/calendar/status
// Reports on OUR stored token row only — this does not touch the user's calendar.
router.get('/status', requireAuth(), async (req, res, next) => {
  try {
    const dbUserId = await currentDbUserId(req)
    const { rows } = await pool.query(
      `SELECT google_email, last_synced_at, last_sync_error, last_sync_error_at
       FROM google_calendar_tokens WHERE user_id=$1`,
      [dbUserId],
    )
    const token = rows[0]
    res.json({
      connected:          Boolean(token),
      google_email:       token?.google_email       ?? null,
      last_synced_at:     token?.last_synced_at     ?? null,
      last_sync_error:    token?.last_sync_error    ?? null,
      last_sync_error_at: token?.last_sync_error_at ?? null,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/calendar/disconnect (DELETE accepted too, matching the Google Health route)
//
// Drops our token row only. Events already pushed are intentionally left on the
// client's calendar — deleting them would need calendar writes at the exact
// moment the client is revoking our access, and they may well want to keep them.
// Any stale coach_assigned_habits.google_calendar_event_id is harmless: it is
// only ever used again if they reconnect, and a since-deleted event self-heals
// (see the 404/410 handling in services/googleCalendarSync.js).
async function disconnectHandler(req, res, next) {
  try {
    const dbUserId = await currentDbUserId(req)
    await pool.query('DELETE FROM google_calendar_tokens WHERE user_id=$1', [dbUserId])
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
}

router.post('/disconnect', requireAuth(), disconnectHandler)
router.delete('/disconnect', requireAuth(), disconnectHandler)

export default router
