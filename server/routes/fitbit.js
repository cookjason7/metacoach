import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import crypto from 'crypto'
import { pool, getOrCreateUser } from '../db.js'
import { syncUser, exchangeToken } from '../services/googleHealthSync.js'
import { getAppBaseUrl } from '../services/appUrl.js'

const router = Router()

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
].join(' ')

function googleHealthConfig() {
  const { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET } = process.env
  if (!GOOGLE_HEALTH_CLIENT_ID || !GOOGLE_HEALTH_CLIENT_SECRET) {
    const err = new Error('Google Health OAuth is not configured')
    err.status = 503
    throw err
  }
  return { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET }
}

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

function googleHealthRedirectUri(req) {
  const requestBase = requestBaseUrl(req)
  const explicitRedirectUri = process.env.GOOGLE_HEALTH_REDIRECT_URI

  if (explicitRedirectUri) {
    if (!requestBase) return explicitRedirectUri

    try {
      const explicitHost = new URL(explicitRedirectUri).host
      const requestHost = new URL(requestBase).host
      if (explicitHost === requestHost) return explicitRedirectUri

      console.warn('[fitbit oauth] GOOGLE_HEALTH_REDIRECT_URI host differs from request host; using request callback', {
        configuredHost: explicitHost,
        requestHost,
      })
    } catch {
      console.warn('[fitbit oauth] GOOGLE_HEALTH_REDIRECT_URI is not a valid URL; using request callback')
    }
  }

  return `${appBaseUrl(req).replace(/\/$/, '')}/api/fitbit/callback`
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
  const redirectUrl = frontendUrl(req, '/settings', { fitbit_error: reason })
  console.warn('[fitbit redirect] settings error:', {
    reason,
    redirectHost: new URL(redirectUrl).host,
  })
  return res.redirect(redirectUrl)
}

function addSeconds(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000)
}

async function currentDbUserId(req) {
  const { userId } = getAuth(req)
  return getOrCreateUser(userId)
}

