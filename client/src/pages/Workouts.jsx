import { useState, useCallback, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'
import ExerciseThumb from '../components/ExerciseThumb.jsx'

// Display-only: "Day 1" -> "Day 1 Workout". Sequential day labels are the stored
// identifier (used to match exercises/schedules); this never touches that value.
function formatDayLabel(label) {
  return label && /^Day \d+$/.test(label) ? `${label} Workout` : label
}

// ── Constants ─────────────────────────────────────────────────────────────────

const GOALS = [
  { id: 'weight_loss',      label: 'Weight Loss' },
  { id: 'muscle_gain',      label: 'Muscle Gain' },
  { id: 'endurance',        label: 'Endurance' },
  { id: 'flexibility',      label: 'Flexibility' },
  { id: 'general_fitness',  label: 'General Fitness' },
]

const SESSION_LENGTHS = ['30 minutes', '45 minutes', '60 minutes', '90 minutes']

const EQUIPMENT_OPTIONS = [
  'Bodyweight only',
  'Resistance bands',
  'Dumbbells',
  'Barbell + Rack',
  'Full gym',
]

const FITNESS_LEVELS = ['Beginner', 'Intermediate', 'Advanced']

const EMPTY_FORM = {
  goals: [],
  days_per_week: '4',
  session_length: '45 minutes',
  equipment: ['Full gym'],
  injuries: '',
  fitness_level: 'Intermediate',
}

// ── Questionnaire — Katie generates the starting plan ─────────────────────────

function Questionnaire({ onGenerate }) {
  const [form,       setForm]       = useState({ ...EMPTY_FORM })
  const [generating, setGenerating] = useState(false)
  const [error,      setError]      = useState(null)
  const { getToken } = useAuth()

  function toggleGoal(id) {
    setForm(f => ({
      ...f,
      goals: f.goals.includes(id) ? f.goals.filter(g => g !== id) : [...f.goals, id],
    }))
  }

  function toggleEquipment(eq) {
    setForm(f => ({
      ...f,
      equipment: f.equipment.includes(eq) ? f.equipment.filter(e => e !== eq) : [...f.equipment, eq],
    }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.goals.length) { setError('Please select at least one goal.'); return }
    setGenerating(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/workouts/generate`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, days_per_week: parseInt(form.days_per_week, 10) }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || `Server error ${res.status}`)
      }
      onGenerate(await res.json(), form)
    } catch (err) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  const pillCls = (active) =>
    `px-3 py-1.5 rounded-full text-xs font-medium border cursor-pointer transition-colors ${
      active
        ? 'bg-[#E8670A] text-white border-[#E8670A]'
        : 'text-gray-600 border-gray-200 hover:border-[#E8670A] hover:text-[#E8670A] bg-white'
    }`

  return (
    <div className="max-w-xl">
      <div className="bg-[#fff7ed] border border-orange-200 rounded-xl p-5 mb-6">
        <p className="text-sm font-semibold text-[#E8670A] mb-1">Hey, I'm Katie!</p>
        <p className="text-sm text-gray-700">
          Tell me a bit about your goals and I'll build you a custom weekly workout program.
          Your coach can review and customize it after. Let's go!
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            What are your fitness goals? <span className="text-red-400">*</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {GOALS.map(g => (
              <button key={g.id} type="button" onClick={() => toggleGoal(g.id)}
                className={pillCls(form.goals.includes(g.id))}>
                {g.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">Training days per week</label>
          <div className="flex gap-2 flex-wrap">
            {[2, 3, 4, 5, 6].map(n => (
              <button key={n} type="button" onClick={() => setForm(f => ({ ...f, days_per_week: String(n) }))}
                className={pillCls(form.days_per_week === String(n))}>{n} days</button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">Session length</label>
          <div className="flex gap-2 flex-wrap">
            {SESSION_LENGTHS.map(s => (
              <button key={s} type="button" onClick={() => setForm(f => ({ ...f, session_length: s }))}
                className={pillCls(form.session_length === s)}>{s}</button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">Available equipment</label>
          <div className="flex gap-2 flex-wrap">
            {EQUIPMENT_OPTIONS.map(eq => (
              <button key={eq} type="button" onClick={() => toggleEquipment(eq)}
                className={pillCls(form.equipment.includes(eq))}>{eq}</button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">Fitness level</label>
          <div className="flex gap-2">
            {FITNESS_LEVELS.map(lvl => (
              <button key={lvl} type="button" onClick={() => setForm(f => ({ ...f, fitness_level: lvl }))}
                className={pillCls(form.fitness_level === lvl)}>{lvl}</button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">
            Injuries or limitations <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="text" value={form.injuries}
            onChange={e => setForm(f => ({ ...f, injuries: e.target.value }))}
            placeholder="e.g. Bad left knee, lower back pain"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <button
          type="submit"
          disabled={generating || !form.goals.length}
          className="w-full bg-[#E8670A] text-white py-3 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {generating ? (
            <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Katie is building your program…</>
          ) : 'Generate My Workout Program'}
        </button>
      </form>
    </div>
  )
}

// ── Plan Review — view Katie's draft before saving ────────────────────────────

function PlanReview({ plan, form, onSave, onRegenerate, onDiscard }) {
  const { getToken } = useAuth()
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  async function save() {
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/workouts`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(plan),
      })
      if (!res.ok) throw new Error('Failed to save program')
      onSave(await res.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">{plan.program_name}</h2>
        <p className="text-sm text-gray-600 mt-1">{plan.description}</p>
        <p className="text-xs text-gray-400 mt-2">
          ✨ Generated by Katie · Your coach can edit exercises after you save
        </p>
      </div>

      {plan.days?.map((day, di) => (
        <div key={di} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-[#0F1E35] px-5 py-3">
            <p className="text-sm font-semibold text-white">{formatDayLabel(day.day_name)}</p>
            {day.focus && <p className="text-xs text-white/60 mt-0.5">{day.focus}</p>}
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden divide-y divide-gray-100">
            {day.exercises?.map((ex, ei) => (
              <div key={ei} className="p-4">
                <p className="text-sm font-semibold text-gray-900 mb-3">{ex.name}</p>
                <div className="grid grid-cols-2 gap-2">
                  {[['Sets', ex.sets], ['Reps', ex.reps], ['Weight', ex.weight ?? '—'], ['Rest', ex.rest_seconds ? `${ex.rest_seconds}s` : '—']].map(([lbl, val]) => (
                    <div key={lbl} className="bg-gray-50 rounded-lg py-2 px-3 text-center">
                      <p className="text-[10px] text-gray-400 uppercase tracking-wide">{lbl}</p>
                      <p className="text-sm font-medium text-gray-700 mt-0.5">{val ?? '—'}</p>
                    </div>
                  ))}
                </div>
                {ex.notes && <p className="text-xs text-gray-400 mt-2">{ex.notes}</p>}
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Exercise</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-16">Sets</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-24">Reps</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-20">Rest</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {day.exercises?.map((ex, ei) => (
                  <tr key={ei} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-medium text-gray-900">{ex.name}</td>
                    <td className="px-3 py-3 text-center text-gray-600">{ex.sets}</td>
                    <td className="px-3 py-3 text-center text-gray-600">{ex.reps}</td>
                    <td className="px-3 py-3 text-center text-gray-500 text-xs">{ex.rest_seconds ? `${ex.rest_seconds}s` : '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{ex.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="flex gap-3 flex-wrap">
        <button
          onClick={save} disabled={saving}
          className="bg-[#E8670A] text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors flex items-center gap-2"
        >
          {saving ? (
            <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Saving…</>
          ) : 'Save Program'}
        </button>
        <button onClick={onRegenerate}
          className="px-6 py-2.5 rounded-lg text-sm font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 transition-colors">
          Regenerate
        </button>
        <button onClick={onDiscard}
          className="px-6 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:text-red-500 transition-colors">
          Discard
        </button>
      </div>
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
            rows={3} value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="How did it go? Any notes for next time…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
          />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex gap-3">
          <button onClick={submit} disabled={logging}
            className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {logging ? 'Logging…' : 'Mark Complete'}
          </button>
          <button onClick={onClose}
            className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Program Description (collapsible) ─────────────────────────────────────────

function ProgramDescription({ text }) {
  const LIMIT = 150
  const [expanded, setExpanded] = useState(false)
  if (!text) return null
  if (text.length <= LIMIT) return <p className="text-sm text-gray-500 mt-1">{text}</p>
  return (
    <div className="mt-1">
      <p className="text-sm text-gray-500">{expanded ? text : `${text.slice(0, LIMIT)}…`}</p>
      <button onClick={() => setExpanded(e => !e)}
        className="text-xs text-[#E8670A] font-medium mt-0.5 hover:text-[#c45e09] transition-colors">
        {expanded ? 'Read less' : 'Read more'}
      </button>
    </div>
  )
}

// ── Program Detail — read-only client view ────────────────────────────────────

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

  // Group exercises by day, sorted by sort_order then id
  const days = exercises.reduce((acc, ex) => {
    if (!acc[ex.day]) acc[ex.day] = []
    acc[ex.day].push(ex)
    return acc
  }, {})
  Object.values(days).forEach(exs =>
    exs.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
  )

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
            <p className="text-sm font-semibold text-white">{formatDayLabel(dayName)}</p>
          </div>

          {/* Mobile cards — read-only */}
          <div className="lg:hidden divide-y divide-gray-100">
            {exs.map(ex => (
              <div key={ex.id} className="p-4">
                <div className="flex items-center gap-3 mb-3">
                  <ExerciseThumb src={ex.image_url} alt={ex.exercise_name} />
                  <p className="text-sm font-semibold text-gray-900">{ex.exercise_name}</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[['Sets', ex.sets], ['Reps', ex.reps], ['Weight', ex.weight], ['Rest', ex.rest_seconds ? `${ex.rest_seconds}s` : null]].map(([label, val]) => (
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
                    <td className="px-4 py-3 font-medium text-gray-900">
                      <div className="flex items-center gap-3">
                        <ExerciseThumb src={ex.image_url} alt={ex.exercise_name} />
                        <span>{ex.exercise_name}</span>
                      </div>
                    </td>
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

function ProgramList({ programs, onSelect, onNew }) {
  if (programs.length === 0) {
    return (
      <div className="max-w-xl">
        <div className="text-center py-16">
          <p className="text-4xl mb-3">💪</p>
          <p className="text-sm font-semibold text-gray-700 mb-1">No programs yet</p>
          <p className="text-xs text-gray-400 mb-6">
            Let Katie build you a personalized weekly workout program — your coach can customize it after.
          </p>
          <button onClick={onNew}
            className="bg-[#E8670A] text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors">
            Build My Program with Katie
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{programs.length} saved program{programs.length !== 1 ? 's' : ''}</p>
        <button onClick={onNew}
          className="bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors">
          + New Program
        </button>
      </div>

      {programs.map(program => (
        <button key={program.id} onClick={() => onSelect(program)}
          className="w-full text-left bg-white rounded-xl border border-gray-200 p-5 hover:border-[#E8670A] hover:shadow-sm transition-all">
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
                  <span>Last: {new Date(program.last_logged_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
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
  const [view,      setView]      = useState('loading')
  const [programs,  setPrograms]  = useState([])
  const [selected,  setSelected]  = useState(null)
  const [generated, setGenerated] = useState(null)
  const [genForm,   setGenForm]   = useState(null)

  const loadPrograms = useCallback(async () => {
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/workouts`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const data = await res.json()
      setPrograms(data)
      setView(data.length > 0 ? 'list' : 'questionnaire')
    } catch {
      setView('questionnaire')
    }
  }, [getToken])

  useEffect(() => { loadPrograms() }, [loadPrograms])

  function handleGenerated(plan, form) {
    setGenerated(plan); setGenForm(form); setView('review')
  }

  function handleSaved(program) {
    setPrograms(prev => [program, ...prev])
    setSelected(program)
    setView('detail')
    setGenerated(null); setGenForm(null)
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Workouts</h1>
      <p className="text-sm text-gray-500 mb-6">AI-generated weekly programs built by Coach Katie</p>

      {view === 'loading' && <p className="text-sm text-gray-400">Loading…</p>}

      {view === 'questionnaire' && (
        <Questionnaire onGenerate={handleGenerated} />
      )}

      {view === 'review' && generated && (
        <PlanReview
          plan={generated}
          form={genForm}
          onSave={handleSaved}
          onRegenerate={() => setView('questionnaire')}
          onDiscard={() => setView(programs.length > 0 ? 'list' : 'questionnaire')}
        />
      )}

      {view === 'list' && (
        <ProgramList
          programs={programs}
          onSelect={(p) => { setSelected(p); setView('detail') }}
          onNew={() => setView('questionnaire')}
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
