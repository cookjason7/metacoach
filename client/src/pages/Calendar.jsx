import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'
import ExerciseThumb from '../components/ExerciseThumb.jsx'

// Same mapping as Dashboard's getProgressCurrent — keeps both pages in sync.
// Returns the current live value for a progress habit, or null for plain checkboxes.
function getProgressCurrent(habit, todayLog, todayMeals) {
  if (habit.habit_type !== 'numeric' || !habit.target_value) return null
  const unit = (habit.unit ?? '').trim().toLowerCase()
  if (unit === 'oz')                return parseFloat(todayLog?.water_oz ?? 0)
  if (/^steps?$/.test(unit))        return todayLog?.steps ?? 0
  if (unit === 'g' && /fiber/i.test(habit.habit_name ?? ''))
    return parseFloat(todayMeals?.total_fiber ?? 0)
  return null
}

// Monday-first week order
const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

// Supportive completion messages — never shame language
const ENCOURAGE_DEFAULT = [
  'Nice work. Small wins stack.',
  'Momentum built.',
  'You showed up today.',
  'One step forward.',
  'Consistency over perfection.',
]
const ENCOURAGE_REBUILD = [
  "Let's rebuild momentum.",
  'Back on track.',
  'Every restart counts.',
]

function isoDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
function todayISO() { return isoDate(new Date()) }

// Pad to Monday-first grid: returns offset (0-6) for first day of month
function firstDayOffset(year, month) {
  const dow = new Date(year, month, 1).getDay()  // Sun=0..Sat=6
  return (dow + 6) % 7                            // Mon=0..Sun=6
}

// Detect "rebuild" — yesterday's same habit had no completion / not_started
function isRebuild(calendar, habitId, isoToday) {
  const yesterday = new Date(isoToday)
  yesterday.setDate(yesterday.getDate() - 1)
  const yKey = isoDate(yesterday)
  const yEntries = calendar[yKey] ?? []
  const y = yEntries.find(e => e.habit.id === habitId)
  if (!y) return false  // not scheduled yesterday
  return !y.completion || y.completion.status === 'not_started'
}

// Pick a random message from a pool
function pickMessage(pool) {
  return pool[Math.floor(Math.random() * pool.length)]
}

// ─── Habit pill (one habit on one day) ────────────────────────────────────────