async function createGoogleHealthOAuthUrl(req) {
  const { GOOGLE_HEALTH_CLIENT_ID } = googleHealthConfig()
  const GOOGLE_HEALTH_REDIRECT_URI = googleHealthRedirectUri(req)
  const baseUrl = appBaseUrl(req)
  console.log('[fitbit connect] config:', {
    appBaseUrl: baseUrl,
    requestBaseUrl: requestBaseUrl(req),
    configuredAppBaseUrl: process.env.APP_BASE_URL || null,
    redirectUriHost: new URL(GOOGLE_HEALTH_REDIRECT_URI).host,
    hasClientId: Boolean(GOOGLE_HEALTH_CLIENT_ID),
    hasClientSecret: Boolean(process.env.GOOGLE_HEALTH_CLIENT_SECRET),
    hasExplicitRedirectUri: Boolean(process.env.GOOGLE_HEALTH_REDIRECT_URI),
    explicitRedirectUriHost: urlHost(process.env.GOOGLE_HEALTH_REDIRECT_URI),
  })
  const dbUserId = await currentDbUserId(req)
  const state = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

  await pool.query('DELETE FROM fitbit_oauth_state WHERE user_id=$1 OR expires_at < NOW()', [dbUserId])
  await pool.query(
    'INSERT INTO fitbit_oauth_state (state, user_id, expires_at) VALUES ($1, $2, $3)',
    [state, dbUserId, expiresAt],
  )

  const url = new URL(GOOGLE_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', GOOGLE_HEALTH_CLIENT_ID)
  url.searchParams.set('redirect_uri', GOOGLE_HEALTH_REDIRECT_URI)
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

// GET /api/fitbit/connect
router.get('/connect', requireAuth(), async (req, res, next) => {
  try {
    res.redirect(await createGoogleHealthOAuthUrl(req))
  } catch (err) {
    next(err)
  }
})

// POST /api/fitbit/connect
router.post('/connect', requireAuth(), async (req, res, next) => {
  try {
    res.json({ url: await createGoogleHealthOAuthUrl(req) })
  } catch (err) {
    next(err)
  }
})

// GET /api/fitbit/callback
router.get('/callback', async (req, res, next) => {
  try {
    googleHealthConfig()
    const GOOGLE_HEALTH_REDIRECT_URI = googleHealthRedirectUri(req)
    console.log('[fitbit callback] token exchange redirect_uri:', {
      redirectUriHost: new URL(GOOGLE_HEALTH_REDIRECT_URI).host,
      requestBaseUrl: requestBaseUrl(req),
      postCallbackHost: new URL(frontendUrl(req, '/settings')).host,
    })
    const { code, state, error, error_description } = req.query
    if (error) {
      const reason = error_description || error
      console.warn('[fitbit callback] oauth error:', reason)
      return redirectToSettingsError(req, res, reason)
    }
    if (!code || !state) {
      console.warn('[fitbit callback] missing callback params:', {
        hasCode: Boolean(code),
        hasState: Boolean(state),
      })
      return redirectToSettingsError(req, res, 'missing_authorization_code_or_state')
    }

    const { rows } = await pool.query(
      `DELETE FROM fitbit_oauth_state
       WHERE state=$1 AND expires_at > NOW()
       RETURNING user_id`,
      [state],
    )
    const dbUserId = rows[0]?.user_id
    if (!dbUserId) {
      console.warn('[fitbit callback] invalid or expired oauth state')
      return redirectToSettingsError(req, res, 'invalid_or_expired_state')
    }

    const data = await exchangeToken({
      grant_type:   'authorization_code',
      redirect_uri: GOOGLE_HEALTH_REDIRECT_URI,
      code:         String(code),
    })
    if (!data.refresh_token) {
      console.warn('[fitbit callback] token response missing refresh token')
      return redirectToSettingsError(req, res, 'missing_refresh_token')
    }

    await pool.query(
      `INSERT INTO fitbit_tokens
        (user_id, fitbit_user_id, access_token, refresh_token, scope, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         fitbit_user_id=EXCLUDED.fitbit_user_id,
         access_token=EXCLUDED.access_token,
         refresh_token=EXCLUDED.refresh_token,
         scope=EXCLUDED.scope,
         expires_at=EXCLUDED.expires_at,
         updated_at=NOW()`,
      [dbUserId, null, data.access_token, data.refresh_token,
       data.scope || SCOPES, addSeconds(data.expires_in)],
    )

    const successRedirectUrl = frontendUrl(req, '/settings', { connected: 'fitbit' })
    console.log('[fitbit callback] success redirect:', {
      redirectHost: new URL(successRedirectUrl).host,
    })
    res.redirect(successRedirectUrl)
  } catch (err) {
    console.error('[fitbit callback]', err.message)
    return redirectToSettingsError(req, res, err.message || 'connection_failed')
  }
})

// GET /api/fitbit/status
router.get('/status', requireAuth(), async (req, res, next) => {
  try {
    const dbUserId = await currentDbUserId(req)
    const { rows } = await pool.query(
      `SELECT fitbit_user_id, last_synced_at, last_sync_error, last_sync_error_at
       FROM fitbit_tokens WHERE user_id=$1`,
      [dbUserId],
    )
    const token = rows[0]
    res.json({
      connected:           Boolean(token),
      fitbit_user_id:      token?.fitbit_user_id      ?? null,
      last_synced_at:      token?.last_synced_at      ?? null,
      last_sync_error:     token?.last_sync_error     ?? null,
      last_sync_error_at:  token?.last_sync_error_at  ?? null,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/fitbit/sync — manual sync now
router.post('/sync', requireAuth(), async (req, res, next) => {
  try {
    const dbUserId = await currentDbUserId(req)
    const result = await syncUser(dbUserId)
    res.json(result)
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message })
    if (err.status === 502) return res.status(502).json({ error: err.message })
    next(err)
  }
})

// DELETE /api/fitbit/disconnect
router.delete('/disconnect', requireAuth(), async (req, res, next) => {
  try {
    const dbUserId = await currentDbUserId(req)
    await pool.query('DELETE FROM fitbit_tokens WHERE user_id=$1', [dbUserId])
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

export default router
