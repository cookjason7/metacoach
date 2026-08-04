import { Router } from 'express'
import { requireAuth, getAuth } from '@clerk/express'
import { pool, getOrCreateUser } from '../db.js'

const router = Router()

// Helper: convert a pg DATE value (a JS Date in the server's local TZ) or a string
// into a YYYY-MM-DD string. Uses local components so the day is never shifted by a
// timezone offset. Same approach as clientHabits.js.
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Does this assignment's recurrence rule put an occurrence on dateISO?
// Pure rule evaluation — workout_schedule_overrides are applied on top of this.
function ruleMatches(s, dateISO) {
  const d = new Date(`${dateISO}T00:00:00`)
  const sStartISO = toISODate(s.start_date)
  const sEndISO   = toISODate(s.end_date)
  const sStart = new Date(`${sStartISO}T00:00:00`)
  if (d < sStart) return false
  if (sEndISO && d > new Date(`${sEndISO}T00:00:00`)) return false
  if (s.frequency === 'specific_days') {
    const allowed = s.days_of_week
      ? s.days_of_week.split(',').map(x => parseInt(x, 10)).filter(n => !Number.isNaN(n))
      : null
    if (allowed && !allowed.includes(d.getDay())) return false
  }
  if (s.frequency === 'weekly' && d.getDay() !== sStart.getDay()) return false
  return true
}

// Index override rows two ways:
//   suppressed[`${assignment_id}|${original_date}`] → true  (moved away from here)
//   injected[new_date] → [{ assignment_id, original_date }] (moved to here)
// original_date is always the *rule* date, so re-moving an already-moved occurrence
// updates the same row rather than stacking exceptions.
function indexOverrides(overrides) {
  const suppressed = new Set()
  const injected = {}
  for (const o of overrides ?? []) {
    const orig = toISODate(o.original_date)
    const next = toISODate(o.new_date)
    suppressed.add(`${o.assignment_id}|${orig}`)
    if (!injected[next]) injected[next] = []
    injected[next].push({ assignment_id: o.assignment_id, original_date: orig })
  }
  return { suppressed, injected }
}

// Every occurrence that actually lands on dateISO for this client, after overrides.
// Returns [{ assignment, original_date }] where original_date is the rule date the
// occurrence "belongs" to — that is what a reschedule row must be keyed by.
function occurrencesOn(schedules, overrides, dateISO) {
  const { suppressed, injected } = indexOverrides(overrides)
  const out = []
  for (const s of schedules) {
    if (ruleMatches(s, dateISO) && !suppressed.has(`${s.id}|${dateISO}`)) {
      out.push({ assignment: s, original_date: dateISO })
    }
    for (const inj of injected[dateISO] ?? []) {
      if (inj.assignment_id === s.id) out.push({ assignment: s, original_date: inj.original_date })
    }
  }
  return out
}

// Expand coach_assigned_workouts rows into per-day instances for [start, end].
// Respects frequency ('daily' | 'weekly' | 'specific_days'), start/end dates, and
// days_of_week (CSV of 0-6, Sun=0). Mirrors the habit expandCalendar logic.
// exByKey maps `${workout_id}|${day_label}` → the ordered workout_exercises rows,
// so each expanded instance carries the exercises the client logs against.
// overrides (workout_schedule_overrides) are single-occurrence exceptions: the
// occurrence is suppressed on original_date and injected on new_date instead. The
// recurrence rule itself is never rewritten.
function expandCalendar(schedules, logs, exByKey, startDate, endDate, overrides = []) {
  const logMap = {}  // { assignment_id: { date: log } }
  for (const l of logs) {
    const dateKey = toISODate(l.scheduled_date)
    if (!logMap[l.assignment_id]) logMap[l.assignment_id] = {}
    logMap[l.assignment_id][dateKey] = l
  }

  const { suppressed, injected } = indexOverrides(overrides)

  const calendar = {}
  const winStart = new Date(`${startDate}T00:00:00`)
  const winEnd   = new Date(`${endDate}T00:00:00`)

  // One expanded instance, pushed onto `key`. original_date is echoed back to the
  // client so a drag can tell the server which occurrence it is moving.
  function push(s, key, originalDate) {
    if (!calendar[key]) calendar[key] = []
    calendar[key].push({
      assignment: { ...s, start_date: toISODate(s.start_date), end_date: toISODate(s.end_date) },
      exercises: exByKey[`${s.workout_id}|${s.day_label}`] ?? [],
      log: logMap[s.id]?.[key] ?? null,
      original_date: originalDate,
      moved: originalDate !== key,
    })
  }

  for (const s of schedules) {
    const sStartISO = toISODate(s.start_date)
    const sEndISO   = toISODate(s.end_date)
    const sStart = new Date(`${sStartISO}T00:00:00`)
    const sEnd   = sEndISO ? new Date(`${sEndISO}T00:00:00`) : winEnd

    const iterStart = new Date(Math.max(winStart.getTime(), sStart.getTime()))
    const iterEnd   = new Date(Math.min(winEnd.getTime(), sEnd.getTime()))
    for (let d = new Date(iterStart); d <= iterEnd; d.setDate(d.getDate() + 1)) {
      const key = toISODate(d)
      if (!ruleMatches(s, key)) continue
      if (suppressed.has(`${s.id}|${key}`)) continue   // moved off this date
      push(s, key, key)
    }
  }

  // Inject moved occurrences. Done in a second pass (and outside the rule's own
  // start/end clamp) so an occurrence dragged in from outside the window — or
  // past the assignment's end_date — still shows on its new date.
  const byId = new Map(schedules.map(s => [s.id, s]))
  for (const [newDate, list] of Object.entries(injected)) {
    if (newDate < startDate || newDate > endDate) continue
    for (const inj of list) {
      const s = byId.get(inj.assignment_id)
      if (s) push(s, newDate, inj.original_date)
    }
  }

  return calendar
}

