import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import crypto from 'crypto'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

const FITBIT_AUTHORIZE_URL = 'https://www.fitbit.com/oauth2/authorize'
const FITBIT_TOKEN_URL = 'https://api.fitbit.com/oauth2/token'
const FITBIT_API_URL = 'https://api.fitbit.com'
const SCOPES = 'activity sleep'
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000

function fitbitConfig() {
  const { FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET, FITBIT_REDIRECT_URI } = process.env
  if (!FITBIT_CLIENT_ID || !FITBIT_CLIENT_SECRET || !FITBIT_REDIRECT_URI) {
    const err = new Error('Fitbit OAuth is not configured')
    err.status = 503
    throw err
  }
  return { FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET, FITBIT_REDIRECT_URI }
}

function basicAuth(clientId, clientSecret) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

function addSeconds(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000)
}

async function currentDbUserId(req) {
  const { userId } = getAuth(req)
  return getOrCreateUser(userId)
}

async function exchangeToken(params) {
  const { FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET } = fitbitConfig()
  const res = await fetch(FITBIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.errors?.[0]?.message || data.error_description || 'Fitbit token exchange failed')
    err.status = 502
    throw err
  }
  return data
}

async function refreshTokenIfNeeded(tokenRow) {
  if (new Date(tokenRow.expires_at).getTime() - Date.now() > TOKEN_REFRESH_WINDOW_MS) {
    return tokenRow
  }

  const data = await exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: tokenRow.refresh_token,
  })

  const { rows } = await pool.query(
    `UPDATE fitbit_tokens
     SET access_token=$1,
         refresh_token=$2,
         expires_at=$3,
         scope=$4,
         fitbit_user_id=COALESCE($5, fitbit_user_id),
         updated_at=NOW()
     WHERE user_id=$6
     RETURNING *`,
    [
      data.access_token,
      data.refresh_token || tokenRow.refresh_token,
      addSeconds(data.expires_in),
      data.scope || tokenRow.scope,
      data.user_id || null,
      tokenRow.user_id,
    ],
  )
  return rows[0]
}

async function fitbitGet(path, accessToken) {
  const res = await fetch(`${FITBIT_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.errors?.[0]?.message || 'Fitbit API request failed')
    err.status = 502
    throw err
  }
  return data
}

function sleepMinutesFromResponse(data) {
  const summary = data?.summary
  if (!summary) return null
  const minutes = summary.totalMinutesAsleep ?? summary.totalSleepRecordsMinutes
  return Number.isFinite(Number(minutes)) ? Number(minutes) : null
}

// GET /api/fitbit/connect
router.get('/connect', requireAuth(), async (req, res, next) => {
  try {
    const { FITBIT_CLIENT_ID, FITBIT_REDIRECT_URI } = fitbitConfig()
    const dbUserId = await currentDbUserId(req)
    const state = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

    await pool.query('DELETE FROM fitbit_oauth_state WHERE user_id=$1 OR expires_at < NOW()', [dbUserId])
    await pool.query(
      'INSERT INTO fitbit_oauth_state (state, user_id, expires_at) VALUES ($1, $2, $3)',
      [state, dbUserId, expiresAt],
    )

    const url = new URL(FITBIT_AUTHORIZE_URL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', FITBIT_CLIENT_ID)
    url.searchParams.set('redirect_uri', FITBIT_REDIRECT_URI)
    url.searchParams.set('scope', SCOPES)
    url.searchParams.set('state', state)
    res.redirect(url.toString())
  } catch (err) {
    next(err)
  }
})

// GET /api/fitbit/callback
router.get('/callback', async (req, res, next) => {
  try {
    const { FITBIT_REDIRECT_URI } = fitbitConfig()
    const { code, state } = req.query
    if (!code || !state) return res.status(400).json({ error: 'Missing Fitbit authorization code or state' })

    const { rows } = await pool.query(
      `DELETE FROM fitbit_oauth_state
       WHERE state=$1 AND expires_at > NOW()
       RETURNING user_id`,
      [state],
    )
    const dbUserId = rows[0]?.user_id
    if (!dbUserId) return res.status(400).json({ error: 'Invalid or expired Fitbit state' })

    const data = await exchangeToken({
      client_id: process.env.FITBIT_CLIENT_ID,
      grant_type: 'authorization_code',
      redirect_uri: FITBIT_REDIRECT_URI,
      code: String(code),
    })

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
      [dbUserId, data.user_id || null, data.access_token, data.refresh_token, data.scope || SCOPES, addSeconds(data.expires_in)],
    )

    res.redirect('/settings?connected=fitbit')
  } catch (err) {
    next(err)
  }
})

// GET /api/fitbit/status
router.get('/status', requireAuth(), async (req, res, next) => {
  try {
    const dbUserId = await currentDbUserId(req)
    const { rows } = await pool.query(
      'SELECT fitbit_user_id, last_synced_at FROM fitbit_tokens WHERE user_id=$1',
      [dbUserId],
    )
    const token = rows[0]
    res.json({
      connected: Boolean(token),
      fitbit_user_id: token?.fitbit_user_id ?? null,
      last_synced_at: token?.last_synced_at ?? null,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/fitbit/sync
router.post('/sync', requireAuth(), async (req, res, next) => {
  try {
    const dbUserId = await currentDbUserId(req)
    const { rows } = await pool.query('SELECT * FROM fitbit_tokens WHERE user_id=$1', [dbUserId])
    if (!rows.length) return res.status(404).json({ error: 'Fitbit is not connected' })

    const token = await refreshTokenIfNeeded(rows[0])
    const [activity, sleep] = await Promise.all([
      fitbitGet('/1/user/-/activities/date/today.json', token.access_token),
      fitbitGet('/1.2/user/-/sleep/date/today.json', token.access_token),
    ])

    const steps = Number(activity?.summary?.steps)
    const safeSteps = Number.isFinite(steps) ? steps : null
    const sleepMinutes = sleepMinutesFromResponse(sleep)

    const { rows: logRows } = await pool.query(
      `INSERT INTO daily_logs (user_id, logged_date, steps, sleep_minutes, steps_source)
       VALUES ($1, CURRENT_DATE, $2, $3, CASE WHEN $2::integer IS NULL THEN 'manual' ELSE 'fitbit' END)
       ON CONFLICT (user_id, logged_date) DO UPDATE SET
         steps = CASE
           WHEN daily_logs.steps IS NULL OR daily_logs.steps_source = 'fitbit'
             THEN COALESCE(EXCLUDED.steps, daily_logs.steps)
           ELSE daily_logs.steps
         END,
         steps_source = CASE
           WHEN EXCLUDED.steps IS NOT NULL AND (daily_logs.steps IS NULL OR daily_logs.steps_source = 'fitbit')
             THEN 'fitbit'
           ELSE daily_logs.steps_source
         END,
         sleep_minutes = COALESCE(EXCLUDED.sleep_minutes, daily_logs.sleep_minutes)
       RETURNING steps, sleep_minutes, steps_source`,
      [dbUserId, safeSteps, sleepMinutes],
    )

    const { rows: syncRows } = await pool.query(
      `UPDATE fitbit_tokens
       SET last_synced_at=NOW(), updated_at=NOW()
       WHERE user_id=$1
       RETURNING last_synced_at`,
      [dbUserId],
    )

    res.json({
      steps: logRows[0]?.steps ?? null,
      sleep_minutes: logRows[0]?.sleep_minutes ?? null,
      steps_source: logRows[0]?.steps_source ?? null,
      synced_at: syncRows[0]?.last_synced_at ?? new Date().toISOString(),
    })
  } catch (err) {
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
