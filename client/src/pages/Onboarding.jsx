import { useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'
import { API_URL } from '../config.js'

const TRAITS = [
  "Shows up when it's inconvenient, not just when it's easy",
  'Keeps small promises to herself daily',
  'Reaches out for help before she spirals, instead of disappearing in shame',
  "Makes mistakes and learns from them, instead of using them as proof she's broken",
  'Stops hunting for the perfect plan and commits to consistent action with an imperfect one',
  'Invests in herself fully: mentally, physically, emotionally, and financially',
  'Leads by example for her family, instead of putting herself last forever',
  'Supports other Life Warriors, because she knows isolation is where she used to quit',
  'Takes responsibility for her actions, not excuses',
  'Gets comfortable being uncomfortable, because change feels weird before it feels good',
]

const ACTIVITY_LEVELS = [
  { value: 'sedentary',         label: 'Sedentary',          description: 'Little or no exercise' },
  { value: 'lightly_active',    label: 'Lightly Active',     description: 'Light exercise 1–3 days/week' },
  { value: 'moderately_active', label: 'Moderately Active',  description: 'Moderate exercise 3–5 days/week' },
  { value: 'very_active',       label: 'Very Active',        description: 'Hard exercise 6–7 days/week' },
]

const TOTAL_STEPS = 3

function ProgressBar({ step }) {
  return (
    <div className="flex gap-2 mb-8">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 flex-1 rounded-full transition-colors ${
            i < step ? 'bg-[#E8670A]' : 'bg-gray-200'
          }`}
        />
      ))}
    </div>
  )
}

export default function Onboarding() {
  const { getToken } = useAuth()
  const navigate = useNavigate()

  const [step, setStep]     = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const [form, setForm] = useState({
    first_name:          '',
    last_name:           '',
    gender:              '',
    age:                 '',
    height_feet:         '5',
    height_in:           '4',
    starting_weight_lbs: '',
    goal_weight_lbs:     '',
    activity_level:      '',
    tried_before:        '',
    why_joined:          '',
    identity_anchors:    [],
  })

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  function toggleTrait(trait) {
    setForm((f) => {
      const current = f.identity_anchors
      if (current.includes(trait)) return { ...f, identity_anchors: current.filter((t) => t !== trait) }
      if (current.length >= 2) return f
      return { ...f, identity_anchors: [...current, trait] }
    })
  }

  function canAdvance() {
    if (step === 1) return form.age && form.starting_weight_lbs && form.goal_weight_lbs
    if (step === 2) return form.activity_level && form.tried_before.trim() && form.why_joined.trim()
    if (step === 3) return form.identity_anchors.length === 2
    return false
  }

  async function submit() {
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const height_inches = parseInt(form.height_feet, 10) * 12 + parseInt(form.height_in, 10)
      const res = await fetch(`${API_URL}/api/users/me`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name:          form.first_name,
          last_name:           form.last_name,
          gender:              form.gender,
          age:                 Number(form.age),
          height_inches,
          starting_weight_lbs: Number(form.starting_weight_lbs),
          goal_weight_lbs:     Number(form.goal_weight_lbs),
          activity_level:      form.activity_level,
          tried_before:        form.tried_before,
          why_joined:          form.why_joined,
          identity_anchors:    form.identity_anchors,
          onboarding_complete: true,
        }),
      })
      if (!res.ok) throw new Error('Failed to save profile')
      window.__userState = { onboardingComplete: true, paid: false }
      navigate('/payment', { replace: true })
      // No finally reset — on success the component unmounts immediately via navigate
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-lg p-8">

        <ProgressBar step={step} />

        {/* ── Step 1: Basic Info ── */}
        {step === 1 && (
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Welcome to WarriorFIT AI</h1>
            <p className="text-sm text-gray-500 mb-6">Let's start with the basics.</p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Gender</label>
                <div className="flex gap-3">
                  {['Male', 'Female'].map(g => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => set('gender', g.toLowerCase())}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        form.gender === g.toLowerCase()
                          ? 'bg-[#E8670A] text-white border-[#E8670A]'
                          : 'bg-white text-gray-600 border-gray-300 hover:border-[#E8670A]'
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Age</label>
                <input
                  type="number"
                  min="13"
                  max="100"
                  value={form.age}
                  onChange={(e) => set('age', e.target.value)}
                  placeholder="32"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Height</label>
                <div className="grid grid-cols-2 gap-3">
                  <select
                    value={form.height_feet}
                    onChange={(e) => set('height_feet', e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
                  >
                    {[4, 5, 6, 7].map((f) => (
                      <option key={f} value={f}>{f} ft</option>
                    ))}
                  </select>
                  <select
                    value={form.height_in}
                    onChange={(e) => set('height_in', e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
                  >
                    {Array.from({ length: 12 }, (_, i) => i).map((i) => (
                      <option key={i} value={i}>{i} in</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Starting weight (lbs)</label>
                  <input
                    type="number"
                    min="50"
                    value={form.starting_weight_lbs}
                    onChange={(e) => set('starting_weight_lbs', e.target.value)}
                    placeholder="180"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Goal weight (lbs)</label>
                  <input
                    type="number"
                    min="50"
                    value={form.goal_weight_lbs}
                    onChange={(e) => set('goal_weight_lbs', e.target.value)}
                    placeholder="155"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Background ── */}
        {step === 2 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-1">Your background</h2>
            <p className="text-sm text-gray-500 mb-6">Help us understand where you're coming from.</p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Activity level</label>
                <div className="space-y-2">
                  {ACTIVITY_LEVELS.map(({ value, label, description }) => (
                    <label
                      key={value}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        form.activity_level === value
                          ? 'border-[#E8670A] bg-[#fff7ed]'
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="activity_level"
                        value={value}
                        checked={form.activity_level === value}
                        onChange={() => set('activity_level', value)}
                        className="mt-0.5 accent-[#E8670A]"
                      />
                      <span>
                        <span className="text-sm font-medium text-gray-900">{label}</span>
                        <span className="text-xs text-gray-400 block">{description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  What have you tried before that didn't work?
                </label>
                <textarea
                  rows={2}
                  value={form.tried_before}
                  onChange={(e) => set('tried_before', e.target.value)}
                  placeholder="e.g. I tried keto but couldn't sustain it..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Why did you join WarriorFIT AI?</label>
                <textarea
                  rows={2}
                  value={form.why_joined}
                  onChange={(e) => set('why_joined', e.target.value)}
                  placeholder="e.g. I want to finally build a sustainable relationship with food..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
                />
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: Identity Anchors ── */}
        {step === 3 && (
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-1">Your Life Warrior identity</h2>
            <p className="text-sm text-gray-500 mb-1">Choose exactly 2 traits that feel most true to who you're becoming.</p>
            <p className="text-xs text-[#E8670A] font-medium mb-5">
              {form.identity_anchors.length}/2 selected
            </p>

            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {TRAITS.map((trait) => {
                const selected  = form.identity_anchors.includes(trait)
                const maxed     = form.identity_anchors.length >= 2
                const disabled  = !selected && maxed

                return (
                  <label
                    key={trait}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selected   ? 'border-[#E8670A] bg-[#fff7ed]'
                      : disabled ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                                 : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={disabled}
                      onChange={() => toggleTrait(trait)}
                      className="mt-0.5 accent-[#E8670A]"
                    />
                    <span className="text-sm text-gray-800 leading-snug">{trait}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Navigation ── */}
        {error && (
          <p className="mt-4 text-sm text-red-600">{error}</p>
        )}

        <div className="flex justify-between mt-8">
          {step > 1 ? (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              ← Back
            </button>
          ) : (
            <span />
          )}

          {step < TOTAL_STEPS ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canAdvance()}
              className="bg-[#E8670A] text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next →
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canAdvance() || saving}
              className="bg-[#E8670A] text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving…' : "Let's Go →"}
            </button>
          )}
        </div>

      </div>
    </div>
  )
}