// GET /api/client-workouts/me/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns the calling client's scheduled workouts expanded for the window, each
// instance carrying its day's exercises (with target sets/reps/weight) and the
// existing log if one has been recorded.
router.get('/me/calendar', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const start = req.query.start ?? new Date().toISOString().slice(0, 10)
    const end   = req.query.end   ?? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10)

    // The EXISTS arm pulls in assignments whose rule doesn't overlap the window but
    // which have an occurrence dragged into it (or dragged past their own end_date).
    const { rows: schedules } = await pool.query(`
      SELECT s.*, w.name AS workout_name
      FROM coach_assigned_workouts s
      JOIN workouts w ON w.id = s.workout_id
      WHERE s.user_id = $1 AND s.active = TRUE
        AND (
          (s.start_date <= $3::date AND (s.end_date IS NULL OR s.end_date >= $2::date))
          OR EXISTS (
            SELECT 1 FROM workout_schedule_overrides o
            WHERE o.assignment_id = s.id
              AND o.new_date BETWEEN $2::date AND $3::date
          )
        )
    `, [dbUserId, start, end])

    // Overrides are fetched for the whole assignment set, not just the window: a
    // suppression whose original_date is inside the window can have its new_date
    // outside it, and vice versa.
    const { rows: overrides } = await pool.query(`
      SELECT assignment_id, original_date, new_date
      FROM workout_schedule_overrides
      WHERE user_id = $1
    `, [dbUserId])

    const { rows: logs } = await pool.query(`
      SELECT id, assignment_id, scheduled_date, notes, completed_at
      FROM workout_logs
      WHERE user_id = $1 AND assignment_id IS NOT NULL
        AND scheduled_date BETWEEN $2::date AND $3::date
    `, [dbUserId, start, end])

    // Fetch the exercises for every (workout_id, day_label) referenced by a schedule,
    // then index by `${workout_id}|${day_label}` so expandCalendar can attach them.
    const exByKey = {}
    const workoutIds = [...new Set(schedules.map(s => s.workout_id))]
    if (workoutIds.length) {
      const { rows: exRows } = await pool.query(`
        SELECT we.*,
               COALESCE(
                 (SELECT image_url FROM exercises WHERE id = we.exercise_id),
                 (SELECT image_url FROM exercises
                    WHERE lower(trim(name)) = lower(trim(we.exercise_name))
                      AND image_url IS NOT NULL
                    ORDER BY id LIMIT 1)
               ) AS image_url
        FROM workout_exercises we
        WHERE we.workout_id = ANY($1::int[])
        ORDER BY we.sort_order, we.id
      `, [workoutIds])
      for (const ex of exRows) {
        const k = `${ex.workout_id}|${ex.day}`
        if (!exByKey[k]) exByKey[k] = []
        exByKey[k].push(ex)
      }
    }

    res.json({
      start, end,
      calendar: expandCalendar(schedules, logs, exByKey, start, end, overrides),
    })
  } catch (err) { next(err) }
})

