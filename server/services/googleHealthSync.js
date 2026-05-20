import { pool } from '../db.js'

const GOOGLE_TOKEN_URL       = 'https://oauth2.googleapis.com/token'
const GOOGLE_HEALTH_API_URL  = 'https://health.googleapis.com'
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

function addSeconds(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000)
}

function parseNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Export so fitbit.js callback can use it for the authorization_code grant
export async function exchangeToken(params) {
  const { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET } = googleHealthConfig()
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GOOGLE_HEALTH_CLIENT_ID,
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
    grant_type:    'refresh_token',
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
          end:   civilDateTime(tomorrow),
        },
        windowSizeDays:   1,
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

// Record a sync error without throwing — safe to call from any context
async function recordSyncError(dbUserId, message) {
  try {
    await pool.query(
      `UPDATE fitbit_tokens
       SET last_sync_error=$1, last_sync_error_at=NOW(), updated_at=NOW()
       WHERE user_id=$2`,
      [String(message).slice(0, 500), dbUserId],
    )
  } catch (e) {
    console.error('[healthSync] could not record sync error:', e.message)
  }
}

/**
 * Sync today's steps and sleep for a connected user.
 *
 * Source-protection rules:
 *   • steps:         fitbit may fill NULL or overwrite a previous fitbit value.
 *                    Manual steps (steps_source='manual') are never overwritten.
 *   • sleep_minutes: fitbit may fill NULL or overwrite a previous fitbit value.
 *                    Manual sleep (sleep_source='manual') is never overwritten.
 *
 * On success clears last_sync_error.
 * Throws (with .status) on token/API failure — error is also persisted to DB.
 *
 * @param {number} dbUserId  Internal DB users.id (NOT Clerk user id)
 * @returns {{ steps, sleep_minutes, steps_source, sleep_source, synced_at }}
 */
export async function syncUser(dbUserId) {
  const { rows } = await pool.query('SELECT * FROM fitbit_tokens WHERE user_id=$1', [dbUserId])
  if (!rows.length) {
    const err = new Error('Google Health is not connected.')
    err.status = 404
    throw err
  }

  let token
  try {
    token = await refreshTokenIfNeeded(rows[0])
  } catch (refreshErr) {
    await recordSyncError(dbUserId, `Token refresh failed: ${refreshErr.message}`)
    const err = new Error('Google Health authentication failed. Please disconnect and reconnect Google Health.')
    err.status = 502
    throw err
  }

  let steps, sleepMinutes
  try {
    ;[steps, sleepMinutes] = await Promise.all([
      fetchTodaySteps(token.access_token),
      fetchTodaySleepMinutes(token.access_token),
    ])
  } catch (apiErr) {
    await recordSyncError(dbUserId, `API error: ${apiErr.message}`)
    const err = new Error(`Google Health sync failed: ${apiErr.message}`)
    err.status = 502
    throw err
  }

  const { rows: logRows } = await pool.query(
    `INSERT INTO daily_logs (user_id, logged_date, steps, sleep_minutes, steps_source, sleep_source)
     VALUES ($1, CURRENT_DATE, $2, $3,
             CASE WHEN $2::integer IS NULL THEN 'manual' ELSE 'fitbit' END,
             CASE WHEN $3::integer IS NULL THEN 'manual' ELSE 'fitbit' END)
     ON CONFLICT (user_id, logged_date) DO UPDATE SET
       steps = CASE
         WHEN daily_logs.steps IS NULL OR daily_logs.steps_source = 'fitbit'
           THEN COALESCE(EXCLUDED.steps, daily_logs.steps)
         ELSE daily_logs.steps
       END,
       steps_source = CASE
         WHEN EXCLUDED.steps IS NOT NULL
              AND (daily_logs.steps IS NULL OR daily_logs.steps_source = 'fitbit')
           THEN 'fitbit'
         ELSE daily_logs.steps_source
       END,
       sleep_minutes = CASE
         WHEN daily_logs.sleep_minutes IS NULL OR daily_logs.sleep_source = 'fitbit'
           THEN COALESCE(EXCLUDED.sleep_minutes, daily_logs.sleep_minutes)
         ELSE daily_logs.sleep_minutes
       END,
       sleep_source = CASE
         WHEN EXCLUDED.sleep_minutes IS NOT NULL
              AND (daily_logs.sleep_minutes IS NULL OR daily_logs.sleep_source = 'fitbit')
           THEN 'fitbit'
         ELSE daily_logs.sleep_source
       END
     RETURNING steps, sleep_minutes, steps_source, sleep_source`,
    [dbUserId, steps, sleepMinutes],
  )

  const { rows: syncRows } = await pool.query(
    `UPDATE fitbit_tokens
     SET last_synced_at=NOW(), updated_at=NOW(),
         last_sync_error=NULL, last_sync_error_at=NULL
     WHERE user_id=$1
     RETURNING last_synced_at`,
    [dbUserId],
  )

  return {
    steps:        logRows[0]?.steps        ?? null,
    sleep_minutes: logRows[0]?.sleep_minutes ?? null,
    steps_source:  logRows[0]?.steps_source  ?? null,
    sleep_source:  logRows[0]?.sleep_source  ?? null,
    synced_at:     syncRows[0]?.last_synced_at ?? new Date().toISOString(),
  }
}
