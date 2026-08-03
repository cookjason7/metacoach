import { pool } from '../db.js'
import { encryptToken, decryptToken } from '../utils/tokenEncryption.js'

/**
 * One-way (write-only) Google Calendar push for coach-assigned habits.
 *
 * Mirrors server/services/googleHealthSync.js: same token-exchange shape, same
 * 5-minute refresh window, same encrypt-on-write / decrypt-on-read discipline,
 * same "record the error on the token row and never throw into the caller's
 * happy path" behaviour.
 *
 * IMPORTANT — this module NEVER reads the client's calendar. It only creates,
 * updates and deletes the specific events it created itself (tracked by
 * coach_assigned_habits.google_calendar_event_id). There is deliberately no
 * list/get/search helper here, and none should be added: the OAuth grant the
 * client gives us is scoped to writing habit events, nothing more.
 */

const GOOGLE_TOKEN_URL        = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL     = 'https://www.googleapis.com/oauth2/v3/userinfo'
const GOOGLE_CALENDAR_API_URL = 'https://www.googleapis.com/calendar/v3'
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000

// calendar.events is the narrowest scope that still allows creating and managing
// our own events. We deliberately do NOT request the broader 'calendar' scope
// (full calendar/ACL management) or any *.readonly scope — we never read.
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
// Identity only, so we can show the client which Google account they connected
// (and catch the "authorised the wrong account" failure mode) — same rationale
// and same two scopes as the Google Health integration.
export const IDENTITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
]
export const OAUTH_SCOPES = [CALENDAR_SCOPE, ...IDENTITY_SCOPES].join(' ')

export function googleCalendarConfig() {
  const { GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET } = process.env
  // GOOGLE_CALENDAR_REDIRECT_URI is NOT required here — exchangeToken receives it
  // as a param from the caller (googleCalendar.js), which computes it per-request.
  if (!GOOGLE_CALENDAR_CLIENT_ID || !GOOGLE_CALENDAR_CLIENT_SECRET) {
    const err = new Error('Google Calendar OAuth is not configured')
    err.status = 503
    throw err
  }
  return { GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET }
}

function addSeconds(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000)
}

/** Exchange an authorization code or refresh token for an access token. */
export async function exchangeToken(params) {
  const { GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET } = googleCalendarConfig()
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: GOOGLE_CALENDAR_CLIENT_SECRET,
      ...params,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || 'Google Calendar token exchange failed')
    err.status = 502
    err.httpStatus = res.status
    // Full raw error body, for logging only — never sent to the client as-is.
    err.googleError = data
    throw err
  }
  return data
}

// Best-effort — identity isn't required for the push to work, only for
// diagnostics, so a failure here must never block connect.
export async function fetchGoogleAccountEmail(accessToken) {
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => ({}))
    return data.email ?? null
  } catch (e) {
    console.warn('[googleCalendar] could not fetch account email:', e.message)
    return null
  }
}

/**
 * Refresh the access token if it is expired or within TOKEN_REFRESH_WINDOW_MS
 * of expiring. Returns a row whose tokens are PLAINTEXT.
 *
 * @param {object} tokenRow  row from google_calendar_tokens, tokens already decrypted
 */
export async function refreshCalendarTokenIfNeeded(tokenRow) {
  if (new Date(tokenRow.expires_at).getTime() - Date.now() > TOKEN_REFRESH_WINDOW_MS) {
    return tokenRow
  }

  const data = await exchangeToken({
    grant_type:    'refresh_token',
    refresh_token: tokenRow.refresh_token,
  })

  // Google usually omits refresh_token on a refresh response — keep the old one.
  const newRefreshToken = data.refresh_token || tokenRow.refresh_token
  const { rows } = await pool.query(
    `UPDATE google_calendar_tokens
     SET access_token=$1,
         refresh_token=$2,
         expires_at=$3,
         scope=$4,
         updated_at=NOW()
     WHERE user_id=$5
     RETURNING *`,
    [
      encryptToken(data.access_token),
      encryptToken(newRefreshToken),
      addSeconds(data.expires_in),
      data.scope || tokenRow.scope,
      tokenRow.user_id,
    ],
  )
  // RETURNING gives back the encrypted columns — hand the caller plaintext so
  // downstream API calls work against a consistent (decrypted) row shape.
  const updated = rows[0]
  updated.access_token  = decryptToken(updated.access_token)
  updated.refresh_token = decryptToken(updated.refresh_token)
  return updated
}

/** Record a push failure without throwing — safe to call from any context. */
export async function recordCalendarSyncError(dbUserId, message) {
  try {
    await pool.query(
      `UPDATE google_calendar_tokens
       SET last_sync_error=$1, last_sync_error_at=NOW(), updated_at=NOW()
       WHERE user_id=$2`,
      [String(message).slice(0, 500), dbUserId],
    )
  } catch (e) {
    console.error('[calendarSync] could not record sync error:', e.message)
  }
}