// POST /api/client-workouts/me/reschedule
// body: { assignment_id, original_date, new_date, range_start?, range_end? }
//
// Moves ONE occurrence of a recurring assignment to a different date. The
// recurrence rule on coach_assigned_workouts (frequency / days_of_week /
// start_date) is never touched — the move is recorded as a single
// workout_schedule_overrides exception row.
//
// If new_date already holds occurrences of *other* assignments, they are swapped
// back onto original_date in the same transaction, so nothing is dropped.
router.post('/me/reschedule', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { assignment_id, original_date, new_date, range_start, range_end } = req.body ?? {}
    const assignmentId = parseInt(assignment_id, 10)
    if (!assignmentId || Number.isNaN(assignmentId)) {
      return res.status(400).json({ error: 'assignment_id is required' })
    }
    if (!DATE_RE.test(original_date ?? '') || !DATE_RE.test(new_date ?? '')) {
      return res.status(400).json({ error: 'original_date and new_date must be YYYY-MM-DD' })
    }
    if (original_date === new_date) {
      return res.status(400).json({ error: 'new_date must differ from original_date' })
    }
    // Both dates must sit inside the calendar window the client is looking at.
    // range_start/range_end are optional (older clients omit them); when absent we
    // still bound the move to ±1 year of today so a bad payload can't scatter an
    // occurrence into 2199.
    if (range_start != null || range_end != null) {
      if (!DATE_RE.test(range_start ?? '') || !DATE_RE.test(range_end ?? '')) {
        return res.status(400).json({ error: 'range_start and range_end must be YYYY-MM-DD' })
      }
      for (const d of [original_date, new_date]) {
        if (d < range_start || d > range_end) {
          return res.status(400).json({ error: 'Dates must fall inside the visible calendar range' })
        }
      }
    } else {
      const today = new Date()
      const lo = new Date(today); lo.setFullYear(lo.getFullYear() - 1)
      const hi = new Date(today); hi.setFullYear(hi.getFullYear() + 1)
      const loISO = toISODate(lo), hiISO = toISODate(hi)
      for (const d of [original_date, new_date]) {
        if (d < loISO || d > hiISO) {
          return res.status(400).json({ error: 'Dates must fall inside the visible calendar range' })
        }
      }
    }

    // Every active assignment for this client — needed to know what already sits on
    // the target date, not just the one being dragged.
    const { rows: schedules } = await pool.query(`
      SELECT s.* FROM coach_assigned_workouts s
      WHERE s.user_id = $1 AND s.active = TRUE
    `, [dbUserId])
    if (!schedules.some(s => s.id === assignmentId)) {
      return res.status(404).json({ error: 'Schedule not found' })
    }

    const { rows: overrides } = await pool.query(`
      SELECT assignment_id, original_date, new_date
      FROM workout_schedule_overrides WHERE user_id = $1
    `, [dbUserId])

    // The dragged occurrence must actually exist on original_date today.
    const source = occurrencesOn(schedules, overrides, original_date)
      .find(o => o.assignment.id === assignmentId)
    if (!source) {
      return res.status(404).json({ error: 'That workout is not scheduled on the original date' })
    }
    // Refuse a move that would land two occurrences of the same assignment on one day.
    const targetOccurrences = occurrencesOn(schedules, overrides, new_date)
    if (targetOccurrences.some(o => o.assignment.id === assignmentId)) {
      return res.status(400).json({ error: 'That workout is already scheduled on the target date' })
    }
    const displaced = targetOccurrences.filter(o => o.assignment.id !== assignmentId)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Write (or clear) one exception row. Keyed by the RULE date, so dragging an
      // already-moved occurrence again updates its existing row instead of adding
      // a second one. Moving it back onto its rule date deletes the row entirely.
      async function setOverride(aId, ruleDate, targetDate) {
        if (ruleDate === targetDate) {
          await client.query(`
            DELETE FROM workout_schedule_overrides
            WHERE user_id = $1 AND assignment_id = $2 AND original_date = $3::date
          `, [dbUserId, aId, ruleDate])
          return
        }
        await client.query(`
          INSERT INTO workout_schedule_overrides (user_id, assignment_id, original_date, new_date)
          VALUES ($1, $2, $3::date, $4::date)
          ON CONFLICT (assignment_id, original_date)
          DO UPDATE SET new_date = EXCLUDED.new_date, created_at = NOW()
        `, [dbUserId, aId, ruleDate, targetDate])
      }

      // Completion history follows the workout. workout_logs is keyed by
      // (assignment_id, scheduled_date), and the calendar reads a day's log by that
      // pair — so if the log stayed on the old date the client would see the moved
      // workout as un-logged AND a ghost "logged" entry on a day with no workout.
      // Moving the row keeps sets/notes/completed_at intact and attached to the same
      // assignment. Guarded by NOT EXISTS so it can never violate the unique index;
      // if the target slot is somehow already logged, the old row is left alone
      // rather than deleted.
      async function moveLog(aId, fromDate, toDate) {
        await client.query(`
          UPDATE workout_logs SET scheduled_date = $4::date
          WHERE user_id = $1 AND assignment_id = $2 AND scheduled_date = $3::date
            AND NOT EXISTS (
              SELECT 1 FROM workout_logs w2
              WHERE w2.assignment_id = $2 AND w2.scheduled_date = $4::date
            )
        `, [dbUserId, aId, fromDate, toDate])
      }

      await setOverride(assignmentId, source.original_date, new_date)
      await moveLog(assignmentId, original_date, new_date)

      for (const d of displaced) {
        await setOverride(d.assignment.id, d.original_date, original_date)
        await moveLog(d.assignment.id, new_date, original_date)
      }

      await client.query('COMMIT')
      res.json({
        ok: true,
        moved:    { assignment_id: assignmentId, from: original_date, to: new_date },
        swapped:  displaced.map(d => ({
          assignment_id: d.assignment.id, from: new_date, to: original_date,
        })),
      })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) { next(err) }
})