// liveCurrent: pre-computed live value from daily_logs/meals for today's progress habits.
// null → use stored completion data (past days, non-progress habits).
// compact: true for 14d/month grid cells; false (default) for the expanded 7d list.
function HabitPill({ entry, dateISO, onComplete, isPast, liveCurrent = null, compact = false }) {
  const { habit, completion } = entry
  const isNumeric = habit.habit_type === 'numeric'

  // Live percentage — same formula as Dashboard
  const livePct = liveCurrent !== null && habit.target_value
    ? Math.min(100, (liveCurrent / Number(habit.target_value)) * 100)
    : null

  // When live data is available, derive status from it so Calendar matches Dashboard
  const storedStatus = completion?.status ?? 'not_started'
  const status = livePct !== null
    ? (livePct >= 80 ? 'complete' : livePct >= 50 ? 'partial' : 'not_started')
    : storedStatus

  // Percentage to display — prefer live, fall back to stored
  const pct = livePct ?? (
    completion?.completion_percentage != null ? Number(completion.completion_percentage) : 0
  )

  // Current value to display alongside target
  const displayCurrent = liveCurrent !== null
    ? Math.round(liveCurrent)
    : completion?.completed_value != null
      ? Math.round(Number(completion.completed_value))
      : null

  const baseClass = {
    complete:    'bg-emerald-50 border-emerald-200',
    partial:     'bg-amber-50  border-amber-200',
    not_started: 'bg-white     border-gray-200',
  }[status]

  function CircleIcon() {
    if (status === 'complete')
      return (
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white text-xs font-bold shrink-0">✓</span>
      )
    if (status === 'partial')
      return (
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border-2 border-amber-400 bg-amber-200 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
        </span>
      )
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border-2 border-gray-300 bg-white shrink-0" />
    )
  }

  // ── Progress/numeric habits — read-only display ────────────────────────────
  // These auto-complete via Dashboard + Quick Log; no manual entry in Calendar.
  if (isNumeric) {
    if (compact) {
      // Compact pill for 14d / month grid cells
      return (
        <div className={`w-full rounded-md border px-1.5 py-1 ${baseClass}`}>
          <div className="flex items-center gap-1.5">
            <CircleIcon />
            <span className={`text-[11px] truncate flex-1 ${status === 'complete' ? 'text-emerald-800 line-through' : 'text-gray-800'}`}>
              {habit.habit_name}
            </span>
            <span className="ml-auto text-[10px] font-semibold text-gray-500 shrink-0">
              {Math.round(pct)}%
            </span>
          </div>
          {habit.target_value && pct > 0 && (
            <div className="mt-0.5 w-full h-1 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${status === 'complete' ? 'bg-emerald-500' : 'bg-[#E8670A]'}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          )}
        </div>
      )
    }

    // Full read-only pill for 7d list view
    return (
      <div className={`w-full rounded-md border px-1.5 py-1.5 ${baseClass}`}>
        <div className="flex items-center gap-1.5">
          <CircleIcon />
          <span className={`text-[11px] truncate flex-1 font-medium ${status === 'complete' ? 'text-emerald-800 line-through' : 'text-gray-800'}`}>
            {habit.habit_name}
          </span>
          <span className="ml-auto text-[10px] font-semibold text-gray-500 shrink-0">
            {Math.round(pct)}%
          </span>
        </div>
        {habit.target_value && (
          <>
            <div className="mt-1 flex justify-between text-[10px] text-gray-400 mb-0.5 px-0.5">
              <span>
                {displayCurrent !== null ? displayCurrent : '—'}
                {' '}/ {habit.target_value}{habit.unit ? ` ${habit.unit}` : ''}
              </span>
              <span>
                {status === 'complete' ? 'Done ✓' : status === 'partial' ? 'In progress' : 'Auto-tracked'}
              </span>
            </div>
            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${status === 'complete' ? 'bg-emerald-500' : 'bg-[#E8670A]'}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Completion habits — tap to toggle ──────────────────────────────────────
  return (
    <button
      type="button"
      onClick={() => {
        const newVal = status === 'complete' ? 0 : 1
        onComplete(habit.id, dateISO, newVal)
      }}
      className={`w-full flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-left transition-colors ${baseClass} ${
        status === 'complete' ? 'hover:bg-emerald-100' :
        status === 'partial'  ? 'hover:bg-amber-100'  :
                                'hover:bg-orange-50'
      }`}
      title={habit.habit_name}
    >
      <CircleIcon />
      <span className={`text-[11px] truncate ${status === 'complete' ? 'text-emerald-800 line-through' : 'text-gray-800'}`}>
        {habit.habit_name}
      </span>
    </button>
  )
}

// ─── Workout pill (one scheduled workout day on one date) ─────────────────────

// Distinct from HabitPill: a rounded-SQUARE dumbbell badge (indigo) vs the habit's
// round checkmark (emerald/amber). Tapping opens the WorkoutDetailModal to log sets.
function DumbbellGlyph({ className = 'w-3 h-3' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <rect x="1.5"  y="7.5"  width="3.2"  height="9"   rx="1" />
      <rect x="19.3" y="7.5"  width="3.2"  height="9"   rx="1" />
      <rect x="4.7"  y="10.4" width="14.6" height="3.2" rx="1" />
    </svg>
  )
}

function WorkoutBadge({ done }) {
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-md shrink-0 ${
      done ? 'bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-600 border border-indigo-200'
    }`}>
      {done ? <span className="text-[11px] font-bold leading-none">✓</span> : <DumbbellGlyph />}
    </span>
  )
}

function WorkoutPill({ entry, dateISO, onOpen, compact = false }) {
  const { assignment, log, exercises } = entry
  const done = !!log
  const exCount = exercises?.length ?? 0
  const base = done ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-indigo-200'

  return (
    <button
      type="button"
      onClick={() => onOpen(entry, dateISO)}
      className={`w-full flex items-center gap-1.5 rounded-md border px-1.5 ${compact ? 'py-1' : 'py-1.5'} text-left transition-colors hover:border-indigo-400 hover:bg-indigo-50 ${base}`}
      title={`${assignment.day_label} · ${assignment.workout_name}`}
    >
      <WorkoutBadge done={done} />
      <span className="min-w-0 flex-1">
        <span className={`block text-[11px] truncate font-medium ${done ? 'text-indigo-800' : 'text-gray-800'}`}>
          {assignment.day_label}
        </span>
        {!compact && (
          <span className="block text-[10px] text-gray-400 truncate">{assignment.workout_name}</span>
        )}
      </span>
      {done
        ? <span className="ml-auto text-[9px] font-bold text-indigo-600 uppercase tracking-wide shrink-0">Logged</span>
        : (!compact && exCount > 0)
          ? <span className="ml-auto text-[9px] text-gray-400 shrink-0">{exCount} ex</span>
          : null}
    </button>
  )
}

// ─── Workout detail modal (log actual sets for a scheduled day) ───────────────

function WorkoutDetailModal({ entry, dateISO, getToken, onClose, onSaved }) {
  const { assignment, exercises } = entry

  // Each exercise gets max(sets,1) editable set rows: { reps, weight }
  function buildInitial() {
    const map = {}
    for (const ex of exercises ?? []) {
      const n = Math.max(1, Number(ex.sets) || 1)
      map[ex.id] = Array.from({ length: n }, () => ({ reps: '', weight: '' }))
    }
    return map
  }

  const [rows,    setRows]    = useState(buildInitial)
  const [notes,   setNotes]   = useState('')
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState(null)
  const done = !!entry.log

  // Prefill from an existing log for this (assignment, date)
  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/client-workouts/me/logs/${assignment.id}/${dateISO}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          if (!alive) return
          if (data.log?.notes) setNotes(data.log.notes)
          if (data.sets?.length) {
            setRows(prev => {
              const next = { ...prev }
              for (const s of data.sets) {
                const exId = s.workout_exercise_id
                if (exId == null || !next[exId]) continue
                const idx = (Number(s.set_number) || 1) - 1
                const arr = next[exId].slice()
                while (arr.length <= idx) arr.push({ reps: '', weight: '' })
                arr[idx] = { reps: s.actual_reps ?? '', weight: s.actual_weight ?? '' }
                next[exId] = arr
              }
              return next
            })
          }
        }
      } catch { /* prefill is best-effort */ }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function updateRow(exId, idx, field, val) {
    setRows(prev => {
      const arr = (prev[exId] ?? []).slice()
      arr[idx] = { ...(arr[idx] ?? { reps: '', weight: '' }), [field]: val }
      return { ...prev, [exId]: arr }
    })
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const sets = []
      for (const ex of (exercises ?? [])) {
        ;(rows[ex.id] ?? []).forEach((r, i) => {
          sets.push({
            workout_exercise_id: ex.id,
            set_number:    i + 1,
            actual_reps:   r.reps?.trim()   ? r.reps.trim()   : null,
            actual_weight: r.weight?.trim() ? r.weight.trim() : null,
          })
        })
      }
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/client-workouts/me/logs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignment_id:  assignment.id,
          scheduled_date: dateISO,
          notes:          notes.trim() || null,
          sets,
        }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || `Server error ${res.status}`)
      }
      const data = await res.json()
      onSaved(dateISO, assignment.id, data.log)
    } catch (err) {
      setError(err.message)
    } finally { setSaving(false) }
  }

  const dateLabel = new Date(dateISO + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[92vh] flex flex-col overflow-hidden shadow-xl"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-gray-900 truncate">{assignment.day_label}</p>
              {done && (
                <span className="text-[10px] font-bold uppercase tracking-wide text-indigo-600 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded-full shrink-0">
                  Logged
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-400 truncate">{assignment.workout_name} · {dateLabel}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1.5 leading-none shrink-0 text-lg">✕</button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-4 space-y-4">
          {loading ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : (exercises ?? []).length === 0 ? (
            <p className="text-sm text-gray-500">No exercises found for this workout day.</p>
          ) : (exercises ?? []).map(ex => {
            const nSets = Math.max(1, Number(ex.sets) || 1)
            return (
              <div key={ex.id} className="rounded-xl border border-gray-200 overflow-hidden">
                <div className="flex items-center gap-2.5 p-2.5 bg-gray-50 border-b border-gray-100">
                  <ExerciseThumb src={ex.image_url} alt={ex.exercise_name} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{ex.exercise_name}</p>
                    <p className="text-[11px] text-gray-500">
                      {ex.sets ?? '—'} sets
                      {ex.reps ? ` · ${ex.reps} reps` : ''}
                      {ex.weight ? ` · ${ex.weight}` : ''}
                      {ex.rest_seconds ? ` · ${ex.rest_seconds}s rest` : ''}
                    </p>
                    {ex.notes && <p className="text-[11px] text-gray-400 whitespace-pre-wrap break-words">{ex.notes}</p>}
                  </div>
                </div>
                <div className="p-2.5 space-y-1.5">
                  <div className="flex items-center gap-2 px-0.5">
                    <span className="w-12 shrink-0" />
                    <span className="flex-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                      Reps{ex.reps ? ` · tgt ${ex.reps}` : ''}
                    </span>
                    <span className="flex-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                      Weight{ex.weight ? ` · tgt ${ex.weight}` : ''}
                    </span>
                  </div>
                  {Array.from({ length: nSets }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-12 shrink-0 text-[11px] font-medium text-gray-500">Set {i + 1}</span>
                      <input
                        value={rows[ex.id]?.[i]?.reps ?? ''}
                        onChange={e => updateRow(ex.id, i, 'reps', e.target.value)}
                        inputMode="numeric" placeholder={ex.reps || '—'}
                        className="flex-1 min-w-0 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30"
                      />
                      <input
                        value={rows[ex.id]?.[i]?.weight ?? ''}
                        onChange={e => updateRow(ex.id, i, 'weight', e.target.value)}
                        placeholder={ex.weight || 'lbs'}
                        className="flex-1 min-w-0 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {!loading && (exercises ?? []).length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
              <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="How did it go? Anything to remember for next time…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 resize-none" />
            </div>
          )}

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-gray-100 shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors">
            Close
          </button>
          <button onClick={save} disabled={saving || loading}
            className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors flex items-center gap-2">
            {saving
              ? <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Saving…</>
              : (done ? 'Update Log' : 'Save Workout')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Day cell ─────────────────────────────────────────────────────────────────

function DayCell({ date, inMonth, entries, workoutEntries = [], onComplete, onOpenWorkout, isToday, todayLog = null, todayMeals = null }) {
  const dateISO = isoDate(date)
  const dayNum = date.getDate()
  const isPast = date < new Date(new Date().toDateString())

  return (
    <div
      className={`min-h-[90px] sm:min-h-[110px] border border-gray-100 p-1 sm:p-1.5 flex flex-col gap-1 ${
        !inMonth ? 'bg-gray-50/50' : 'bg-white'
      } ${isToday ? 'ring-2 ring-[#E8670A] ring-inset' : ''}`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-[10px] sm:text-xs font-bold ${
          isToday ? 'text-[#E8670A]' :
          inMonth ? 'text-gray-700' : 'text-gray-300'
        }`}>
          {dayNum}
        </span>
        {isToday && <span className="text-[8px] sm:text-[9px] font-bold text-[#E8670A] uppercase tracking-wider">Today</span>}
      </div>
      <div className="flex-1 space-y-0.5 overflow-hidden">
        {entries.map((entry, i) => (
          <HabitPill
            key={`${entry.habit.id}-${i}`}
            entry={entry}
            dateISO={dateISO}
            onComplete={onComplete}
            isPast={isPast}
            liveCurrent={getProgressCurrent(entry.habit, todayLog, todayMeals)}
            compact={true}
          />
        ))}
        {workoutEntries.map((wEntry, i) => (
          <WorkoutPill
            key={`w-${wEntry.assignment.id}-${i}`}
            entry={wEntry}
            dateISO={dateISO}
            onOpen={onOpenWorkout}
            compact={true}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Main Calendar ───────────────────────────────────────────────────────────

export default function Calendar() {
  const { getToken } = useAuth()
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // View modes: '7d', '14d', 'month'
  const [viewMode, setViewMode] = useState('7d')
  // Anchor date — for month mode this is set to month-1st; for strip views,
  // it represents the start of the visible window.
  // Default: Monday of the current week so the 7d view opens on today.
  const [anchor, setAnchor]   = useState(() => {
    const d = new Date(today)
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return d
  })
  const [calendar,    setCalendar]    = useState({})
  const [workoutCal,  setWorkoutCal]  = useState({})   // scheduled workouts by date
  const [activeWorkout, setActiveWorkout] = useState(null)  // { entry, dateISO } → modal
  const [loading,     setLoading]     = useState(true)
  const [toast,       setToast]       = useState(null)
  const [todayLog,    setTodayLog]    = useState(null)   // live daily_logs row for today
  const [todayMeals,  setTodayMeals]  = useState(null)   // live meal totals for today

  // Compute the visible window based on view mode
  let gridStart, gridEnd, gridCells
  if (viewMode === 'month') {
    const year  = anchor.getFullYear()
    const month = anchor.getMonth()
    const offset = firstDayOffset(year, month)
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const totalCells = Math.ceil((offset + daysInMonth) / 7) * 7
    gridStart = new Date(year, month, 1 - offset)
    gridEnd   = new Date(year, month, 1 - offset + totalCells - 1)
    gridCells = totalCells
  } else if (viewMode === '14d') {
    gridStart = new Date(anchor)
    gridStart.setHours(0, 0, 0, 0)
    gridEnd = new Date(gridStart)
    gridEnd.setDate(gridEnd.getDate() + 13)
    gridCells = 14
  } else {
    // 7d
    gridStart = new Date(anchor)
    gridStart.setHours(0, 0, 0, 0)
    gridEnd = new Date(gridStart)
    gridEnd.setDate(gridEnd.getDate() + 6)
    gridCells = 7
  }

  const loadCalendar = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const start = isoDate(gridStart)
      const end   = isoDate(gridEnd)
      const headers = { Authorization: `Bearer ${token}` }
      const [habitRes, workoutRes] = await Promise.all([
        fetch(`${API_URL}/api/client-habits/me/calendar?start=${start}&end=${end}`, { headers }),
        fetch(`${API_URL}/api/client-workouts/me/calendar?start=${start}&end=${end}`, { headers }),
      ])
      if (habitRes.ok) {
        setCalendar((await habitRes.json()).calendar ?? {})
      } else {
        console.warn('[calendar] habit load failed:', habitRes.status)
      }
      if (workoutRes.ok) {
        setWorkoutCal((await workoutRes.json()).calendar ?? {})
      } else {
        console.warn('[calendar] workout load failed:', workoutRes.status)
      }
    } catch (e) {
      console.warn('[calendar] load error:', e.message)
    } finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, anchor.getTime(), getToken])

  useEffect(() => { loadCalendar() }, [loadCalendar])

  // Fetch today's live daily_logs + meal totals once on mount.
  // These are the same sources Dashboard uses for progress habits.
  useEffect(() => {
    let cancelled = false
    async function loadLiveData() {
      try {
        const token = await getToken()
        const today = todayISO()
        const headers = { Authorization: `Bearer ${token}` }
        const [logRes, mealsRes] = await Promise.all([
          fetch(`${API_URL}/api/daily-logs/today`, { headers }),
          fetch(`${API_URL}/api/meals/today?date=${today}`, { headers }),
        ])
        if (!cancelled) {
          if (logRes.ok)   setTodayLog(await logRes.json())
          if (mealsRes.ok) setTodayMeals(await mealsRes.json())
        }
      } catch {}
    }
    loadLiveData()
    return () => { cancelled = true }
  }, [getToken])

  // Refetch today's habit completions AND live data so Calendar stays in sync
  // with Dashboard auto-completes and Quick Log updates.
  const refetchToday = useCallback(async () => {
    const today = todayISO()
    try {
      const token = await getToken()
      const headers = { Authorization: `Bearer ${token}` }
      const [habitsRes, logRes, mealsRes] = await Promise.all([
        fetch(`${API_URL}/api/client-habits/me/calendar?start=${today}&end=${today}`, { headers }),
        fetch(`${API_URL}/api/daily-logs/today`, { headers }),
        fetch(`${API_URL}/api/meals/today?date=${today}`, { headers }),
      ])
      if (habitsRes.ok) {
        const data = await habitsRes.json()
        setCalendar(prev => ({ ...prev, [today]: data.calendar[today] ?? [] }))
      }
      if (logRes.ok)   setTodayLog(await logRes.json())
      if (mealsRes.ok) setTodayMeals(await mealsRes.json())
    } catch {}
  }, [getToken])

  // daily-log-updated: also update todayLog directly from event detail for
  // instant display before the async refetch resolves.
  useEffect(() => {
    function onDailyLogUpdated(e) {
      if (e.detail) setTodayLog(e.detail)
      refetchToday()
    }
    window.addEventListener('daily-log-updated', onDailyLogUpdated)
    return () => window.removeEventListener('daily-log-updated', onDailyLogUpdated)
  }, [refetchToday])

  // habit-completion-updated: fired by Dashboard auto-complete and Calendar completions.
  useEffect(() => {
    window.addEventListener('habit-completion-updated', refetchToday)
    return () => window.removeEventListener('habit-completion-updated', refetchToday)
  }, [refetchToday])

  function showToast(message) {
    setToast(message)
    setTimeout(() => setToast(null), 2500)
  }

  async function handleComplete(habitId, dateISO, value) {
    const wasRebuild = isRebuild(calendar, habitId, dateISO)
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/client-habits/me/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ habit_id: habitId, completion_date: dateISO, completed_value: value }),
    })
    if (res.ok) {
      const completion = await res.json()
      // Patch local state instead of full refetch
      setCalendar(prev => {
        const next = { ...prev }
        const dayEntries = (next[dateISO] ?? []).map(e =>
          e.habit.id === habitId ? { ...e, completion } : e
        )
        next[dateISO] = dayEntries
        return next
      })
      if (completion.status === 'complete') {
        showToast(pickMessage(wasRebuild ? ENCOURAGE_REBUILD : ENCOURAGE_DEFAULT))
      }

      // Notify all listeners (Dashboard auto-complete, Calendar self) that a
      // habit completion changed — covers fiber and any other habit type.
      window.dispatchEvent(new CustomEvent('habit-completion-updated'))
    }
  }

  // ── Workout scheduling: open the detail modal, patch state after a save ──────
  function openWorkout(entry, dateISO) {
    setActiveWorkout({ entry, dateISO })
  }
  function handleWorkoutSaved(dateISO, assignmentId, log) {
    // Reflect the new log on the matching calendar entry (flips pill → "Logged")
    setWorkoutCal(prev => {
      const day = (prev[dateISO] ?? []).map(e =>
        e.assignment.id === assignmentId ? { ...e, log } : e
      )
      return { ...prev, [dateISO]: day }
    })
    // Keep the modal open but reflect the saved state (button → "Update Log")
    setActiveWorkout(aw =>
      aw && aw.dateISO === dateISO && aw.entry.assignment.id === assignmentId
        ? { ...aw, entry: { ...aw.entry, log } }
        : aw
    )
    showToast('Workout logged 💪')
  }

  function prev() {
    if (viewMode === 'month') {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))
    } else {
      const days = viewMode === '14d' ? 14 : 7
      const d = new Date(anchor); d.setDate(d.getDate() - days)
      setAnchor(d)
    }
  }
  function next() {
    if (viewMode === 'month') {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))
    } else {
      const days = viewMode === '14d' ? 14 : 7
      const d = new Date(anchor); d.setDate(d.getDate() + days)
      setAnchor(d)
    }
  }
  function goToday() {
    if (viewMode === 'month') {
      setAnchor(new Date(today.getFullYear(), today.getMonth(), 1))
    } else {
      // Start of this week (Monday) for strip views
      const d = new Date(today)
      const dow = d.getDay()
      const mondayOffset = (dow + 6) % 7  // Mon=0..Sun=6
      d.setDate(d.getDate() - mondayOffset)
      setAnchor(d)
    }
  }

  function switchView(mode) {
    setViewMode(mode)
    // Reset anchor to a sensible default for the new mode
    if (mode === 'month') {
      setAnchor(new Date(today.getFullYear(), today.getMonth(), 1))
    } else {
      // Start of this week (Monday) for strip views
      const d = new Date(today)
      const dow = d.getDay()
      const mondayOffset = (dow + 6) % 7
      d.setDate(d.getDate() - mondayOffset)
      setAnchor(d)
    }
  }

  const todayISO_ = todayISO()

  // Build cell list spanning the visible window
  const cells = []
  for (let i = 0; i < gridCells; i++) {
    const d = new Date(gridStart)
    d.setDate(d.getDate() + i)
    cells.push(d)
  }

  // Header label
  let headerLabel
  if (viewMode === 'month') {
    headerLabel = `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`
  } else {
    const startLabel = `${MONTHS[gridStart.getMonth()].slice(0,3)} ${gridStart.getDate()}`
    const endLabel   = `${MONTHS[gridEnd.getMonth()].slice(0,3)} ${gridEnd.getDate()}`
    headerLabel = `${startLabel} – ${endLabel}`
  }

  return (
    <div className="max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Calendar</h1>
          <p className="text-sm text-gray-500">Tap a circle to complete a habit, or a workout to log your sets.</p>
        </div>
        {/* View mode switcher */}
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {[
            { id: '7d',  label: 'Week' },
            { id: '14d', label: '2 Weeks' },
          ].map(v => (
            <button key={v.id} onClick={() => switchView(v.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                viewMode === v.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Date navigation */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button onClick={prev} className="w-9 h-9 rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 min-h-[44px] min-w-[44px]">←</button>
          <span className="text-base font-semibold text-gray-900 min-w-[160px] text-center">
            {headerLabel}
          </span>
          <button onClick={next} className="w-9 h-9 rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 min-h-[44px] min-w-[44px]">→</button>
        </div>
        <button onClick={goToday} className="text-xs text-[#E8670A] hover:text-[#c45e09] font-semibold px-2">Today</button>
      </div>

      {/* ── 7-day view: vertical list (mobile-friendly) ── */}
      {viewMode === '7d' && (
        <div className="space-y-2">
          {cells.map((d, i) => {
            const dKey = isoDate(d)
            const entries = calendar[dKey] ?? []
            const wEntries = workoutCal[dKey] ?? []
            const total = entries.length + wEntries.length
            const isToday = dKey === todayISO_
            return (
              <div key={i} className={`bg-white border rounded-xl p-3 ${
                isToday ? 'border-[#E8670A] ring-2 ring-orange-100' : 'border-gray-200'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className={`text-xs font-bold uppercase tracking-wider ${isToday ? 'text-[#E8670A]' : 'text-gray-400'}`}>
                      {WEEKDAY_HEADERS[(d.getDay() + 6) % 7]} {isToday ? '· Today' : ''}
                    </p>
                    <p className="text-sm font-semibold text-gray-900">
                      {MONTHS[d.getMonth()]} {d.getDate()}
                    </p>
                  </div>
                  {total > 0 && (
                    <span className="text-[10px] font-bold text-gray-400">
                      {entries.length > 0 && `${entries.length} habit${entries.length === 1 ? '' : 's'}`}
                      {entries.length > 0 && wEntries.length > 0 && ' · '}
                      {wEntries.length > 0 && `${wEntries.length} workout${wEntries.length === 1 ? '' : 's'}`}
                    </span>
                  )}
                </div>
                {total === 0 ? (
                  <p className="text-xs text-gray-400 italic">Nothing scheduled</p>
                ) : (
                  <div className="space-y-1.5">
                    {entries.map((entry, j) => (
                      <HabitPill
                        key={`${entry.habit.id}-${j}`}
                        entry={entry}
                        dateISO={dKey}
                        onComplete={handleComplete}
                        liveCurrent={isToday ? getProgressCurrent(entry.habit, todayLog, todayMeals) : null}
                      />
                    ))}
                    {wEntries.map((wEntry, j) => (
                      <WorkoutPill
                        key={`w-${wEntry.assignment.id}-${j}`}
                        entry={wEntry}
                        dateISO={dKey}
                        onOpen={openWorkout}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── 14-day grid: 2x7 ── */}
      {viewMode === '14d' && (
        <>
          <div className="grid grid-cols-7 gap-0 border-t border-l border-gray-200 rounded-t-xl overflow-hidden bg-white">
            {WEEKDAY_HEADERS.map(d => (
              <div key={d} className="text-[10px] sm:text-xs font-bold text-gray-500 uppercase tracking-wider px-1 py-2 text-center border-r border-b border-gray-200">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0 border-l border-gray-200 rounded-b-xl overflow-hidden">
            {cells.map((d, i) => {
              const dKey = isoDate(d)
              const entries = calendar[dKey] ?? []
              return (
                <div key={i} className="border-r border-b border-gray-200">
                  <DayCell
                    date={d}
                    inMonth={true}
                    entries={entries}
                    workoutEntries={workoutCal[dKey] ?? []}
                    onComplete={handleComplete}
                    onOpenWorkout={openWorkout}
                    isToday={dKey === todayISO_}
                    todayLog={dKey === todayISO_ ? todayLog : null}
                    todayMeals={dKey === todayISO_ ? todayMeals : null}
                  />
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── Month view ── */}
      {viewMode === 'month' && (
        <>
          <div className="grid grid-cols-7 gap-0 border-t border-l border-gray-200 rounded-t-xl overflow-hidden bg-white">
            {WEEKDAY_HEADERS.map(d => (
              <div key={d} className="text-[10px] sm:text-xs font-bold text-gray-500 uppercase tracking-wider px-1 py-2 text-center border-r border-b border-gray-200">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0 border-l border-gray-200 rounded-b-xl overflow-hidden">
            {cells.map((d, i) => {
              const inMonth = d.getMonth() === anchor.getMonth()
              const dKey = isoDate(d)
              const entries = calendar[dKey] ?? []
              return (
                <div key={i} className="border-r border-b border-gray-200">
                  <DayCell
                    date={d}
                    inMonth={inMonth}
                    entries={entries}
                    workoutEntries={workoutCal[dKey] ?? []}
                    onComplete={handleComplete}
                    onOpenWorkout={openWorkout}
                    isToday={dKey === todayISO_}
                    todayLog={dKey === todayISO_ ? todayLog : null}
                    todayMeals={dKey === todayISO_ ? todayMeals : null}
                  />
                </div>
              )
            })}
          </div>
        </>
      )}

      {loading && (
        <p className="text-center text-xs text-gray-400 mt-3">Loading…</p>
      )}

      {/* Legend */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-full border-2 border-gray-300 bg-white inline-block" />
          <span className="text-gray-500">Not done</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-full border-2 border-amber-400 bg-amber-200 inline-flex items-center justify-center">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
          </span>
          <span className="text-gray-500">Partial (50–79%)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-full bg-emerald-500 inline-flex items-center justify-center text-white text-[10px] font-bold">✓</span>
          <span className="text-gray-500">Complete (80%+)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-md bg-indigo-100 border border-indigo-200 text-indigo-600 inline-flex items-center justify-center">
            <DumbbellGlyph className="w-2.5 h-2.5" />
          </span>
          <span className="text-gray-500">Scheduled workout</span>
        </span>
      </div>

      {/* Workout detail modal */}
      {activeWorkout && (
        <WorkoutDetailModal
          entry={activeWorkout.entry}
          dateISO={activeWorkout.dateISO}
          getToken={getToken}
          onClose={() => setActiveWorkout(null)}
          onSaved={handleWorkoutSaved}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#1e2a3a] text-white px-5 py-3 rounded-xl shadow-2xl text-sm font-medium animate-fade-in">
          {toast}
        </div>
      )}
    </div>
  )
}
