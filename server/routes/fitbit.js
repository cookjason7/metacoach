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
  const GOOGLE_HEALTH_REDIRECT_URI = process.env.GOOGLE_HEALTH_REDIRECT_URI
    || `${getAppBaseUrl().replace(/\/$/, '')}/api/fitbit/callback`
  if (!GOOGLE_HEALTH_CLIENT_ID || !GOOGLE_HEALTH_CLIENT_SECRET) {
    const err = new Error('Google Health OAuth is not configured')
    err.status = 503
    throw err
  }
  return { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET, GOOGLE_HEALTH_REDIRECT_URI }
}

function frontendUrl(path, params = {}) {
  const base = getAppBaseUrl()
  const url = new URL(path, `${base}/`)
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function redirectToSettingsError(res, message) {
  return res.redirect(frontendUrl('/settings', { fitbit_error: message || 'connection_failed' }))
}

function addSeconds(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000)
}

async function currentDbUserId(req) {
  const { userId } = getAuth(req)
  return getOrCreateUser(userId)
}

// GET /api/fitbit/connect
router.get('/connect', requireAuth(), async (req, res, next) => {
  try {
    const { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_REDIRECT_URI } = googleHealthConfig()
    console.log('[fitbit connect] redirect_uri:', GOOGLE_HEALTH_REDIRECT_URI)
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
    res.redirect(url.toString())
  } catch (err) {
    next(err)
  }
})

// GET /api/fitbit/callback
router.get('/callback', async (req, res, next) => {
  try {
    const { GOOGLE_HEALTH_REDIRECT_URI } = googleHealthConfig()
    console.log('[fitbit callback] token exchange redirect_uri:', GOOGLE_HEALTH_REDIRECT_URI)
    const { code, state, error, error_description } = req.query
    if (error) return redirectToSettingsError(res, error_description || error)
    if (!code || !state) return redirectToSettingsError(res, 'missing_authorization_code_or_state')

    const { rows } = await pool.query(
      `DELETE FROM fitbit_oauth_state
       WHERE state=$1 AND expires_at > NOW()
       RETURNING user_id`,
      [state],
    )
    const dbUserId = rows[0]?.user_id
    if (!dbUserId) return redirectToSettingsError(res, 'invalid_or_expired_state')

    const data = await exchangeToken({
      grant_type:   'authorization_code',
      redirect_uri: GOOGLE_HEALTH_REDIRECT_URI,
      code:         String(code),
    })
    if (!data.refresh_token) {
      return redirectToSettingsError(res, 'missing_refresh_token')
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

    res.redirect(frontendUrl('/settings', { connected: 'fitbit' }))
  } catch (err) {
    console.error('[fitbit callback]', err.message)
    return redirectToSettingsError(res, 'connection_failed')
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
