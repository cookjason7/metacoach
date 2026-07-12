import { useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../../config.js'

// Admin-only QA tool for GET /api/workout-builder/session (server/routes/workoutBuilder.js).
// Purely a way to eyeball what the rule-based session assembler (server/services/workoutAssembly)
// actually returns for a given profile — not a client-facing feature, and does not touch the
// existing Katie-generated Workouts flow at all.

const SESSION_LENGTHS = [20, 30, 45, 60, 90]
const GOALS = ['strength', 'power', 'hypertrophy', 'endurance']
const LEVELS = ['beginner', 'intermediate', 'advanced']
// Every equipment_required token currently seeded in exercise_library.
const EQUIPMENT_OPTIONS = [
  'bodyweight', 'barbell', 'dumbbell', 'kettlebell', 'bench', 'cable', 'trap_bar',
  'trx', 'pull_up_bar', 'yoke', 'mini_band', 'big_band', 'foam_roller', 'tennis_ball',
  'medicine_ball', 'pvc_stick',
]

function formatPrescription(p) {
  if (p == null) return '—'
  if (typeof p === 'string') return p
  return `${p.sets} x ${p.repRange}`
}

function ExerciseRow({ item }) {
  const eq = item.exercise.equipment_required
  return (
    <li className="flex items-start justify-between gap-3 py-1.5 text-sm border-b border-gray-100 last:border-0">
      <span className="text-gray-800">{item.exercise.name}</span>
      <span className="text-gray-400 text-xs shrink-0 text-right">
        {eq.length ? eq.join(', ') : 'bodyweight'} · {formatPrescription(item.prescription)}
      </span>
    </li>
  )
}

function WarmupBlock({ label, items }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      {items.length === 0 ? (
        <p className="text-xs text-gray-400 italic py-1">(none picked)</p>
      ) : (
        <ul>{items.map((item, i) => <ExerciseRow key={i} item={item} />)}</ul>
      )}
    </div>
  )
}

function MainSlot({ slot, mismatched }) {
  const eq = slot.exercise.equipment_required
  return (
    <li className="flex items-start justify-between gap-3 py-2 border-b border-gray-100 last:border-0">
      <div>
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mr-2">{slot.movementPattern}</span>
        <span className="text-sm text-gray-800">{slot.exercise.name}</span>
        {mismatched && (
          <span className="ml-2 text-[10px] font-semibold bg-red-50 text-red-600 border border-red-200 rounded-full px-2 py-0.5">
            equipment mismatch
          </span>
        )}
      </div>
      <span className="text-gray-400 text-xs shrink-0 text-right">
        {eq.length ? eq.join(', ') : 'bodyweight'} · {formatPrescription(slot.prescription)}
      </span>
    </li>
  )
}

export default function WorkoutBuilderTest() {
  const { getToken } = useAuth()

  const [sessionLength, setSessionLength] = useState(60)
  const [goal, setGoal] = useState('hypertrophy')
  const [level, setLevel] = useState('advanced')
  const [dayLabel, setDayLabel] = useState('') // '' = auto from rotationIndex
  const [rotationIndex, setRotationIndex] = useState(0)
  const [equipment, setEquipment] = useState(['bodyweight'])

  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  function toggleEquipment(token) {
    setEquipment(prev => prev.includes(token) ? prev.filter(e => e !== token) : [...prev, token])
  }

  async function runAssembly() {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const params = new URLSearchParams({
        sessionLength: String(sessionLength),
        goal,
        level,
        rotationIndex: String(rotationIndex),
        equipment: equipment.join(','),
      })
      if (dayLabel) params.set('dayLabel', dayLabel)

      const res = await fetch(`${API_URL}/api/workout-builder/session?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      setResult(body)
    } catch (err) {
      setError(err.message)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-3xl mx-auto pb-10">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Workout Builder Test</h1>
        <p className="text-sm text-gray-500 mt-1">
          QA tool — calls GET /api/workout-builder/session directly and shows the assembled
          session. Rule-based only (exercise_library / program_day_patterns / volume_rules /
          program_templates), no Katie/AI involvement, nothing saved. Doesn't touch the
          client-facing Workouts flow.
        </p>
      </div>

      {/* Form */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Session length</label>
            <select value={sessionLength} onChange={e => setSessionLength(Number(e.target.value))}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
              {SESSION_LENGTHS.map(v => <option key={v} value={v}>{v} min</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Goal</label>
            <select value={goal} onChange={e => setGoal(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
              {GOALS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Level</label>
            <select value={level} onChange={e => setLevel(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
              {LEVELS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Day label</label>
            <select value={dayLabel} onChange={e => setDayLabel(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
              <option value="">Auto (from rotation index)</option>
              <option value="A">A</option>
              <option value="B">B</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Rotation index</label>
            <input type="number" min={0} value={rotationIndex}
              onChange={e => setRotationIndex(Math.max(0, Number(e.target.value) || 0))}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
        </div>

        <div className="mt-4">
          <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Equipment</label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {EQUIPMENT_OPTIONS.map(token => {
              const active = equipment.includes(token)
              return (
                <button
                  key={token}
                  type="button"
                  onClick={() => toggleEquipment(token)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                    active
                      ? 'bg-orange-50 text-[#c45e09] border-orange-200'
                      : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  {token}
                </button>
              )
            })}
          </div>
        </div>

        <button onClick={runAssembly} disabled={loading}
          className="mt-4 bg-[#E8670A] text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[#c45e09] transition-colors disabled:opacity-50 min-h-[40px]">
          {loading ? 'Assembling…' : 'Assemble session'}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</p>
      )}

      {result && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-700">
              Day {result.dayLabel} · {result.sessionLength} min · {result.goal} · {result.level}
            </p>
          </div>

          {result.warnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide mb-1">Warnings</p>
              <ul className="text-xs text-amber-800 space-y-0.5">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <p className="text-sm font-bold text-gray-900 mb-2">Warm-up</p>
            <div className="space-y-3">
              <WarmupBlock label="Foam roll (coach-editable — not auto-picked)" items={result.warmup.foam_roll} />
              <WarmupBlock label="Mobility" items={result.warmup.mobility} />
              <WarmupBlock label="Activation (coach-editable — not auto-picked)" items={result.warmup.activation} />
              <WarmupBlock label="Bands" items={result.warmup.bands} />
              <WarmupBlock label="Plyo" items={result.warmup.plyo} />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <p className="text-sm font-bold text-gray-900 mb-2">Main lift + accessory work (circuit)</p>
            <ul>
              {result.main.map((slot, i) => (
                <MainSlot key={i} slot={slot}
                  mismatched={result.warnings.some(w => w.includes(`"${slot.movementPattern}"`))} />
              ))}
            </ul>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <p className="text-sm font-bold text-gray-900 mb-2">Cooldown</p>
            <div className="space-y-3">
              <WarmupBlock label="Core" items={result.cooldown.core} />
              <WarmupBlock label="Stretch (coach-editable — not auto-picked)" items={result.cooldown.stretch} />
              <WarmupBlock label="Finisher (coach-editable — not auto-picked)" items={result.cooldown.finisher} />
            </div>
          </div>

          <p className="text-[11px] text-gray-400">
            Note: Foam roll, Activation, Stretch, and Finisher are intentionally always
            empty — coach-editable placeholders, not auto-picked by the rules engine.
            Everything else above is real rule-based selection.
          </p>
        </div>
      )}
    </div>
  )
}