// POST /api/client-workouts/me/logs
// body: { assignment_id, scheduled_date, notes, sets: [{ workout_exercise_id, set_number, actual_reps, actual_weight }] }
// Upserts the workout_logs row for the (assignment, date) slot and replaces its
// child workout_set_logs with the provided sets. `sets` is optional.
router.post('/me/logs', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)

    const { assignment_id, scheduled_date, notes, sets } = req.body
    if (!assignment_id || !scheduled_date) {
      return res.status(400).json({ error: 'assignment_id and scheduled_date are required' })
    }
    if (!DATE_RE.test(scheduled_date)) {
      return res.status(400).json({ error: 'scheduled_date must be YYYY-MM-DD' })
    }
    if (sets != null && !Array.isArray(sets)) {
      return res.status(400).json({ error: 'sets must be an array' })
    }

    // Verify the assignment belongs to this client; derive its workout_id
    const { rows: aRows } = await pool.query(
      'SELECT id, workout_id FROM coach_assigned_workouts WHERE id = $1 AND user_id = $2',
      [assignment_id, dbUserId],
    )
    if (!aRows.length) return res.status(404).json({ error: 'Schedule not found' })
    const workoutId = aRows[0].workout_id

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const { rows: [log] } = await client.query(`
        INSERT INTO workout_logs (user_id, workout_id, assignment_id, scheduled_date, notes, org_id)
        VALUES ($1, $2, $3, $4::date, $5, $6)
        ON CONFLICT (assignment_id, scheduled_date) DO UPDATE SET
          notes        = EXCLUDED.notes,
          completed_at = NOW()
        RETURNING *
      `, [dbUserId, workoutId, assignment_id, scheduled_date, notes ?? null, req.orgId])

      // Replace the child set logs so re-submitting a day is idempotent
      await client.query('DELETE FROM workout_set_logs WHERE workout_log_id = $1', [log.id])
      const savedSets = []
      for (const s of (sets ?? [])) {
        const { rows: [row] } = await client.query(`
          INSERT INTO workout_set_logs
            (workout_log_id, workout_exercise_id, set_number, actual_reps, actual_weight)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [
          log.id,
          s.workout_exercise_id ?? null,
          s.set_number ?? null,
          s.actual_reps ?? null,
          s.actual_weight ?? null,
        ])
        savedSets.push(row)
      }

      await client.query('COMMIT')
      res.status(201).json({ log, sets: savedSets })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) { next(err) }
})

// GET /api/client-workouts/me/logs/:assignmentId/:date — fetch an existing log +
// its set logs for prefill when the client reopens a day they already logged.
router.get('/me/logs/:assignmentId/:date', requireAuth(), async (req, res, next) => {
  try {
    const { userId } = getAuth(req)
    const dbUserId = await getOrCreateUser(userId)
    const assignmentId = parseInt(req.params.assignmentId, 10)
    const date = req.params.date
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
    }

    const { rows: [log] } = await pool.query(`
      SELECT * FROM workout_logs
      WHERE user_id = $1 AND assignment_id = $2 AND scheduled_date = $3::date
    `, [dbUserId, assignmentId, date])

    if (!log) return res.json({ log: null, sets: [] })

    const { rows: sets } = await pool.query(`
      SELECT * FROM workout_set_logs WHERE workout_log_id = $1 ORDER BY id
    `, [log.id])

    res.json({ log, sets })
  } catch (err) { next(err) }
})

export default router
