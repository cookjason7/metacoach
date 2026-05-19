import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import crypto from 'crypto'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_HEALTH_API_URL = 'https://health.googleapis.com'
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
].join(' ')
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000

function googleHealthConfig() {
  const { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET, GOOGLE_HEALTH_REDIRECT_URI } = process.env
  if (!GOOGLE_HEALTH_CLIENT_ID || !GOOGLE_HEALTH_CLIENT_SECRET || !GOOGLE_HEALTH_REDIRECT_URI) {
    const err = new Error('Google Health OAuth is not configured')
    err.status = 503
    throw err
  }
  return { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET, GOOGLE_HEALTH_REDIRECT_URI }
}

function frontendUrl(path, params = {}) {
  const base = (process.env.APP_BASE_URL || 'https://app.lwcvip.com').replace(/\/+$/, '')
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

function parseNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

async function currentDbUserId(req) {
  const { userId } = getAuth(req)
  return getOrCreateUser(userId)
}

async function exchangeToken(params) {
  const { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET } = googleHealthConfig()
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_HEALTH_CLIENT_ID,
      client_secret: GOOGLE_HEALTH_CLIENT_SECRET,
      ...params,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || 'Google Health token exchange failed')
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
         updated_at=NOW()
     WHERE user_id=$5
     RETURNING *`,
    [
      data.access_token,
      data.refresh_token || tokenRow.refresh_token,
      addSeconds(data.expires_in),
      data.scope || tokenRow.scope,
      tokenRow.user_id,
    ],
  )
  return rows[0]
}

async function googleHealthRequest(path, accessToken, options = {}) {
  const res = await fetch(`${GOOGLE_HEALTH_API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error?.message || 'Google Health API request failed')
    err.status = 502
    throw err
  }
  return data
}

function todayCivilRange() {
  const today = new Date().toISOString().slice(0, 10)
  const tomorrowDate = new Date(`${today}T00:00:00Z`)
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1)
  return { today, tomorrow: tomorrowDate.toISOString().slice(0, 10) }
}

function civilDateTime(date) {
  const [year, month, day] = date.split('-').map(Number)
  return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0 } }
}

async function fetchTodaySteps(accessToken) {
  const { today, tomorrow } = todayCivilRange()
  const data = await googleHealthRequest(
    '/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        range: {
          start: civilDateTime(today),
          end: civilDateTime(tomorrow),
        },
        windowSizeDays: 1,
        dataSourceFamily: 'users/me/dataSourceFamilies/all-sources',
      }),
    },
  )
  return parseNumber(data.rollupDataPoints?.[0]?.steps?.countSum)
}

async function fetchTodaySleepMinutes(accessToken) {
  const { today, tomorrow } = todayCivilRange()
  const filter = `sleep.interval.civil_end_time >= "${today}" AND sleep.interval.civil_end_time < "${tomorrow}"`
  const params = new URLSearchParams({ filter, pageSize: '25' })
  const data = await googleHealthRequest(`/v4/users/me/dataTypes/sleep/dataPoints?${params}`, accessToken)
  const minutes = (data.dataPoints ?? []).reduce((total, point) => {
    const value = parseNumber(point.sleep?.summary?.minutesAsleep)
    return total + (value ?? 0)
  }, 0)
  return minutes || null
}

// GET /api/fitbit/connect
router.get('/connect', requireAuth(), async (req, res, next) => {
  try {
    const { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_REDIRECT_URI } = googleHealthConfig()
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
      grant_type: 'authorization_code',
      redirect_uri: GOOGLE_HEALTH_REDIRECT_URI,
      code: String(code),
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
      [dbUserId, null, data.access_token, data.refresh_token, data.scope || SCOPES, addSeconds(data.expires_in)],
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
    if (!rows.length) return res.status(404).json({ error: 'Fitbit is not connected.' })

    let token
    try {
      token = await refreshTokenIfNeeded(rows[0])
    } catch (refreshErr) {
      console.error('[fitbit sync] token refresh failed:', refreshErr.message)
      return res.status(502).json({
        error: 'Google Health authentication failed. Please disconnect and reconnect Google Health.',
      })
    }

    let steps, sleepMinutes
    try {
      ;[steps, sleepMinutes] = await Promise.all([
        fetchTodaySteps(token.access_token),
        fetchTodaySleepMinutes(token.access_token),
      ])
    } catch (apiErr) {
      console.error('[fitbit sync] Google Health API error:', apiErr.message)
      return res.status(502).json({ error: `Google Health sync failed: ${apiErr.message}` })
    }

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
      [dbUserId, steps, sleepMinutes],
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
