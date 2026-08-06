/**
 * Shared habit recurrence rules.
 *
 * `coach_assigned_habits` stores a recurrence RULE (frequency + start_date +
 * optional days_of_week), not per-occurrence rows — the calendar endpoints
 * expand it into days at request time. That expansion used to be copy-pasted
 * into every caller, which is how the rules drifted; this module is now the
 * single source of truth for "does this habit occur on this date?".
 *
 * Callers remain responsible for the date WINDOW (start_date/end_date and the
 * requested range). This module answers only the recurrence-pattern question.
 *
 * NOTE: client/src/pages/admin/ClientProfile.jsx#habitActiveOnDay mirrors these
 * rules in the browser for the coach's month-grid preview (it can't import from
 * the server bundle). Any change here must be mirrored there.
 */

/** Every frequency the app understands. Also used for request validation. */
export const VALID_HABIT_FREQ = ['daily', 'weekly', 'specific_days', 'biweekly', 'monthly']

/**
 * pg returns DATE columns as JS Date objects in the server's local timezone.
 * Build a local-midnight Date so weekday/day-of-month comparisons never shift
 * across a timezone boundary. Returns null when the value can't be parsed.
 */
function toLocalMidnight(v) {
  if (v == null) return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return new Date(v.getFullYear(), v.getMonth(), v.getDate())
  }
  const iso = String(v).slice(0, 10)
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

/** Whole days between two local-midnight dates, DST-safe (compares UTC noon). */
function daysBetween(a, b) {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((ub - ua) / 86_400_000)
}

/** Last calendar day (28-31) of the month containing `date`. */
function lastDayOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

/**
 * Does `habit` occur on `date`?
 *
 *   daily         — every day
 *   weekly        — same weekday as start_date
 *   specific_days — weekdays listed in days_of_week (CSV of 0-6, Sun=0).
 *                   An absent/unparseable list falls through to daily, which is
 *                   the long-standing behaviour of the callers this replaced.
 *   biweekly      — same weekday as start_date, on alternating weeks
 *   monthly       — same day-of-month as start_date, clamped to the last day of
 *                   short months (start on the 31st → Feb 28/29, Apr 30)
 *
 * An unrecognized frequency warns and behaves as daily rather than throwing:
 * a bad value must never make a client's habits silently vanish from their
 * calendar.
 *
 * @param {{ id?: number, frequency?: string, start_date: string|Date, days_of_week?: string|null }} habit
 * @param {Date} date
 * @returns {boolean}
 */
export function habitOccursOn(habit, date) {
  const frequency = habit.frequency ?? 'daily'
  const start = toLocalMidnight(habit.start_date)
  const day   = toLocalMidnight(date)

  if (!day) return false
  // Without a usable anchor none of the anchored rules can be evaluated; show
  // the habit rather than hiding it.
  if (!start) {
    console.warn('[habitSchedule] habit', habit.id, 'has unparseable start_date', habit.start_date, '— treating as daily')
    return true
  }

  switch (frequency) {
    case 'daily':
      return true

    case 'weekly':
      return day.getDay() === start.getDay()

    case 'specific_days': {
      const allowed = habit.days_of_week
        ? String(habit.days_of_week).split(',').map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n))
        : null
      if (!allowed || !allowed.length) return true
      return allowed.includes(day.getDay())
    }

    case 'biweekly': {
      if (day.getDay() !== start.getDay()) return false
      const weeks = Math.floor(daysBetween(start, day) / 7)
      return weeks % 2 === 0
    }

    case 'monthly': {
      // Clamp so a habit anchored to the 29th-31st still lands once in every
      // month, on that month's final day.
      const target = Math.min(start.getDate(), lastDayOfMonth(day))
      return day.getDate() === target
    }

    default:
      console.warn('[habitSchedule] habit', habit.id, 'has unrecognized frequency', frequency, '— treating as daily')
      return true
  }
}

export default habitOccursOn
