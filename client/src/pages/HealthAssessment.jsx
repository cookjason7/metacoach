import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, useUser } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

// ── Option data ──────────────────────────────────────────────────────────────

const SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']

const SLEEP_HOURS_OPTIONS = [
  { value: 'less_than_5', label: 'Under 5h' },
  { value: '5_to_6',      label: '5–6h' },
  { value: '6_to_7',      label: '6–7h' },
  { value: '7_to_8',      label: '7–8h' },
  { value: '8_to_9',      label: '8–9h' },
  { value: '9_plus',      label: '9h+' },
]

const WATER_OPTIONS = [
  { value: 'less_than_32',  label: '<32 oz' },
  { value: '32_to_64',      label: '32–64 oz' },
  { value: '64_to_96',      label: '64–96 oz' },
  { value: '96_to_128',     label: '96–128 oz' },
  { value: '128_plus',      label: '128 oz+' },
]

const ACTIVITY_OPTIONS = [
  { value: 'sedentary',         label: 'Sedentary' },
  { value: 'lightly_active',    label: 'Lightly Active' },
  { value: 'moderately_active', label: 'Moderately Active' },
  { value: 'very_active',       label: 'Very Active' },
  { value: 'extra_active',      label: 'Extra Active' },
]

// ── Sub-components ───────────────────────────────────────────────────────────

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-gray-800 mb-1">{label}</label>
      {hint && <p className="text-xs text-gray-400 mb-1.5">{hint}</p>}
      {children}
    </div>
  )
}

function TextInput({ value, onChange, placeholder, type = 'text', readOnly = false }) {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      readOnly={readOnly}
      className={`w-full border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] transition-colors ${
        readOnly
          ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed'
          : 'border-gray-300 bg-white text-gray-900 hover:border-gray-400'
      }`}
    />
  )
}

function TextArea({ value, onChange, placeholder, rows = 3 }) {
  return (
    <textarea
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      rows={rows}
      className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] transition-colors hover:border-gray-400 resize-none"
    />
  )
}

