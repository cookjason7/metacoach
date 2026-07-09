import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../../config.js'
import ExerciseThumb from '../../components/ExerciseThumb.jsx'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function isoDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// Read-only exercise list for a scheduled workout day — coaches view what's
// scheduled, they don't log sets on a client's behalf.
function WorkoutDetailPanel({ clientId, assignment, dateISO, getToken, onClose }) {
  const [exercises, setExercises] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/workouts/${assignment.workout_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        const data = await res.json()
        if (alive) setExercises((data.exercises ?? []).filter(ex => ex.day === assignment.day_label))
      } catch (err) {
        if (alive) setError(err.message)
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [clientId, assignment, getToken])

  const dateLabel = new Date(dateISO + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[92vh] flex flex-col overflow-hidden shadow-xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{assignment.day_label}</p>
            <p className="text-[11px] text-gray-400 truncate">{assignment.workout_name} &middot; {dateLabel}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1.5 leading-none shrink-0 text-lg">&#10005;</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-3">
          {loading ? (
            <p className="text-xs text-gray-400">Loading&hellip;</p>
          ) : error ? (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          ) : exercises.length === 0 ? (
            <p className="text-sm text-gray-500">No exercises found for this workout day.</p>
          ) : exercises.map(ex => (
            <div key={ex.id} className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-2.5 p-2.5 bg-gray-50">
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
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end px-4 py-3 border-t border-gray-100 shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default function CoachCalendar() {
  const { getToken } = useAuth()

  const [clients,  setClients]  = useState([])
  const [clientId, setClientId] = useState('')
  const [anchor,   setAnchor]   = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d })
  const [habitCal,   setHabitCal]   = useState({})
  const [workoutCal, setWorkoutCal] = useState({})
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [detail,  setDetail]  = useState(null) // { assignment, dateISO }

  // Load the client roster once, default to the first client
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients?status=active`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok && alive) {
          const data = await res.json()
          setClients(data)
          setClientId(prev => prev || (data[0] ? String(data[0].id) : ''))
        }
      } catch { /* client picker is best-effort */ }
    })()
    return () => { alive = false }
  }, [getToken])

  const year  = anchor.getFullYear()
  const month = anchor.getMonth()
  const offset = new Date(year, month, 1).getDay() // Sun=0..Sat=6, matches DAYS above
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const totalCells  = Math.ceil((offset + daysInMonth) / 7) * 7
  const gridStart = new Date(year, month, 1 - offset)
  const monthName = anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  const loadCalendars = useCallback(async () => {
    if (!clientId) return
    setLoading(true); setError(null)
    try {
      const token = await getToken()
      const start = isoDate(gridStart)
      const end   = isoDate(new Date(year, month, 1 - offset + totalCells - 1))
      const headers = { Authorization: `Bearer ${token}` }
      const [hRes, wRes] = await Promise.all([
        fetch(`${API_URL}/api/coach-admin/clients/${clientId}/habits/calendar?start=${start}&end=${end}`, { headers }),
        fetch(`${API_URL}/api/coach-admin/clients/${clientId}/workout-schedules/calendar?start=${start}&end=${end}`, { headers }),
      ])
      setHabitCal(hRes.ok ? (await hRes.json()).calendar ?? {} : {})
      setWorkoutCal(wRes.ok ? (await wRes.json()).calendar ?? {} : {})
      if (!hRes.ok && !wRes.ok) setError('Could not load calendar data.')
    } catch {
      setError('Could not load calendar data.')
    } finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, year, month, getToken])

  useEffect(() => { loadCalendars() }, [loadCalendars])

  function changeMonth(delta) {
    setAnchor(a => new Date(a.getFullYear(), a.getMonth() + delta, 1))
  }

  const todayISO = isoDate(new Date())
  const selectedClient = clients.find(c => String(c.id) === clientId)

  const cells = Array.from({ length: totalCells }, (_, i) => {
    const date = new Date(year, month, 1 - offset + i)
    const dateISO = isoDate(date)
    return {
      date, dateISO,
      inMonth: date.getMonth() === month,
      isToday: dateISO === todayISO,
      habits:   habitCal[dateISO]   ?? [],
      workouts: workoutCal[dateISO] ?? [],
    }
  })

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-gray-900">Client Calendar</h1>
        <select
          value={clientId}
          onChange={e => setClientId(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 min-h-[40px]"
        >
          {clients.length === 0 && <option value="">No clients</option>}
          {clients.map(c => (
            <option key={c.id} value={c.id}>
              {[c.first_name, c.display_last_name].filter(Boolean).join(' ') || c.email}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between bg-white border border-gray-200 rounded-xl px-4 py-3">
        <button onClick={() => changeMonth(-1)} className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 hover:text-gray-800 rounded-lg hover:bg-gray-50" aria-label="Previous month">
          &#8249;
        </button>
        <p className="text-sm font-semibold text-gray-800">{monthName}</p>
        <button onClick={() => changeMonth(1)} className="min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 hover:text-gray-800 rounded-lg hover:bg-gray-50" aria-label="Next month">
          &#8250;
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      {!clientId ? (
        <p className="text-sm text-gray-500 text-center py-8">No clients to show yet.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl p-3 sm:p-4 overflow-hidden">
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DAYS.map(d => (
              <p key={d} className="text-[10px] font-bold text-gray-400 text-center py-1">{d}</p>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map(cell => (
              <div key={cell.dateISO} className={`min-h-[84px] sm:min-h-[100px] border rounded-lg p-1 flex flex-col gap-0.5 ${
                !cell.inMonth ? 'border-transparent bg-gray-50/40 opacity-40' :
                cell.isToday  ? 'border-[#E8670A] bg-orange-50' : 'border-gray-100 bg-white'
              }`}>
                <p className={`text-[10px] font-bold leading-tight ${cell.isToday ? 'text-[#E8670A]' : cell.inMonth ? 'text-gray-600' : 'text-gray-300'}`}>
                  {cell.date.getDate()}
                </p>
                <div className="space-y-0.5 overflow-hidden">
                  {cell.workouts.map((w, i) => (
                    <button
                      key={`w-${w.assignment.id}-${i}`}
                      onClick={() => setDetail({ assignment: w.assignment, dateISO: cell.dateISO })}
                      title={`${w.assignment.day_label} · ${w.assignment.workout_name}`}
                      className="w-full text-left text-[9px] font-semibold bg-orange-50 text-[#c45e09] border border-orange-200 px-1 py-0.5 rounded truncate leading-tight hover:bg-orange-100 transition-colors"
                    >
                      {w.log ? '✓ ' : ''}{w.assignment.day_label}
                    </button>
                  ))}
                  {cell.habits.slice(0, 2).map((h, i) => (
                    <div
                      key={`h-${h.habit.id}-${i}`}
                      title={h.habit.habit_name}
                      className="text-[9px] bg-emerald-50 text-emerald-700 px-1 py-0.5 rounded truncate leading-tight"
                    >
                      {h.habit.habit_name}
                    </div>
                  ))}
                  {cell.habits.length > 2 && (
                    <p className="text-[8px] text-gray-400 px-1">+{cell.habits.length - 2} habit{cell.habits.length - 2 !== 1 ? 's' : ''}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {loading && <p className="text-xs text-gray-400 text-center mt-3">Loading&hellip;</p>}
        </div>
      )}

      <p className="text-[11px] text-gray-400">
        Orange pills are scheduled workout days ({selectedClient ? `${selectedClient.first_name ?? 'this client'}’s` : 'the client’s'} program) &mdash; a checkmark means it's been logged. Green pills are assigned habits.
      </p>

      {detail && (
        <WorkoutDetailPanel
          clientId={clientId}
          assignment={detail.assignment}
          dateISO={detail.dateISO}
          getToken={getToken}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}
