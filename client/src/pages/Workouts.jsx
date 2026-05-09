import { useState, useCallback, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

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
  equipment: 'Full gym',
  injuries: '',
  fitness_level: 'Intermediate',
}

// ── Questionnaire ─────────────────────────────────────────────────────────────

function Questionnaire({ onGenerate }) {
  const [form,      setForm]      = useState({ ...EMPTY_FORM })
  const [generating, setGenerating] = useState(false)
  const [error,      setError]     = useState(null)
  const { getToken } = useAuth()

  function toggleGoal(id) {
    setForm(f => ({
      ...f,
      goals: f.goals.includes(id) ? f.goals.filter(g => g !== id) : [...f.goals, id],
    }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.goals.length) { setError('Please select at least one goal.'); return }
    setGenerating(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/workouts/generate`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          days_per_week: parseInt(form.days_per_week, 10),
        }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || `Server error ${res.status}`)
      }
      const plan = await res.json()
      onGenerate(plan, form)
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
          Tell me a bit about your goals and I'll build you a custom weekly workout program. Let's go!
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Goals */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            What are your fitness goals? <span className="text-red-400">*</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {GOALS.map(g => (
              <button
                key={g.id}
                type="button"
                onClick={() => toggleGoal(g.id)}
                className={pillCls(form.goals.includes(g.id))}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

        {/* Days per week */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Training days per week
          </label>
          <div className="flex gap-2 flex-wrap">
            {[2, 3, 4, 5, 6].map(n => (
              <button
                key={n}
                type="button"
                onClick={() => setForm(f => ({ ...f, days_per_week: String(n) }))}
                className={pillCls(form.days_per_week === String(n))}
              >
                {n} days
              </button>
            ))}
          </div>
        </div>

        {/* Session length */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Session length
          </label>
          <div className="flex gap-2 flex-wrap">
            {SESSION_LENGTHS.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setForm(f => ({ ...f, session_length: s }))}
                className={pillCls(form.session_length === s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Equipment */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Available equipment
          </label>
          <div className="flex gap-2 flex-wrap">
            {EQUIPMENT_OPTIONS.map(eq => (
              <button
                key={eq}
                type="button"
                onClick={() => setForm(f => ({ ...f, equipment: eq }))}
                className={pillCls(form.equipment === eq)}
              >
                {eq}
              </button>
            ))}
          </div>
        </div>

        {/* Fitness level */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Fitness level
          </label>
          <div className="flex gap-2">
            {FITNESS_LEVELS.map(lvl => (
              <button
                key={lvl}
                type="button"
                onClick={() => setForm(f => ({ ...f, fitness_level: lvl }))}
                className={pillCls(form.fitness_level === lvl)}
              >
                {lvl}
              </button>
            ))}
          </div>
        </div>

        {/* Injuries */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">
            Injuries or limitations <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={form.injuries}
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

// ── Plan Review ───────────────────────────────────────────────────────────────

function PlanReview({ plan, form, onSave, onRegenerate, onDiscard }) {
  const { getToken } = useAuth()
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/workouts`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(plan),
      })
      if (!res.ok) throw new Error('Failed to save program')
      const saved = await res.json()
      onSave(saved)
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
      </div>

      {plan.days?.map((day, di) => (
        <div key={di} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-[#0F1E35] px-5 py-3">
            <p className="text-sm font-semibold text-white">{day.day_name}</p>
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
          onClick={save}
          disabled={saving}
          className="bg-[#E8670A] text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors flex items-center gap-2"
        >
          {saving ? (
            <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Saving…</>
          ) : 'Save Program'}
        </button>
        <button
          onClick={onRegenerate}
          className="px-6 py-2.5 rounded-lg text-sm font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 transition-colors"
        >
          Regenerate
        </button>
        <button
          onClick={onDiscard}
          className="px-6 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:text-red-500 transition-colors"
        >
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
    setLogging(true)
    setError(null)
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
            placeholder="How did it feel? Any PRs? Notes for next time…"
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

// ── Program Detail ────────────────────────────────────────────────────────────

function ProgramDetail({ program, onBack, onDeleted }) {
  const { getToken } = useAuth()
  const [exercises,  setExercises]  = useState([])
  const [logs,       setLogs]       = useState([])
  const [loading,    setLoading]    = useState(true)
  const [showLog,    setShowLog]    = useState(false)
  const [loggedAt,   setLoggedAt]   = useState(null)
  const [deleting,   setDeleting]   = useState(false)
  const [editCell,   setEditCell]   = useState(null)  // { exId, field }
  const [editVal,    setEditVal]    = useState('')
  const [cellSaving, setCellSaving] = useState(false)

  function startCellEdit(exId, field, currentVal) {
    setEditCell({ exId, field })
    setEditVal(currentVal != null ? String(currentVal) : '')
  }

  function cancelCellEdit() { setEditCell(null) }

  async function saveCellEdit(exId, field) {
    setCellSaving(true)
    try {
      const token = await getToken()
      const body  = field === 'sets'
        ? { sets: editVal !== '' ? Number(editVal) : null }
        : { [field]: editVal !== '' ? editVal : null }
      const res   = await fetch(`${API_URL}/api/workouts/exercises/${exId}`, {
        method:  'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (res.ok) {
        const updated = await res.json()
        setExercises(prev => prev.map(e => e.id === exId ? { ...e, ...updated } : e))
      }
    } finally {
      setCellSaving(false)
      setEditCell(null)
    }
  }

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/workouts/${program.id}`, { headers: { Authorization: `Bearer ${token}` } })
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

  async function deleteProgram() {
    if (!window.confirm('Delete this program?')) return
    setDeleting(true)
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/workouts/${program.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      onDeleted(program.id)
    } catch {
      setDeleting(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      {showLog && (
        <LogModal program={program} onClose={() => setShowLog(false)} onLogged={handleLogged} />
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600 mb-2 flex items-center gap-1">
            ← All Programs
          </button>
          <h2 className="text-xl font-bold text-gray-900">{program.name}</h2>
          {program.description && <p className="text-sm text-gray-500 mt-1">{program.description}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => setShowLog(true)}
            className="bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
          >
            Log Workout
          </button>
          <button
            onClick={deleteProgram}
            disabled={deleting}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 border border-gray-200 hover:text-red-500 hover:border-red-200 disabled:opacity-60 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {loggedAt && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700">
          Workout logged!
        </div>
      )}

      {loading && <p className="text-sm text-gray-400 py-10 text-center">Loading…</p>}

      {!loading && Object.entries(days).map(([dayName, exs]) => (
        <div key={dayName} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-[#0F1E35] px-5 py-3">
            <p className="text-sm font-semibold text-white">{dayName}</p>
          </div>

          {/* ── Mobile cards (tap any value to edit inline, save on blur) ── */}
          <div className="lg:hidden divide-y divide-gray-100">
            {exs.map(ex => {
              const isEditingName = editCell?.exId === ex.id && editCell?.field === 'exercise_name'
              return (
                <div key={ex.id} className="p-4">
                  {/* Exercise name */}
                  {isEditingName ? (
                    <input
                      autoFocus
                      value={editVal}
                      onChange={e => setEditVal(e.target.value)}
                      onBlur={() => saveCellEdit(ex.id, 'exercise_name')}
                      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') cancelCellEdit() }}
                      className="w-full border-2 border-[#E8670A] rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none mb-3"
                    />
                  ) : (
                    <button
                      onClick={() => startCellEdit(ex.id, 'exercise_name', ex.exercise_name)}
                      className="text-left w-full text-sm font-semibold text-gray-900 mb-3 min-h-[44px] flex items-center hover:text-[#E8670A] transition-colors"
                    >
                      {ex.exercise_name}
                    </button>
                  )}

                  {/* 2×2 stat chips — Sets/Reps top row, Weight/Rest bottom row */}
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: 'Sets',   field: 'sets',   val: ex.sets,   editable: true  },
                      { label: 'Reps',   field: 'reps',   val: ex.reps,   editable: true  },
                      { label: 'Weight', field: 'weight', val: ex.weight, editable: true  },
                      { label: 'Rest',   field: null,     val: ex.rest_seconds ? `${ex.rest_seconds}s` : null, editable: false },
                    ].map(({ label, field, val, editable }) => {
                      const isEditingChip = editable && editCell?.exId === ex.id && editCell?.field === field
                      return isEditingChip ? (
                        <div key={label} className="bg-orange-50 border border-[#E8670A] rounded-lg py-2 px-3 text-center">
                          <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">{label}</p>
                          <input
                            autoFocus
                            value={editVal}
                            onChange={e => setEditVal(e.target.value)}
                            onBlur={() => saveCellEdit(ex.id, field)}
                            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') cancelCellEdit() }}
                            className="w-full bg-transparent border-b border-[#E8670A] text-sm text-center focus:outline-none py-0.5"
                          />
                        </div>
                      ) : (
                        <button
                          key={label}
                          onClick={() => editable && startCellEdit(ex.id, field, val)}
                          disabled={!editable}
                          className={`rounded-lg py-3 px-3 text-center min-h-[44px] w-full transition-colors ${
                            editable ? 'bg-gray-50 hover:bg-orange-50 active:bg-orange-100' : 'bg-gray-50 cursor-default'
                          }`}
                        >
                          <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
                          <p className="text-sm font-medium text-gray-700 mt-0.5">{val ?? '—'}</p>
                        </button>
                      )
                    })}
                  </div>

                  {ex.notes && <p className="text-xs text-gray-400 mt-2 italic">{ex.notes}</p>}
                </div>
              )
            })}
          </div>

          {/* ── Desktop table (click any cell value to edit inline, save on blur) ── */}
          <div className="hidden lg:block">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Exercise</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-16">Sets</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-24">Reps</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-24">Weight</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-500 w-16">Rest</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {exs.map(ex => (
                  <tr key={ex.id} className="hover:bg-gray-50/30">
                    {/* Exercise name cell */}
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {editCell?.exId === ex.id && editCell?.field === 'exercise_name' ? (
                        <input
                          autoFocus value={editVal}
                          onChange={e => setEditVal(e.target.value)}
                          onBlur={() => saveCellEdit(ex.id, 'exercise_name')}
                          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') cancelCellEdit() }}
                          className="w-full border border-[#E8670A] rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[#E8670A]"
                        />
                      ) : (
                        <span
                          onClick={() => startCellEdit(ex.id, 'exercise_name', ex.exercise_name)}
                          className="cursor-pointer hover:text-[#E8670A] transition-colors"
                          title="Click to edit"
                        >{ex.exercise_name}</span>
                      )}
                    </td>
                    {/* Sets */}
                    <td className="px-3 py-3 text-center text-gray-600">
                      {editCell?.exId === ex.id && editCell?.field === 'sets' ? (
                        <input
                          autoFocus type="number" min="0" value={editVal}
                          onChange={e => setEditVal(e.target.value)}
                          onBlur={() => saveCellEdit(ex.id, 'sets')}
                          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') cancelCellEdit() }}
                          className="w-14 border border-[#E8670A] rounded px-1 py-1 text-xs text-center focus:outline-none"
                        />
                      ) : (
                        <span onClick={() => startCellEdit(ex.id, 'sets', ex.sets)} className="cursor-pointer hover:text-[#E8670A] transition-colors" title="Click to edit">
                          {ex.sets ?? '—'}
                        </span>
                      )}
                    </td>
                    {/* Reps */}
                    <td className="px-3 py-3 text-center text-gray-600">
                      {editCell?.exId === ex.id && editCell?.field === 'reps' ? (
                        <input
                          autoFocus value={editVal}
                          onChange={e => setEditVal(e.target.value)}
                          onBlur={() => saveCellEdit(ex.id, 'reps')}
                          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') cancelCellEdit() }}
                          className="w-20 border border-[#E8670A] rounded px-1 py-1 text-xs text-center focus:outline-none"
                        />
                      ) : (
                        <span onClick={() => startCellEdit(ex.id, 'reps', ex.reps)} className="cursor-pointer hover:text-[#E8670A] transition-colors" title="Click to edit">
                          {ex.reps ?? '—'}
                        </span>
                      )}
                    </td>
                    {/* Weight */}
                    <td className="px-3 py-3 text-center text-gray-600">
                      {editCell?.exId === ex.id && editCell?.field === 'weight' ? (
                        <input
                          autoFocus value={editVal}
                          onChange={e => setEditVal(e.target.value)}
                          onBlur={() => saveCellEdit(ex.id, 'weight')}
                          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') cancelCellEdit() }}
                          className="w-20 border border-[#E8670A] rounded px-1 py-1 text-xs text-center focus:outline-none"
                          placeholder="lbs"
                        />
                      ) : (
                        <span onClick={() => startCellEdit(ex.id, 'weight', ex.weight)} className="cursor-pointer hover:text-[#E8670A] transition-colors" title="Click to edit">
                          {ex.weight ?? '—'}
                        </span>
                      )}
                    </td>
                    {/* Rest — display only */}
                    <td className="px-3 py-3 text-center text-gray-400 text-xs">
                      {ex.rest_seconds ? `${ex.rest_seconds}s` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">{ex.notes ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cellSaving && (
              <p className="text-[10px] text-gray-400 px-4 py-1">Saving…</p>
            )}
          </div>
        </div>
      ))}

      {!loading && logs.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Recent logs</p>
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

function ProgramList({ programs, onSelect, onNew, onDeleted }) {
  if (programs.length === 0) {
    return (
      <div className="max-w-xl">
        <div className="text-center py-16">
          <p className="text-4xl mb-3">💪</p>
          <p className="text-sm font-semibold text-gray-700 mb-1">No programs yet</p>
          <p className="text-xs text-gray-400 mb-6">Let Katie build you a personalized weekly workout plan.</p>
          <button
            onClick={onNew}
            className="bg-[#E8670A] text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
          >
            Build My Program
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{programs.length} saved program{programs.length !== 1 ? 's' : ''}</p>
        <button
          onClick={onNew}
          className="bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
        >
          + New Program
        </button>
      </div>

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
                  <span className="text-green-600 font-medium">{program.log_count} workout{program.log_count !== 1 ? 's' : ''} logged</span>
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
    setGenerated(plan)
    setGenForm(form)
    setView('review')
  }

  function handleSaved(program) {
    setPrograms(prev => [program, ...prev])
    setSelected(program)
    setView('detail')
    setGenerated(null)
    setGenForm(null)
  }

  function handleDeleted(id) {
    const remaining = programs.filter(p => p.id !== id)
    setPrograms(remaining)
    setSelected(null)
    setView(remaining.length > 0 ? 'list' : 'questionnaire')
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
          onDeleted={handleDeleted}
        />
      )}

      {view === 'detail' && selected && (
        <ProgramDetail
          program={selected}
          onBack={() => setView('list')}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