async function recordCalendarSyncSuccess(dbUserId) {
  try {
    await pool.query(
      `UPDATE google_calendar_tokens
       SET last_synced_at=NOW(), updated_at=NOW(),
           last_sync_error=NULL, last_sync_error_at=NULL
       WHERE user_id=$1`,
      [dbUserId],
    )
  } catch (e) {
    console.error('[calendarSync] could not record sync success:', e.message)
  }
}

/**
 * Load + refresh a user's Calendar token.
 * @returns {object|null} plaintext-token row, or null if the user hasn't connected.
 */
async function getConnectedToken(dbUserId) {
  const { rows } = await pool.query('SELECT * FROM google_calendar_tokens WHERE user_id=$1', [dbUserId])
  if (!rows.length) return null

  rows[0].access_token  = decryptToken(rows[0].access_token)
  rows[0].refresh_token = decryptToken(rows[0].refresh_token)

  return refreshCalendarTokenIfNeeded(rows[0])
}

/** True if this user has opted in to Calendar sync. */
export async function isCalendarConnected(dbUserId) {
  const { rows } = await pool.query('SELECT 1 FROM google_calendar_tokens WHERE user_id=$1', [dbUserId])
  return rows.length > 0
}

async function calendarRequest(path, accessToken, options = {}) {
  const res = await fetch(`${GOOGLE_CALENDAR_API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })

  // 204/empty body is normal for DELETE.
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}

  if (!res.ok) {
    const err = new Error(data.error?.message || 'Google Calendar API request failed')
    err.status = 502
    err.httpStatus = res.status
    err.googleError = data.error ?? data
    throw err
  }
  return data
}

// ─── Habit → event mapping ────────────────────────────────────────────────────

// coach_assigned_habits.days_of_week is comma-separated 0-6 with Sun=0.
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/**
 * pg returns DATE columns as a JS Date in the server's local timezone. Using
 * toISOString() here would shift the day for any server west of UTC — take the
 * local components instead. (Same trap, and same fix, as the habits calendar
 * endpoint in server/routes/coachAdmin.js.)
 */
function toISODate(v) {
  if (v == null) return null
  if (typeof v === 'string') return v.slice(0, 10)
  if (v instanceof Date) {
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(v).slice(0, 10)
}

/** Add days to a YYYY-MM-DD string without tripping over local timezones. */
function addDaysISO(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/**
 * Build the RRULE for a habit, or null for a one-off event.
 *
 * frequency:
 *   'daily'         → every day
 *   'weekly'        → weekly on start_date's weekday (implied by DTSTART)
 *   'specific_days' → weekly on days_of_week
 *
 * end_date, if present, becomes UNTIL (inclusive). For an all-day (DATE-valued)
 * event, RFC 5545 requires UNTIL to be a DATE too — so YYYYMMDD, not a datetime.
 */
function buildRecurrence(habit) {
  const frequency = habit.frequency ?? 'daily'
  const endDate   = toISODate(habit.end_date)
  const until     = endDate ? `;UNTIL=${endDate.replace(/-/g, '')}` : ''

  if (frequency === 'daily')  return [`RRULE:FREQ=DAILY${until}`]
  if (frequency === 'weekly') return [`RRULE:FREQ=WEEKLY${until}`]

  if (frequency === 'specific_days') {
    // Guard the empty string explicitly: ''.split(',') is [''], and Number('')
    // is 0, which would otherwise map to SU and silently schedule a habit with
    // no days set as "every Sunday".
    const days = String(habit.days_of_week ?? '')
      .split(',')
      .map(d => d.trim())
      .filter(d => /^[0-6]$/.test(d))
      .map(d => BYDAY[Number(d)])
    if (!days.length) return null
    return [`RRULE:FREQ=WEEKLY;BYDAY=${days.join(',')}${until}`]
  }

  return null
}

/**
 * Map a coach_assigned_habits row to a Google Calendar event resource.
 *
 * Habits are day-scoped (there is no time-of-day column), so these are all-day
 * events. Google treats all-day end.date as EXCLUSIVE, hence start + 1 day.
 */
function buildEventBody(habit) {
  const startDate = toISODate(habit.start_date)

  const descriptionParts = []
  if (habit.target_value != null) {
    const target = Number(habit.target_value)
    const pretty = Number.isInteger(target) ? String(target) : String(target)
    descriptionParts.push(`Target: ${pretty}${habit.unit ? ` ${habit.unit}` : ''}`)
  }
  if (habit.notes) descriptionParts.push(habit.notes)
  descriptionParts.push('Assigned by your coach.')

  return {
    summary:     habit.habit_name,
    description: descriptionParts.join('\n\n'),
    start:       { date: startDate },
    end:         { date: addDaysISO(startDate, 1) },
    // Always send recurrence explicitly (array or null) so that editing a habit
    // from recurring to one-off actually CLEARS the rule rather than leaving the
    // old one in place — PATCH only touches the fields present in the body.
    recurrence:  buildRecurrence(habit),
    // Habits are self-directed reminders; default popup alerts would be noise.
    reminders:   { useDefault: false },
  }
}

/** Clear a stale event id after Google tells us the event no longer exists. */
async function clearHabitEventId(habitId) {
  try {
    await pool.query(
      'UPDATE coach_assigned_habits SET google_calendar_event_id = NULL WHERE id = $1',
      [habitId],
    )
  } catch (e) {
    console.error('[calendarSync] could not clear stale event id:', e.message)
  }
}

// ─── Public push API ──────────────────────────────────────────────────────────
//
// Every function below is best-effort by contract: it returns a value on success
// and null on failure, recording the failure on the token row. Callers in the
// habit routes must never let a Calendar problem break the habit operation.

/**
 * Create the Calendar event for a newly assigned habit and persist its id.
 * No-op (returns null) if the client hasn't connected Calendar.
 *
 * @param {number} dbUserId  the CLIENT's users.id (not the assigning coach's)
 * @param {object} habit     the freshly inserted coach_assigned_habits row
 * @returns {string|null} the Google event id, or null
 */
export async function pushHabitToCalendar(dbUserId, habit) {
  try {
    const token = await getConnectedToken(dbUserId)
    if (!token) return null

    const event = await calendarRequest('/calendars/primary/events', token.access_token, {
      method: 'POST',
      body: JSON.stringify(buildEventBody(habit)),
    })
    if (!event.id) throw new Error('Google Calendar did not return an event id')

    await pool.query(
      'UPDATE coach_assigned_habits SET google_calendar_event_id = $1 WHERE id = $2',
      [event.id, habit.id],
    )
    await recordCalendarSyncSuccess(dbUserId)
    console.log('[calendarSync] created event for habit', habit.id, 'user', dbUserId)
    return event.id
  } catch (err) {
    console.error('[calendarSync] create failed for habit', habit.id, 'user', dbUserId, {
      httpStatus:  err.httpStatus ?? null,
      googleError: err.googleError ?? err.message,
    })
    await recordCalendarSyncError(dbUserId, `Event create failed: ${err.message}`)
    return null
  }
}

/**
 * Update the Calendar event backing an edited habit.
 * No-op if the client isn't connected or the habit has no stored event id.
 *
 * If Google reports the event as gone (404/410) the client deleted it on their
 * side — we clear the stored id and leave it deleted rather than re-creating it
 * and fighting them.
 *
 * @returns {boolean} true if the event was updated
 */
export async function updateHabitCalendarEvent(dbUserId, habit) {
  const eventId = habit.google_calendar_event_id
  if (!eventId) return false

  try {
    const token = await getConnectedToken(dbUserId)
    if (!token) return false

    await calendarRequest(
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
      token.access_token,
      { method: 'PATCH', body: JSON.stringify(buildEventBody(habit)) },
    )
    await recordCalendarSyncSuccess(dbUserId)
    console.log('[calendarSync] updated event for habit', habit.id, 'user', dbUserId)
    return true
  } catch (err) {
    if (err.httpStatus === 404 || err.httpStatus === 410) {
      console.log('[calendarSync] event already gone for habit', habit.id, '— clearing stored id')
      await clearHabitEventId(habit.id)
      return false
    }
    console.error('[calendarSync] update failed for habit', habit.id, 'user', dbUserId, {
      httpStatus:  err.httpStatus ?? null,
      googleError: err.googleError ?? err.message,
    })
    await recordCalendarSyncError(dbUserId, `Event update failed: ${err.message}`)
    return false
  }
}

/**
 * Delete the Calendar event backing a deleted habit.
 * Idempotent — a 404/410 from Google (already deleted) counts as success.
 *
 * Takes the event id directly rather than a habit row, because the caller has
 * to read it BEFORE deleting the habit row.
 *
 * @returns {boolean} true if the event is confirmed gone
 */
export async function deleteHabitCalendarEvent(dbUserId, eventId) {
  if (!eventId) return false

  try {
    const token = await getConnectedToken(dbUserId)
    if (!token) return false

    await calendarRequest(
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
      token.access_token,
      { method: 'DELETE' },
    )
    await recordCalendarSyncSuccess(dbUserId)
    console.log('[calendarSync] deleted event', eventId, 'for user', dbUserId)
    return true
  } catch (err) {
    if (err.httpStatus === 404 || err.httpStatus === 410) {
      console.log('[calendarSync] event', eventId, 'already gone — nothing to delete')
      return true
    }
    console.error('[calendarSync] delete failed for event', eventId, 'user', dbUserId, {
      httpStatus:  err.httpStatus ?? null,
      googleError: err.googleError ?? err.message,
    })
    await recordCalendarSyncError(dbUserId, `Event delete failed: ${err.message}`)
    return false
  }
}
