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

  // 204/empty body is normal for DELETE, and an upstream proxy can return HTML
  // rather than JSON on a bad day — neither should surface as a parse error
  // instead of the actual failure.
  const text = await res.text()
  let data = {}
  if (text) {
    try { data = JSON.parse(text) } catch { data = {} }
  }

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

// Habits carry no time-of-day, so each event needs a default slot. They stack
// from 5:00 AM in 15-minute steps, giving a client's habits a tidy morning
// column instead of a pile of events all landing on the same time.
// Step and duration are kept equal so consecutive slots butt up against each
// other with no gap and no overlap.
const EVENT_TIME_ZONE       = 'America/New_York'
const SLOT_BASE_MINUTES     = 5 * 60   // 05:00
const SLOT_STEP_MINUTES     = 15
const SLOT_DURATION_MINUTES = 15
const MINUTES_PER_DAY       = 24 * 60

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

/** "HH:MM:SS" from minutes-since-midnight. */
function hhmmss(totalMinutes) {
  const h = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
  const m = String(totalMinutes % 60).padStart(2, '0')
  return `${h}:${m}:00`
}

/**
 * Wall-clock window for a slot: slot 0 is 05:00-05:15, slot 1 is 05:15-05:30,
 * and so on.
 *
 * The modulo keeps a pathological client (~76+ synced habits) from generating
 * an invalid "25:10:00" that Google would reject — those slots wrap around the
 * clock instead. endsNextDay flags the one slot whose window straddles midnight,
 * since its end date has to roll forward a day.
 */
function slotWindow(slotIndex) {
  const startTotal = (SLOT_BASE_MINUTES + slotIndex * SLOT_STEP_MINUTES) % MINUTES_PER_DAY
  const rawEnd     = startTotal + SLOT_DURATION_MINUTES
  return {
    startTime:   hhmmss(startTotal),
    endTime:     hhmmss(rawEnd % MINUTES_PER_DAY),
    endsNextDay: rawEnd >= MINUTES_PER_DAY,
  }
}

/**
 * Offset of `timeZone` from UTC in ms at instant `t` (positive east of UTC).
 * Intl rather than a date library — Node ships full ICU, and this is the only
 * timezone arithmetic the module needs.
 */
function zoneOffsetMs(t, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t))
  const get = type => Number(parts.find(p => p.type === type).value)
  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = get('hour') % 24
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - t
}

/**
 * The UTC instant at which a given wall-clock time occurs in `timeZone`.
 * Iterates because the offset to apply depends on the instant being solved for
 * — the DST-boundary case. Two passes converge for every real-world zone.
 */
function zonedWallTimeToUtcMs(isoDate, timeOfDay, timeZone) {
  const [y, mo, d] = isoDate.split('-').map(Number)
  const [h, mi, s] = timeOfDay.split(':').map(Number)
  const target     = Date.UTC(y, mo - 1, d, h, mi, s)
  let t = target
  for (let i = 0; i < 2; i++) t = target - zoneOffsetMs(t, timeZone)
  return t
}

/** RFC 5545 UTC form: YYYYMMDDTHHMMSSZ */
function toRruleUtcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Build the RRULE for a habit, or null for a one-off event.
 *
 * frequency:
 *   'daily'         → every day
 *   'weekly'        → weekly on start_date's weekday (implied by DTSTART)
 *   'specific_days' → weekly on days_of_week
 *
 * end_date, if present, becomes UNTIL (inclusive). RFC 5545 §3.3.10 requires
 * UNTIL to match DTSTART's value type: now that DTSTART is a date-time with a
 * timezone reference, UNTIL MUST be a UTC date-time. The bare YYYYMMDD that was
 * correct while these were all-day events is invalid against a timed DTSTART —
 * this is the one part of the recurrence rule the all-day → timed switch does
 * change. Anchoring to the end of end_date in EVENT_TIME_ZONE keeps the final
 * day's occurrence included no matter which slot the habit landed in.
 */
function buildRecurrence(habit) {
  const frequency = habit.frequency ?? 'daily'
  const endDate   = toISODate(habit.end_date)
  const until     = endDate
    ? `;UNTIL=${toRruleUtcStamp(zonedWallTimeToUtcMs(endDate, '23:59:59', EVENT_TIME_ZONE))}`
    : ''

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
 * Timed events on a per-client 15-minute slot ladder (see slotWindow). Unlike
 * the all-day form these replaced, end.dateTime is INCLUSIVE — it's the actual
 * finish time, so no +1 day fudge.
 */
function buildEventBody(habit, slotIndex = 0) {
  const startDate = toISODate(habit.start_date)
  const { startTime, endTime, endsNextDay } = slotWindow(slotIndex)
  const endDate   = endsNextDay ? addDaysISO(startDate, 1) : startDate

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
    start:       { dateTime: `${startDate}T${startTime}`, timeZone: EVENT_TIME_ZONE },
    end:         { dateTime: `${endDate}T${endTime}`,     timeZone: EVENT_TIME_ZONE },
    // Always send recurrence explicitly (array or null) so that editing a habit
    // from recurring to one-off actually CLEARS the rule rather than leaving the
    // old one in place — PATCH only touches the fields present in the body.
    recurrence:  buildRecurrence(habit),
    // Habits are self-directed reminders; default popup alerts would be noise.
    reminders:   { useDefault: false },
  }
}

/**
 * Which slot on the ladder this habit occupies: the number of the client's
 * already-synced habits that were created before it.
 *
 * Derived rather than stored, and deliberately anchored to creation order so
 * the same habit resolves to the same slot every time. For a brand-new habit
 * (always the newest row) it equals the client's count of synced habits, which
 * is the next free slot. For an existing habit it returns what it resolved to
 * at creation, so editing one habit never shuffles it onto a slot a later habit
 * already took.
 *
 * Known wrinkle: deleting an early habit frees its slot, so habits created
 * after it shift down by one the next time they're edited. That only ever
 * closes a gap the deletion opened, so it's left alone.
 *
 * The habit's own created_at is read back out of the table rather than passed
 * in from the caller's row object: timestamptz keeps microseconds, a JS Date
 * only milliseconds, so a round-tripped value compares as fractionally EARLIER
 * than the stored one and the comparison matches nothing — every habit would
 * silently land on slot 0 (5:00 AM), which is the pile-up this ladder exists to
 * avoid. Keeping both sides of the comparison in Postgres sidesteps that.
 */
async function resolveSlotIndex(dbUserId, habit) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS slot
       FROM coach_assigned_habits h
       JOIN coach_assigned_habits self ON self.id = $2
      WHERE h.user_id = $1
        AND h.google_calendar_event_id IS NOT NULL
        AND (h.created_at, h.id) < (self.created_at, self.id)`,
    [dbUserId, habit.id],
  )
  return rows[0]?.slot ?? 0
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

    const slotIndex = await resolveSlotIndex(dbUserId, habit)
    const event = await calendarRequest('/calendars/primary/events', token.access_token, {
      method: 'POST',
      body: JSON.stringify(buildEventBody(habit, slotIndex)),
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

    // Resolves to the slot this habit got at creation, not the next free one —
    // an edit must not move the event onto a later habit's slot.
    const slotIndex = await resolveSlotIndex(dbUserId, habit)
    await calendarRequest(
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
      token.access_token,
      { method: 'PATCH', body: JSON.stringify(buildEventBody(habit, slotIndex)) },
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
