import { useState, useCallback, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

// ── Program Description (collapsible at 150 chars) ───────────────────────────

function ProgramDescription({ text }) {
  const LIMIT = 150
  const [expanded, setExpanded] = useState(false)
  if (!text) return null
  if (text.length <= LIMIT) return <p className="text-sm text-gray-500 mt-1">{text}</p>
  return (
    <div className="mt-1">
      <p className="text-sm text-gray-500">{expanded ? text : `${text.slice(0, LIMIT)}…`}</p>
      <button
        onClick={() => setExpanded(e => !e)}
        className="text-xs text-[#E8670A] font-medium mt-0.5 hover:text-[#c45e09] transition-colors"
      >
        {expanded ? 'Read less' : 'Read more'}
      </button>
    </div>
  )
}

// ── Log Workout Modal ─────────────────────────────────────────────────────────

function LogModal({ program, onClose, onLogged }) {
  const { getToken } = useAuth()
  const [notes,   setNotes]   = useState('')
  const [logging, setLogging] = useState(false)
  const [error,   setError]   = useState(null)

  async function submit() {
    setLogging(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/workouts/${program.id}/log`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notes.trim() || null }),
      })
      if (!res.ok) throw new Error('Failed to log workout')
      onLogged()
    } catch (err) {
      setError(err.message)
    } finally {
      setLogging(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
        <h3 className="text-base font-semibold text-gray-900">Log Workout Complete</h3>
        <p className="text-sm text-gray-500">{program.name}</p>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
          <textarea
            rows={3}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="How did it go? Any notes for next time…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
          />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex gap-3">
          <button
            onClick={submit}
            disabled={logging}
            className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors"
          >
            {logging ? 'Logging…' : 'Mark Complete'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Program Detail (read-only client view) ────────────────────────────────────

function ProgramDetail({ program, onBack }) {
  const { getToken } = useAuth()
  const [exercises, setExercises] = useState([])
  const [logs,      setLogs]      = useState([])
  const [loading,   setLoading]   = useState(true)
  const [showLog,   setShowLog]   = useState(false)
  const [loggedAt,  setLoggedAt]  = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/workouts/${program.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = await res.json()
        setExercises(data.exercises ?? [])
        setLogs(data.logs ?? [])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [program.id, getToken])

  const days = exercises.reduce((acc, ex) => {
    if (!acc[ex.day]) acc[ex.day] = []
    acc[ex.day].push(ex)
    return acc
  }, {})

  function handleLogged() {
    setShowLog(false)
    setLoggedAt(new Date().toISOString())
    setLogs(prev => [{ completed_at: new Date().toISOString(), notes: null }, ...prev])
  }

  return (
    <div className="max-w-3xl space-y-6">
      {showLog && (
        <LogModal program={program} onClose={() => setShowLog(false)} onLogged={handleLogged} />
      )}

      <div>
        <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600 mb-2 flex items-center gap-1">
          ← All Programs
        </button>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-gray-900">{program.name}</h2>
            {program.description && <ProgramDescription text={program.description} />}
          </div>
          <button
            onClick={() => setShowLog(true)}
            className="shrink-0 bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
          >
            Log Workout
          </button>
        </div>
      </div>

      {loggedAt && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700">
          ✓ Workout logged!
        </div>
      )}

      {loading && <p className="text-sm text-gray-400 py-10 text-center">Loading…</p>}

      {!loading && Object.entries(days).map(([dayName, exs]) => (
        <div key={dayName} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-[#0F1E35] px-5 py-3">
            <p className="text-sm font-semibold text-white">{dayName}</p>
          </div>

          {/* Mobile cards — read-only */}
          <div className="lg:hidden divide-y divide-gray-100">
            {exs.map(ex => (
              <div key={ex.id} className="p-4">
                <p className="text-sm font-semibold text-gray-900 mb-3">{ex.exercise_name}</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['Sets',   ex.sets],
                    ['Reps',   ex.reps],
                    ['Weight', ex.weight],
                    ['Rest',   ex.rest_seconds ? `${ex.rest_seconds}s` : null],
                  ].map(([label, val]) => (
                    <div key={label} className="bg-gray-50 rounded-lg py-2 px-3 text-center">
                      <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
                      <p className="text-sm font-medium text-gray-700 mt-0.5">{val ?? '—'}</p>
                    </div>
                  ))}
                </div>
                {ex.notes && (
                  <p className="text-xs text-gray-500 mt-2 italic">
                    <span className="font-medium text-gray-600 not-italic">Coach note: </span>
                    {ex.notes}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Desktop table — read-only */}
          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Exercise</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-16">Sets</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-24">Reps</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-24">Weight</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-16">Rest</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Coach Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {exs.map(ex => (
                  <tr key={ex.id} className="hover:bg-gray-50/30">
                    <td className="px-4 py-3 font-medium text-gray-900">{ex.exercise_name}</td>
                    <td className="px-3 py-3 text-center text-gray-600">{ex.sets ?? '—'}</td>
                    <td className="px-3 py-3 text-center text-gray-600">{ex.reps ?? '—'}</td>
                    <td className="px-3 py-3 text-center text-gray-600">{ex.weight ?? '—'}</td>
                    <td className="px-3 py-3 text-center text-gray-400 text-xs">
                      {ex.rest_seconds ? `${ex.rest_seconds}s` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 italic">{ex.notes ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {!loading && logs.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Workout Log</p>
          <div className="space-y-2">
            {logs.map((log, i) => (
              <div key={i} className="flex items-start gap-3 bg-white rounded-lg border border-gray-100 px-4 py-3">
                <span className="text-green-500 text-sm mt-0.5">✓</span>
                <div>
                  <p className="text-xs text-gray-500">
                    {new Date(log.completed_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </p>
                  {log.notes && <p className="text-sm text-gray-700 mt-0.5">{log.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Program List ──────────────────────────────────────────────────────────────

function ProgramList({ programs, onSelect }) {
  if (programs.length === 0) {
    return (
      <div className="max-w-xl">
        <div className="text-center py-16 bg-white rounded-2xl border border-gray-200">
          <p className="text-4xl mb-3">💪</p>
          <p className="text-sm font-semibold text-gray-700 mb-1">No programs assigned yet</p>
          <p className="text-xs text-gray-400 max-w-xs mx-auto">
            Your coach will assign your workout program here. Check back soon!
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-gray-500">
        {programs.length} assigned program{programs.length !== 1 ? 's' : ''}
      </p>

      {programs.map(program => (
        <button
          key={program.id}
          onClick={() => onSelect(program)}
          className="w-full text-left bg-white rounded-xl border border-gray-200 p-5 hover:border-[#E8670A] hover:shadow-sm transition-all"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">{program.name}</p>
              {program.description && (
                <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{program.description}</p>
              )}
              <div className="flex gap-4 mt-2 text-xs text-gray-400 flex-wrap">
                <span>{program.day_count ?? 0} days / week</span>
                <span>{program.exercise_count ?? 0} exercises</span>
                {program.log_count > 0 && (
                  <span className="text-green-600 font-medium">
                    {program.log_count} workout{program.log_count !== 1 ? 's' : ''} logged
                  </span>
                )}
                {program.last_logged_at && (
                  <span>
                    Last: {new Date(program.last_logged_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                )}
              </div>
            </div>
            <span className="text-gray-300 shrink-0 mt-1">›</span>
          </div>
        </button>
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Workouts() {
  const { getToken } = useAuth()
  const [view,     setView]     = useState('loading')
  const [programs, setPrograms] = useState([])
  const [selected, setSelected] = useState(null)

  const loadPrograms = useCallback(async () => {
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/workouts`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const data = await res.json()
      setPrograms(data)
      setView('list')
    } catch {
      setView('list')
    }
  }, [getToken])

  useEffect(() => { loadPrograms() }, [loadPrograms])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Workout Plan</h1>
      <p className="text-sm text-gray-500 mb-6">Your coach-assigned workout programs</p>

      {view === 'loading' && <p className="text-sm text-gray-400">Loading…</p>}

      {view === 'list' && (
        <ProgramList
          programs={programs}
          onSelect={(p) => { setSelected(p); setView('detail') }}
        />
      )}

      {view === 'detail' && selected && (
        <ProgramDetail
          program={selected}
          onBack={() => { setSelected(null); setView('list') }}
        />
      )}
    </div>
  )
}
