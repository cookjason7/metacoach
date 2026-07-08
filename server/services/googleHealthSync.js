import { pool } from '../db.js'

const GOOGLE_TOKEN_URL       = 'https://oauth2.googleapis.com/token'
const GOOGLE_HEALTH_API_URL  = 'https://health.googleapis.com'
const GOOGLE_USERINFO_URL    = 'https://www.googleapis.com/oauth2/v3/userinfo'
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000

// Scopes the sync actually needs, plus basic identity so we can tell which
// Google account a token belongs to (surfaced in logs and the status UI, and
// used to catch the "authorized with the wrong account" failure mode).
export const REQUIRED_HEALTH_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
]
export const IDENTITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
]
export const OAUTH_SCOPES = [...REQUIRED_HEALTH_SCOPES, ...IDENTITY_SCOPES].join(' ')

function missingScopes(grantedScope) {
  const granted = new Set((grantedScope || '').split(' ').filter(Boolean))
  return REQUIRED_HEALTH_SCOPES.filter(s => !granted.has(s))
}

// Best-effort — identity isn't required for sync to function, only for
// diagnostics, so a failure here must never block connect/sync.
export async function fetchGoogleAccountEmail(accessToken) {
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => ({}))
    return data.email ?? null
  } catch (e) {
    console.warn('[googleHealth] could not fetch account email:', e.message)
    return null
  }
}

// Maps a raw Google API failure to a clear, actionable message for the user.
// Never pass apiErr.message / apiErr.googleError straight through — Google's
// wording is written for developers, not clients ("The account is not linked
// to Google Health" reads like an app bug even though it usually just means
// the connected Google account has no Fitbit/Health Connect data source).
function translateGoogleHealthError(apiErr, googleEmail) {
  const raw = String(apiErr.googleError?.message || apiErr.message || '').toLowerCase()
  const account = googleEmail ? ` (${googleEmail})` : ''

  if (apiErr.httpStatus === 401 || /invalid_grant|invalid credentials|token has been expired or revoked/.test(raw)) {
    return 'Your Google Health connection has expired. Please reconnect Google Health.'
  }
  if (/insufficient|permission_denied|forbidden/.test(raw)) {
    return 'Google Health sync needs additional permissions. Please reconnect and allow access to steps and sleep data.'
  }
  if (/not linked|no data source|not found/.test(raw)) {
    return `No Fitbit or Health Connect data was found for the connected Google account${account}. ` +
      'Make sure Fitbit is syncing into Health Connect on that same account, or reconnect using the correct one.'
  }
  return 'We couldn\'t sync with Google Health right now. Please try again, or reconnect Google Health if this keeps happening.'
}

function googleHealthConfig() {
  const { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET } = process.env
  // GOOGLE_HEALTH_REDIRECT_URI is NOT required here — exchangeToken receives it
  // as a param from the caller (fitbit.js), which computes it via getAppBaseUrl().
  if (!GOOGLE_HEALTH_CLIENT_ID || !GOOGLE_HEALTH_CLIENT_SECRET) {
    const err = new Error('Google Health OAuth is not configured')
    err.status = 503
    throw err
  }
  return { GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET }
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
    err.httpStatus = res.status
    // Full raw error body, for logging only — never sent to the client as-is.
    err.googleError = data
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
    err.httpStatus = res.status
    // Full raw error body, for logging only — never sent to the client as-is.
    err.googleError = data.error ?? data
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

  console.log('[healthSync] starting sync', {
    user_id:        dbUserId,
    google_email:   rows[0].google_email ?? '(unknown — connected before account-email capture was added; reconnect to capture it)',
    granted_scope:  rows[0].scope ?? '(none recorded)',
    missing_scopes: missingScopes(rows[0].scope),
  })

  let token
  try {
    token = await refreshTokenIfNeeded(rows[0])
  } catch (refreshErr) {
    console.error('[healthSync] token refresh failed for user', dbUserId, ':', refreshErr.googleError ?? refreshErr.message)
    await recordSyncError(dbUserId, `Token refresh failed: ${refreshErr.message}`)
    const err = new Error('Your Google Health connection has expired. Please reconnect Google Health.')
    err.status = 401
    throw err
  }

  const missing = missingScopes(token.scope)
  if (missing.length) {
    console.warn('[healthSync] user', dbUserId, 'is missing required scopes:', missing)
    await recordSyncError(dbUserId, `Missing scopes: ${missing.join(', ')}`)
    const err = new Error('Google Health sync needs additional permissions. Please reconnect and allow access to steps and sleep data.')
    err.status = 403
    throw err
  }

  let steps, sleepMinutes
  try {
    ;[steps, sleepMinutes] = await Promise.all([
      fetchTodaySteps(token.access_token),
      fetchTodaySleepMinutes(token.access_token),
    ])
  } catch (apiErr) {
    // Full raw Google error, for our logs only.
    console.error('[healthSync] Google API error for user', dbUserId, {
      google_email: rows[0].google_email ?? null,
      httpStatus:   apiErr.httpStatus ?? null,
      googleError:  apiErr.googleError ?? apiErr.message,
    })
    await recordSyncError(dbUserId, `API error: ${apiErr.message}`)
    const err = new Error(translateGoogleHealthError(apiErr, rows[0].google_email))
    err.status = 502
    throw err
  }

  // COALESCE(source, 'manual') ensures any NULL source is treated as 'manual'
  // (safe / do-not-overwrite). Sync may only write when:
  //   • the existing value is NULL (nothing there yet), OR
  //   • source is already a sync-originated value ('fitbit', 'google_health', 'synced')
  const { rows: logRows } = await pool.query(
    `INSERT INTO daily_logs (user_id, logged_date, steps, sleep_minutes, steps_source, sleep_source)
     VALUES ($1, CURRENT_DATE, $2, $3,
             CASE WHEN $2::integer IS NULL THEN 'manual' ELSE 'fitbit' END,
             CASE WHEN $3::integer IS NULL THEN 'manual' ELSE 'fitbit' END)
     ON CONFLICT (user_id, logged_date) DO UPDATE SET
       steps = CASE
         WHEN daily_logs.steps IS NULL
              OR COALESCE(daily_logs.steps_source, 'manual') IN ('fitbit', 'google_health', 'synced')
           THEN COALESCE(EXCLUDED.steps, daily_logs.steps)
         ELSE daily_logs.steps
       END,
       steps_source = CASE
         WHEN EXCLUDED.steps IS NOT NULL
              AND (daily_logs.steps IS NULL
                   OR COALESCE(daily_logs.steps_source, 'manual') IN ('fitbit', 'google_health', 'synced'))
           THEN 'fitbit'
         ELSE COALESCE(daily_logs.steps_source, 'manual')
       END,
       sleep_minutes = CASE
         WHEN daily_logs.sleep_minutes IS NULL
              OR COALESCE(daily_logs.sleep_source, 'manual') IN ('fitbit', 'google_health', 'synced')
           THEN COALESCE(EXCLUDED.sleep_minutes, daily_logs.sleep_minutes)
         ELSE daily_logs.sleep_minutes
       END,
       sleep_source = CASE
         WHEN EXCLUDED.sleep_minutes IS NOT NULL
              AND (daily_logs.sleep_minutes IS NULL
                   OR COALESCE(daily_logs.sleep_source, 'manual') IN ('fitbit', 'google_health', 'synced'))
           THEN 'fitbit'
         ELSE COALESCE(daily_logs.sleep_source, 'manual')
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
