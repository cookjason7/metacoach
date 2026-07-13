import { useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

const SESSION_LENGTHS = [20, 30, 45, 60, 90]
const GOALS = ['strength', 'power', 'hypertrophy', 'endurance']
const LEVELS = ['beginner', 'intermediate', 'advanced']
const EQUIPMENT_OPTIONS = [
  'bodyweight',
  'dumbbell',
  'kettlebell',
  'barbell',
  'bench',
  'cable',
  'trx',
  'pull_up_bar',
  'mini_band',
  'big_band',
  'medicine_ball',
  'foam_roller',
]

const PLACEHOLDER_COPY = 'empty - to be filled in by your coach'

function formatEquipment(exercise) {
  const equipment = exercise?.equipment_required ?? []
  return equipment.length ? equipment.join(', ') : 'bodyweight'
}

function formatPrescription(prescription) {
  if (!prescription) return ''
  if (typeof prescription === 'string') return prescription
  if (prescription.sets && prescription.repRange) return `${prescription.sets} x ${prescription.repRange}`
  if (prescription.sets && prescription.reps) return `${prescription.sets} x ${prescription.reps}`
  return Object.values(prescription).filter(Boolean).join(' ')
}

function ExerciseList({ items, placeholder = false }) {
  if (!items?.length) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-500">
        {placeholder ? PLACEHOLDER_COPY : 'No exercises selected for these settings.'}
      </div>
    )
  }

  return (
    <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
      {items.map((item, index) => (
        <li key={`${item.exercise?.name ?? 'exercise'}-${index}`} className="p-3 sm:flex sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <p className="font-semibold text-gray-900">{item.exercise?.name ?? 'Unnamed exercise'}</p>
            {item.movementPattern && (
              <p className="mt-0.5 text-xs uppercase tracking-wide text-gray-400">{item.movementPattern}</p>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500 sm:mt-0 sm:text-right">
            {formatEquipment(item.exercise)}
            {formatPrescription(item.prescription) ? ` - ${formatPrescription(item.prescription)}` : ''}
          </p>
        </li>
      ))}
    </ul>
  )
}

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-gray-900">{title}</h2>
      {children}
    </section>
  )
}

function Block({ title, items, placeholder = false }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">{title}</h3>
      <ExerciseList items={items} placeholder={placeholder} />
    </div>
  )
}

export default function WorkoutBuilderPreview() {
  const { getToken } = useAuth()
  const [sessionLength, setSessionLength] = useState(60)
  const [goal, setGoal] = useState('hypertrophy')
  const [level, setLevel] = useState('advanced')
  const [dayLabel, setDayLabel] = useState('')
  const [rotationIndex, setRotationIndex] = useState(0)
  const [equipment, setEquipment] = useState(['bodyweight', 'dumbbell', 'bench', 'mini_band'])
  const [session, setSession] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function toggleEquipment(token) {
    setEquipment(prev => {
      if (token === 'bodyweight') return ['bodyweight', ...prev.filter(item => item !== 'bodyweight')]
      return prev.includes(token) ? prev.filter(item => item !== token) : [...prev, token]
    })
  }

  async function loadSession() {
    setLoading(true)
    setError('')
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

      const res = await fetch(`${API_URL}/api/workout-builder/my-session?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
      setSession(body)
    } catch (err) {
      setSession(null)
      setError(err.message || 'Unable to assemble workout.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl pb-24">
      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wide text-[#f97316]">Client preview test</p>
        <h1 className="mt-1 text-2xl font-bold text-[#1e2a3a] sm:text-3xl">Rules-Based Workout Builder</h1>
        <p className="mt-2 max-w-3xl text-sm text-gray-600">
          This test page assembles a workout from the new rules engine. It is separate from the current Coach Katie workouts flow and does not save anything.
        </p>
      </div>

      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="space-y-1">
            <span className="text-xs font-semibold text-gray-500">Length</span>
            <select value={sessionLength} onChange={e => setSessionLength(Number(e.target.value))} className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 text-sm">
              {SESSION_LENGTHS.map(value => <option key={value} value={value}>{value} min</option>)}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold text-gray-500">Goal</span>
            <select value={goal} onChange={e => setGoal(e.target.value)} className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 text-sm">
              {GOALS.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold text-gray-500">Level</span>
            <select value={level} onChange={e => setLevel(e.target.value)} className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 text-sm">
              {LEVELS.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold text-gray-500">Day</span>
            <select value={dayLabel} onChange={e => setDayLabel(e.target.value)} className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 text-sm">
              <option value="">Auto</option>
              <option value="A">A</option>
              <option value="B">B</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold text-gray-500">Rotation</span>
            <input
              type="number"
              min="0"
              value={rotationIndex}
              onChange={e => setRotationIndex(Math.max(0, Number(e.target.value) || 0))}
              className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 text-sm"
            />
          </label>
        </div>

        <div className="mt-4">
          <p className="text-xs font-semibold text-gray-500">Equipment</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {EQUIPMENT_OPTIONS.map(token => {
              const active = equipment.includes(token)
              return (
                <button
                  key={token}
                  type="button"
                  onClick={() => toggleEquipment(token)}
                  className={`min-h-[44px] rounded-full border px-3 text-xs font-bold transition-colors ${
                    active
                      ? 'border-[#f97316] bg-orange-50 text-[#c2410c]'
                      : 'border-gray-200 bg-gray-50 text-gray-600'
                  }`}
                >
                  {token}
                </button>
              )
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={loadSession}
          disabled={loading}
          className="mt-5 min-h-[44px] w-full rounded-lg bg-[#f97316] px-5 text-sm font-bold text-white disabled:opacity-60 sm:w-auto"
        >
          {loading ? 'Building workout...' : 'Build preview workout'}
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {session && (
        <div className="space-y-8">
          <div className="rounded-xl bg-[#1e2a3a] p-4 text-white">
            <p className="text-sm font-semibold">
              Day {session.dayLabel} - {session.sessionLength} minutes - {session.goal} - {session.level}
            </p>
          </div>

          {session.warnings?.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {session.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
            </div>
          )}

          <Section title="Warm-Up">
            <div className="grid gap-4 lg:grid-cols-2">
              <Block title="Foam Roll" items={session.warmup.foam_roll} placeholder />
              <Block title="Mobility" items={session.warmup.mobility} />
              <Block title="Activation" items={session.warmup.activation} placeholder />
              <Block title="Bands" items={session.warmup.bands} />
              <Block title="Plyo" items={session.warmup.plyo} />
            </div>
          </Section>

          <Section title="Main Circuit">
            <ExerciseList items={session.main} />
          </Section>

          <Section title="Cooldown">
            <div className="grid gap-4 lg:grid-cols-2">
              <Block title="Core" items={session.cooldown.core} />
              <Block title="Stretch" items={session.cooldown.stretch} placeholder />
              <Block title="Finisher" items={session.cooldown.finisher} placeholder />
            </div>
          </Section>
        </div>
      )}
    </div>
  )
}