function RatingSelect({ value, onChange, lowLabel = 'Low', highLabel = 'High' }) {
  return (
    <div>
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`flex-1 h-11 rounded-xl text-sm font-bold border-2 transition-all ${
              value === n
                ? 'bg-[#E8670A] border-[#E8670A] text-white shadow-md scale-105'
                : 'border-gray-200 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] bg-white'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="flex justify-between mt-1.5 px-0.5">
        <span className="text-[11px] text-gray-400">{lowLabel}</span>
        <span className="text-[11px] text-gray-400">{highLabel}</span>
      </div>
    </div>
  )
}

function OptionPills({ value, onChange, options }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-4 py-2.5 rounded-xl text-sm font-medium border-2 transition-all min-h-[44px] ${
            value === opt.value
              ? 'bg-[#E8670A] border-[#E8670A] text-white shadow-sm'
              : 'border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A] bg-white'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function ButtonGroup({ value, onChange, options }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`px-3.5 py-2 rounded-xl text-sm font-semibold border-2 transition-all min-h-[44px] ${
            value === opt
              ? 'bg-[#E8670A] border-[#E8670A] text-white shadow-sm'
              : 'border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A] bg-white'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

// Progress bar at top of form steps
function StepProgress({ step }) {
  const steps = ['Contact', 'About You', 'Lifestyle']
  return (
    <div className="bg-[#1e2a3a] px-6 py-4">
      <div className="flex items-center justify-between relative">
        {/* connector lines */}
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 flex">
          {[0, 1].map(i => (
            <div
              key={i}
              className={`flex-1 h-0.5 transition-colors ${
                step > i + 1 ? 'bg-[#E8670A]' : 'bg-white/20'
              }`}
              style={{ marginLeft: i === 0 ? '14px' : '0', marginRight: i === 1 ? '14px' : '0' }}
            />
          ))}
        </div>
        {steps.map((label, i) => {
          const n = i + 1
          const active   = step === n
          const complete = step > n
          return (
            <div key={n} className="flex flex-col items-center gap-1 z-10">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all ${
                  complete
                    ? 'bg-[#E8670A] border-[#E8670A] text-white'
                    : active
                    ? 'bg-white border-white text-[#1e2a3a]'
                    : 'bg-transparent border-white/40 text-white/40'
                }`}
              >
                {complete ? '✓' : n}
              </div>
              <span
                className={`text-[10px] font-semibold transition-colors ${
                  active || complete ? 'text-white' : 'text-white/40'
                }`}
              >
                {label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

const EMPTY_FORM = {
  // S1
  first_name: '', last_name: '', phone: '', address: '',
  date_of_birth: '', shirt_size: '', coach_name: '',
  // S2
  supplements: '', goals_6_months: '', injuries_limitations: '',
  num_kids: '', occupation: '',
  // S3
  energy_level: null, sleep_hours: '', stress_management: null,
  sleep_quality: null, daily_water: '', alcohol_weekdays: '0',
  alcohol_weekends: '0', happiness_level: null, confidence_level: null,
  activity_level: '',
}

export default function HealthAssessment() {
  const { getToken } = useAuth()
  const { user }     = useUser()
  const navigate     = useNavigate()

  const [step,    setStep]    = useState(0) // 0=welcome, 1=S1, 2=S2, 3=S3, 4=complete
  const [form,    setForm]    = useState(EMPTY_FORM)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState(null)
  const [loaded,  setLoaded]  = useState(false)

  const email = user?.primaryEmailAddress?.emailAddress ?? ''

  // Load any existing partial assessment on mount
  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/health-assessment/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          if (data) {
            setForm({
              first_name:           data.first_name           ?? '',
              last_name:            data.last_name            ?? '',
              phone:                data.phone                ?? '',
              address:              data.address              ?? '',
              date_of_birth:        data.date_of_birth        ? data.date_of_birth.slice(0, 10) : '',
              shirt_size:           data.shirt_size           ?? '',
              coach_name:           data.coach_name           ?? '',
              supplements:          data.supplements          ?? '',
              goals_6_months:       data.goals_6_months       ?? '',
              injuries_limitations: data.injuries_limitations ?? '',
              num_kids:             data.num_kids             != null ? String(data.num_kids) : '',
              occupation:           data.occupation           ?? '',
              energy_level:         data.energy_level         ?? null,
              sleep_hours:          data.sleep_hours          ?? '',
              stress_management:    data.stress_management    ?? null,
              sleep_quality:        data.sleep_quality        ?? null,
              daily_water:          data.daily_water          ?? '',
              alcohol_weekdays:     data.alcohol_weekdays     != null ? String(data.alcohol_weekdays) : '0',
              alcohol_weekends:     data.alcohol_weekends     != null ? String(data.alcohol_weekends) : '0',
              happiness_level:      data.happiness_level      ?? null,
              confidence_level:     data.confidence_level     ?? null,
              activity_level:       data.activity_level       ?? '',
            })
          }
        }
      } catch {
        // silent — pre-fill is best-effort
      } finally {
        setLoaded(true)
      }
    }
    load()
  }, [getToken])

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }))
  }

  function setVal(field) {
    return val => setForm(f => ({ ...f, [field]: val }))
  }

  // Save current data to server (non-blocking unless completing)
  async function save(payload, completing = false) {
    try {
      const token = await getToken()
      const body = { ...payload }
      if (completing) body.completed = true
      await fetch(`${API_URL}/api/health-assessment`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
    } catch {
      // autosave failure is silent; final save shows error
    }
  }

  // ── Step navigation ──────────────────────────────────────────────────────────

  function handleWelcomeStart() {
    setStep(1)
  }

  function handleSection1Next() {
    // Autosave S1 (non-blocking)
    save({
      first_name: form.first_name.trim() || null,
      last_name:  form.last_name.trim()  || null,
      email,
      phone:      form.phone.trim()      || null,
      address:    form.address.trim()    || null,
      date_of_birth: form.date_of_birth  || null,
      shirt_size: form.shirt_size        || null,
      coach_name: form.coach_name.trim() || null,
    })
    setStep(2)
  }

  function handleSection2Next() {
    save({
      supplements:          form.supplements.trim()          || null,
      goals_6_months:       form.goals_6_months.trim()       || null,
      injuries_limitations: form.injuries_limitations.trim() || null,
      num_kids:             form.num_kids !== '' ? Number(form.num_kids) : null,
      occupation:           form.occupation.trim()           || null,
    })
    setStep(3)
  }

  async function handleSection3Complete() {
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const payload = {
        energy_level:      form.energy_level,
        sleep_hours:       form.sleep_hours       || null,
        stress_management: form.stress_management,
        sleep_quality:     form.sleep_quality,
        daily_water:       form.daily_water        || null,
        alcohol_weekdays:  form.alcohol_weekdays !== '' ? Number(form.alcohol_weekdays) : 0,
        alcohol_weekends:  form.alcohol_weekends !== '' ? Number(form.alcohol_weekends) : 0,
        happiness_level:   form.happiness_level,
        confidence_level:  form.confidence_level,
        activity_level:    form.activity_level     || null,
        completed: true,
      }
      const res = await fetch(`${API_URL}/api/health-assessment`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('Save failed — please try again')
      setStep(4)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function handleEnterApp() {
    // Inject updated userState so ProtectedLayout skips the re-fetch
    window.__userState = { onboardingComplete: true, assessmentComplete: true, paid: true }
    navigate('/dashboard', { replace: true })
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!loaded) {
    return (
      <div className="min-h-screen bg-[#1e2a3a] flex items-center justify-center">
        <span className="text-sm text-white/50">Loading…</span>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1e2a3a] via-[#243347] to-[#1e2a3a] flex items-start justify-center py-6 px-4">
      <div className="w-full max-w-lg">

        {/* ── Welcome step ── */}
        {step === 0 && (
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="bg-gradient-to-br from-[#E8670A] to-[#d45a08] px-8 py-10 text-center">
              <div className="text-5xl mb-4">🌿</div>
              <h1 className="text-2xl font-bold text-white mb-2">Metabolic &amp; Health Assessment</h1>
              <p className="text-white/80 text-sm leading-relaxed">
                One quick step before you dive in. This helps Coach Katie understand your body,
                your life, and your goals — so every recommendation is made just for you.
              </p>
            </div>
            <div className="px-8 py-8 space-y-4">
              <div className="flex items-start gap-3">
                <span className="text-[#E8670A] text-lg mt-0.5">✓</span>
                <div>
                  <p className="text-sm font-semibold text-gray-900">Personalized to you</p>
                  <p className="text-xs text-gray-500">Your data shapes your macros, workouts, and coaching.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-[#E8670A] text-lg mt-0.5">✓</span>
                <div>
                  <p className="text-sm font-semibold text-gray-900">Only takes 3 minutes</p>
                  <p className="text-xs text-gray-500">3 short sections. Your progress is saved as you go.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-[#E8670A] text-lg mt-0.5">✓</span>
                <div>
                  <p className="text-sm font-semibold text-gray-900">Private &amp; secure</p>
                  <p className="text-xs text-gray-500">Only visible to you and your coach.</p>
                </div>
              </div>

              <button
                onClick={handleWelcomeStart}
                className="w-full mt-2 py-4 bg-[#E8670A] hover:bg-[#d45a08] text-white font-bold text-base rounded-xl shadow-lg transition-all hover:shadow-xl active:scale-[0.98]"
              >
                Start Assessment →
              </button>
            </div>
          </div>
        )}

        {/* ── Section 1: Contact & Info ── */}
        {step === 1 && (
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
            <StepProgress step={1} />
            <div className="px-6 py-6">
              <h2 className="text-xl font-bold text-gray-900 mb-1">Contact &amp; Info</h2>
              <p className="text-sm text-gray-500 mb-6">Let's get the basics down. This helps your coach reach out and track your journey.</p>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="First name">
                    <TextInput value={form.first_name} onChange={set('first_name')} placeholder="Jane" />
                  </Field>
                  <Field label="Last name">
                    <TextInput value={form.last_name} onChange={set('last_name')} placeholder="Smith" />
                  </Field>
                </div>

                <Field label="Email">
                  <TextInput value={email} readOnly />
                </Field>

                <Field label="Phone number">
                  <TextInput value={form.phone} onChange={set('phone')} placeholder="(555) 000-0000" type="tel" />
                </Field>

                <Field label="Address" hint="City/state is fine — just so your coach knows your timezone.">
                  <TextInput value={form.address} onChange={set('address')} placeholder="Dallas, TX" />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Date of birth">
                    <TextInput value={form.date_of_birth} onChange={set('date_of_birth')} type="date" />
                  </Field>
                  <Field label="Coach name">
                    <TextInput value={form.coach_name} onChange={set('coach_name')} placeholder="Coach Katie" />
                  </Field>
                </div>

                <Field label="Shirt size">
                  <ButtonGroup value={form.shirt_size} onChange={setVal('shirt_size')} options={SHIRT_SIZES} />
                </Field>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
              <button
                onClick={handleSection1Next}
                className="px-8 py-3 bg-[#E8670A] hover:bg-[#d45a08] text-white font-bold rounded-xl shadow transition-all active:scale-[0.98]"
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── Section 2: About You ── */}
        {step === 2 && (
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
            <StepProgress step={2} />
            <div className="px-6 py-6">
              <h2 className="text-xl font-bold text-gray-900 mb-1">About You</h2>
              <p className="text-sm text-gray-500 mb-6">Help us understand your world — your goals, your schedule, and what you're working with.</p>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Occupation">
                    <TextInput value={form.occupation} onChange={set('occupation')} placeholder="e.g. Nurse, teacher…" />
                  </Field>
                  <Field label="Number of kids">
                    <TextInput value={form.num_kids} onChange={set('num_kids')} type="number" placeholder="0" />
                  </Field>
                </div>

                <Field label="Your #1 goal in the next 6 months" hint="Be as specific as you like — the more detail, the better your plan.">
                  <TextArea
                    value={form.goals_6_months}
                    onChange={set('goals_6_months')}
                    placeholder="e.g. Lose 20 lbs, feel more energized, fit into my old jeans, run a 5K…"
                    rows={3}
                  />
                </Field>

                <Field label="Current supplements" hint="List anything you take — vitamins, protein powder, creatine, etc.">
                  <TextArea
                    value={form.supplements}
                    onChange={set('supplements')}
                    placeholder="e.g. Whey protein, vitamin D, magnesium, fish oil…"
                    rows={2}
                  />
                </Field>

                <Field label="Injuries or physical limitations" hint="Any areas we should be careful about in your workouts or nutrition plan.">
                  <TextArea
                    value={form.injuries_limitations}
                    onChange={set('injuries_limitations')}
                    placeholder="e.g. Lower back issues, knee surgery in 2022, none…"
                    rows={2}
                  />
                </Field>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
              <button
                onClick={() => setStep(1)}
                className="px-5 py-3 text-sm text-gray-500 hover:text-gray-700 font-medium transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={handleSection2Next}
                className="px-8 py-3 bg-[#E8670A] hover:bg-[#d45a08] text-white font-bold rounded-xl shadow transition-all active:scale-[0.98]"
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── Section 3: Energy & Lifestyle ── */}
        {step === 3 && (
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
            <StepProgress step={3} />
            <div className="px-6 py-6">
              <h2 className="text-xl font-bold text-gray-900 mb-1">Energy &amp; Lifestyle</h2>
              <p className="text-sm text-gray-500 mb-6">Be honest — there are no wrong answers. This helps us meet you where you actually are right now.</p>

              <div className="space-y-6">
                <Field label="How would you rate your typical energy level?" hint="1 = exhausted, 5 = firing on all cylinders">
                  <RatingSelect value={form.energy_level} onChange={setVal('energy_level')} lowLabel="Exhausted" highLabel="Energized" />
                </Field>

                <Field label="How many hours of sleep do you get most nights?">
                  <OptionPills value={form.sleep_hours} onChange={setVal('sleep_hours')} options={SLEEP_HOURS_OPTIONS} />
                </Field>

                <Field label="Rate your sleep quality" hint="1 = restless, 5 = deep and refreshing">
                  <RatingSelect value={form.sleep_quality} onChange={setVal('sleep_quality')} lowLabel="Restless" highLabel="Refreshing" />
                </Field>

                <Field label="How well do you manage stress?" hint="1 = overwhelmed, 5 = very well">
                  <RatingSelect value={form.stress_management} onChange={setVal('stress_management')} lowLabel="Overwhelmed" highLabel="Very well" />
                </Field>

                <Field label="How much water do you drink daily?">
                  <OptionPills value={form.daily_water} onChange={setVal('daily_water')} options={WATER_OPTIONS} />
                </Field>

                <div className="grid grid-cols-2 gap-4">
                  <Field label="Alcoholic drinks per weekday">
                    <TextInput value={form.alcohol_weekdays} onChange={set('alcohol_weekdays')} type="number" placeholder="0" />
                  </Field>
                  <Field label="Alcoholic drinks per weekend day">
                    <TextInput value={form.alcohol_weekends} onChange={set('alcohol_weekends')} type="number" placeholder="0" />
                  </Field>
                </div>

                <Field label="Rate your overall happiness" hint="1 = struggling, 5 = thriving">
                  <RatingSelect value={form.happiness_level} onChange={setVal('happiness_level')} lowLabel="Struggling" highLabel="Thriving" />
                </Field>

                <Field label="Rate your self-confidence" hint="1 = very low, 5 = very high">
                  <RatingSelect value={form.confidence_level} onChange={setVal('confidence_level')} lowLabel="Very low" highLabel="Very high" />
                </Field>

                <Field label="Current activity level">
                  <OptionPills value={form.activity_level} onChange={setVal('activity_level')} options={ACTIVITY_OPTIONS} />
                </Field>
              </div>

              {error && (
                <p className="mt-4 text-sm text-red-500 text-center">{error}</p>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
              <button
                onClick={() => setStep(2)}
                className="px-5 py-3 text-sm text-gray-500 hover:text-gray-700 font-medium transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={handleSection3Complete}
                disabled={saving}
                className="px-8 py-3 bg-[#E8670A] hover:bg-[#d45a08] disabled:opacity-60 text-white font-bold rounded-xl shadow transition-all active:scale-[0.98]"
              >
                {saving ? 'Saving…' : 'Complete Assessment →'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: Complete ── */}
        {step === 4 && (
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden text-center">
            <div className="bg-gradient-to-br from-[#E8670A] to-[#d45a08] px-8 py-10">
              <div className="text-6xl mb-4">🎉</div>
              <h1 className="text-2xl font-bold text-white mb-2">You're all set!</h1>
              <p className="text-white/80 text-sm">
                {form.first_name ? `Great work, ${form.first_name}!` : 'Great work!'} Your assessment has been saved and sent to your coach.
              </p>
            </div>
            <div className="px-8 py-8 space-y-4">
              <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-left">
                <p className="text-sm font-semibold text-[#E8670A] mb-1">What happens next?</p>
                <ul className="space-y-1.5 text-xs text-gray-600">
                  <li className="flex items-start gap-2"><span className="text-[#E8670A] mt-0.5">•</span> Coach Katie will review your assessment and may reach out.</li>
                  <li className="flex items-start gap-2"><span className="text-[#E8670A] mt-0.5">•</span> Your macro targets will be personalized based on your responses.</li>
                  <li className="flex items-start gap-2"><span className="text-[#E8670A] mt-0.5">•</span> You can update your assessment anytime in Settings.</li>
                </ul>
              </div>

              <button
                onClick={handleEnterApp}
                className="w-full py-4 bg-[#E8670A] hover:bg-[#d45a08] text-white font-bold text-base rounded-xl shadow-lg transition-all hover:shadow-xl active:scale-[0.98]"
              >
                Enter Meta Coach →
              </button>
            </div>
          </div>
        )}

        {/* Bottom brand note */}
        {step < 4 && (
          <p className="text-center text-white/30 text-xs mt-4">
            Meta Coach · Your data is secure and private
          </p>
        )}

      </div>
    </div>
  )
}
