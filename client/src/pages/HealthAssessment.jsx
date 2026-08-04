import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, useUser } from '@clerk/clerk-react'
import { Play } from 'lucide-react'
import { API_URL } from '../config.js'
import { useOrgBranding } from '../context/OrgBrandingContext.jsx'

// ── Option data ──────────────────────────────────────────────────────────────

// Health assessment is a client-only onboarding flow — these roles must never
// see it. Mirrors the isPrivileged list in App.jsx's ProtectedLayout.
const STAFF_ROLES = ['admin', 'account_owner', 'staff', 'coach']
// Mirrors SUPER_ADMIN_EMAILS in App.jsx — Jason lands on /dashboard, not /org/dashboard.
const SUPER_ADMIN_EMAILS = ['jason@lwcvip.com', 'jason@efcfit.com']

const SHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']

// Exported so staff-facing views (e.g. ClientProfile.jsx's Client Info card) can
// render the client's actual answer label instead of the raw stored key.
export const SLEEP_HOURS_OPTIONS = [
  { value: 'less_than_5', label: 'Under 5h' },
  { value: '5_to_6',      label: '5–6h' },
  { value: '6_to_7',      label: '6–7h' },
  { value: '7_to_8',      label: '7–8h' },
  { value: '8_to_9',      label: '8–9h' },
  { value: '9_plus',      label: '9h+' },
]

export const WATER_OPTIONS = [
  { value: 'less_than_32',  label: '<32 oz' },
  { value: '32_to_64',      label: '32–64 oz' },
  { value: '64_to_96',      label: '64–96 oz' },
  { value: '96_to_128',     label: '96–128 oz' },
  { value: '128_plus',      label: '128 oz+' },
]

const ACTIVITY_CARDS = [
  { value: 'sedentary',         label: 'Sedentary',         desc: 'Little or no exercise. Mostly desk work or minimal daily movement.' },
  { value: 'lightly_active',    label: 'Lightly Active',    desc: 'Light exercise 1–3 days/week. Some walking or casual activity.' },
  { value: 'moderately_active', label: 'Moderately Active', desc: 'Moderate exercise 3–5 days/week. Regular workouts or an active lifestyle.' },
  { value: 'very_active',       label: 'Active',            desc: 'Hard exercise 6–7 days/week or a physically demanding job.' },
]

// ── Life Warrior identity traits ─────────────────────────────────────────────
// Curated 8 — premium, concise, gender-neutral. User selects exactly 2.
const IDENTITY_TRAITS = [
  "Shows up when it's hard.",
  'Keeps small promises daily.',
  'Acts on imperfect plans.',
  "Learns from mistakes — doesn't hide from them.",
  'Invests in self fully.',
  'Leads by example.',
  'Takes responsibility, not excuses.',
  'Gets comfortable being uncomfortable.',
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

// Typeable MM / DD / YYYY date entry — replaces the native <input type="date">, which
// renders as a scroll/wheel picker on iOS/Android and can't be typed into directly there.
// `value` / `onChange` use the same ISO 'YYYY-MM-DD' string as the rest of the form.
function DateOfBirthInput({ value, onChange }) {
  const [month, setMonth] = useState('')
  const [day,   setDay]   = useState('')
  const [year,  setYear]  = useState('')
  const monthRef = useRef(null)
  const dayRef   = useRef(null)
  const yearRef  = useRef(null)

  // Sync from parent (e.g. an assessment loaded from the server after mount).
  useEffect(() => {
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-')
      setYear(y); setMonth(m); setDay(d)
    } else if (!value) {
      setYear(''); setMonth(''); setDay('')
    }
  }, [value])

  function emit(m, d, y) {
    onChange(m.length === 2 && d.length === 2 && y.length === 4 ? `${y}-${m}-${d}` : '')
  }

  const segmentCls = 'border border-gray-300 rounded-xl px-3 py-3 text-sm text-center focus:outline-none focus:ring-2 focus:ring-[#E8670A] transition-colors hover:border-gray-400 bg-white text-gray-900'

  return (
    <div className="flex gap-2">
      <input
        ref={monthRef} type="text" inputMode="numeric" pattern="[0-9]*" placeholder="MM" maxLength={2}
        value={month}
        onChange={e => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 2)
          setMonth(v); emit(v, day, year)
          if (v.length === 2) dayRef.current?.focus()
        }}
        className={`w-16 ${segmentCls}`}
      />
      <input
        ref={dayRef} type="text" inputMode="numeric" pattern="[0-9]*" placeholder="DD" maxLength={2}
        value={day}
        onChange={e => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 2)
          setDay(v); emit(month, v, year)
          if (v.length === 2) yearRef.current?.focus()
        }}
        onKeyDown={e => { if (e.key === 'Backspace' && day === '') monthRef.current?.focus() }}
        className={`w-16 ${segmentCls}`}
      />
      <input
        ref={yearRef} type="text" inputMode="numeric" pattern="[0-9]*" placeholder="YYYY" maxLength={4}
        value={year}
        onChange={e => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 4)
          setYear(v); emit(month, day, v)
        }}
        onKeyDown={e => { if (e.key === 'Backspace' && year === '') dayRef.current?.focus() }}
        className={`w-24 ${segmentCls}`}
      />
    </div>
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
  const steps = ['Contact', 'About You', 'Lifestyle', 'Identity']
  return (
    <div className="bg-[#1e2a3a] px-4 sm:px-6 py-4">
      <div className="flex items-center justify-between relative">
        {/* connector lines */}
        <div className="absolute left-0 right-0 top-[14px] flex">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className={`flex-1 h-0.5 transition-colors ${
                step > i + 1 ? 'bg-[#E8670A]' : 'bg-white/20'
              }`}
              style={{ marginLeft: i === 0 ? '14px' : '0', marginRight: i === 2 ? '14px' : '0' }}
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
                className={`text-[10px] font-semibold transition-colors hidden sm:inline ${
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
  first_name: '', last_name: '', phone: '',
  street_address: '', city: '', state: '', zip_code: '', country: 'United States',
  date_of_birth: '', shirt_size: '',
  // S1 — physical stats (saved to users table, not health_assessments)
  gender: '', height_feet: '5', height_in: '4',
  starting_weight_lbs: '', goal_weight_lbs: '',
  // S2
  supplements: '', goals_6_months: '', injuries_limitations: '',
  num_kids: '', occupation: '',
  // S2 — food preferences (saved to users table, not health_assessments)
  food_allergies: '', food_dislikes: '',
  // S3
  energy_level: null, sleep_hours: '', stress_management: null,
  sleep_quality: null, daily_water: '', alcohol_weekdays: '0',
  alcohol_weekends: '0', happiness_level: null, confidence_level: null,
  activity_level: '',
  // S4 — Life Warrior identity (exactly 2 traits)
  identity_traits: [],
}

// Real-calendar-date check for the typed MM/DD/YYYY -> 'YYYY-MM-DD' value (rejects
// things like Feb 31 that pass a simple regex but aren't real dates).
function isValidISODate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false
  const [y, m, d] = str.split('-').map(Number)
  if (m < 1 || m > 12) return false
  if (d < 1 || d > new Date(y, m, 0).getDate()) return false
  const currentYear = new Date().getFullYear()
  return y >= currentYear - 120 && y <= currentYear
}

// ── Per-section validation ───────────────────────────────────────────────────
// Returns null if valid, or a supportive message string if invalid.
function validateSection(section, form) {
  if (section === 1) {
    if (!form.first_name.trim())     return "Let's start with your first name."
    if (!form.last_name.trim())      return 'Please add your last name to continue.'
    if (!form.phone.trim())          return 'Please share a phone number so your coach can reach you.'
    if (!form.street_address.trim()) return 'Please add your street address.'
    if (!form.city.trim())           return 'Please add your city.'
    if (!form.state.trim())          return 'Please add your state.'
    if (!form.zip_code.trim())       return 'Please add your zip code.'
    if (!form.country.trim())        return 'Please add your country.'
    if (!form.date_of_birth)         return 'Please add your date of birth.'
    if (!isValidISODate(form.date_of_birth)) return 'Please enter a valid date of birth.'
    if (!form.shirt_size)            return 'Please choose a shirt size.'
    if (!form.gender)                return 'Please select your biological sex — it\'s required for your calorie calculations.'
    const wt = Number(form.starting_weight_lbs)
    if (!form.starting_weight_lbs || !Number.isFinite(wt) || wt <= 0)
      return 'Please enter your current weight in lbs.'
    const gwt = Number(form.goal_weight_lbs)
    if (!form.goal_weight_lbs || !Number.isFinite(gwt) || gwt <= 0)
      return 'Please enter your goal weight in lbs.'
    return null
  }
  if (section === 2) {
    if (!form.occupation.trim())            return 'Please share your occupation.'
    if (form.num_kids === '' || form.num_kids == null) return 'Please share how many kids you have (0 is fine).'
    if (!form.goals_6_months.trim())        return 'Please share your 6-month goal — even one sentence helps.'
    if (!form.supplements.trim())           return "Please list your supplements — write 'None' if you don't take any."
    if (!form.injuries_limitations.trim())  return "Please share any injuries — write 'None' if you have none."
    return null
  }
  if (section === 3) {
    if (form.energy_level == null)      return "Please rate your energy level."
    if (!form.sleep_hours)               return 'Please choose your sleep hours.'
    if (form.sleep_quality == null)     return 'Please rate your sleep quality.'
    if (form.stress_management == null) return 'Please rate how you manage stress.'
    if (!form.daily_water)               return 'Please choose your daily water intake.'
    if (form.alcohol_weekdays === '' || form.alcohol_weekdays == null)
      return "Please share weekday alcohol intake (0 is fine)."
    if (form.alcohol_weekends === '' || form.alcohol_weekends == null)
      return "Please share weekend alcohol intake (0 is fine)."
    if (form.happiness_level == null)   return 'Please rate your happiness.'
    if (form.confidence_level == null)  return 'Please rate your confidence.'
    if (!form.activity_level)            return 'Please choose your activity level.'
    return null
  }
  if (section === 4) {
    if (!Array.isArray(form.identity_traits) || form.identity_traits.length !== 2) {
      return 'Please choose exactly 2 traits that feel most true to who you\'re becoming.'
    }
    return null
  }
  return null
}

export default function HealthAssessment() {
  const { getToken } = useAuth()
  const { user }     = useUser()
  const navigate     = useNavigate()
  const { aiCoachName, coachTitle } = useOrgBranding()

  const [step,         setStep]        = useState(0) // 0=welcome, 1=S1, 2=S2, 3=S3, 4=S4(identity), 5=complete
  const [form,         setForm]        = useState(EMPTY_FORM)
  const [saving,       setSaving]      = useState(false)
  const [error,        setError]       = useState(null)
  const [loaded,       setLoaded]      = useState(false)
  const [coachingType, setCoachingType] = useState(null)
  const [isReturningUser, setIsReturningUser] = useState(false)
  // Per-section validation message (supportive language; null when valid)
  const [validation, setValidation] = useState(null)

  const email = user?.primaryEmailAddress?.emailAddress ?? ''

  // Scroll to top whenever the step changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [step])

  // Load any existing partial assessment on mount
  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const [assessRes, meRes] = await Promise.all([
          fetch(`${API_URL}/api/health-assessment/me`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(`${API_URL}/api/users/me`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ])

        // Parse both responses before touching state so we can merge in one setForm call.
        let meData     = null
        let assessData = null
        if (meRes.ok)    meData     = await meRes.json()
        if (assessRes.ok) assessData = await assessRes.json()

        // Defense-in-depth: staff/org-admin roles should never see this flow, even on
        // a cold direct navigation to /health-assessment before App.jsx's route guard
        // has a cached role to check. Bounce them to their dashboard instead.
        if (meData && STAFF_ROLES.includes(meData.role)) {
          const email = (meData.email ?? '').toLowerCase()
          const isSuperAdmin = SUPER_ADMIN_EMAILS.includes(email)
          const isOrgAdmin = !isSuperAdmin
            && (meData.role === 'admin' || meData.role === 'account_owner' || (meData.role === 'coach' && meData.is_org_owner === true))
          navigate(isOrgAdmin ? '/org/dashboard' : '/dashboard', { replace: true })
          return
        }

        if (meData) {
          setCoachingType(meData.coaching_type ?? null)
          setIsReturningUser(meData.onboarding_complete === true)
        }

        // Merge: assessment fields come from health_assessments; physical-stats and
        // food-preference fields come from users (they are not stored in health_assessments).
        if (assessData || meData) {
          setForm({
            // ── health_assessments fields ──
            first_name:     assessData?.first_name     ?? '',
            last_name:      assessData?.last_name      ?? '',
            phone:          assessData?.phone          ?? '',
            street_address: assessData?.street_address ?? '',
            city:           assessData?.city           ?? '',
            state:          assessData?.state          ?? '',
            zip_code:       assessData?.zip_code       ?? '',
            country:        assessData?.country        ?? 'United States',
            date_of_birth:  assessData?.date_of_birth  ? assessData.date_of_birth.slice(0, 10) : '',
            shirt_size:           assessData?.shirt_size           ?? '',
            supplements:          assessData?.supplements          ?? '',
            goals_6_months:       assessData?.goals_6_months       ?? '',
            injuries_limitations: assessData?.injuries_limitations ?? '',
            num_kids:             assessData?.num_kids != null ? String(assessData.num_kids) : '',
            occupation:           assessData?.occupation           ?? '',
            energy_level:         assessData?.energy_level         ?? null,
            sleep_hours:          assessData?.sleep_hours          ?? '',
            stress_management:    assessData?.stress_management    ?? null,
            sleep_quality:        assessData?.sleep_quality        ?? null,
            daily_water:          assessData?.daily_water          ?? '',
            alcohol_weekdays:     assessData?.alcohol_weekdays != null ? String(assessData.alcohol_weekdays) : '0',
            alcohol_weekends:     assessData?.alcohol_weekends != null ? String(assessData.alcohol_weekends) : '0',
            happiness_level:      assessData?.happiness_level      ?? null,
            confidence_level:     assessData?.confidence_level     ?? null,
            activity_level:       assessData?.activity_level       ?? '',
            identity_traits:      Array.isArray(assessData?.identity_traits) ? assessData.identity_traits : [],
            // ── users-table fields (physical stats + food prefs) ──
            gender:              meData?.gender ?? '',
            height_feet:         meData?.height_inches != null
                                   ? String(Math.floor(meData.height_inches / 12)) : '5',
            height_in:           meData?.height_inches != null
                                   ? String(meData.height_inches % 12) : '4',
            starting_weight_lbs: meData?.starting_weight_lbs != null
                                   ? String(meData.starting_weight_lbs) : '',
            goal_weight_lbs:     meData?.goal_weight_lbs != null
                                   ? String(meData.goal_weight_lbs) : '',
            food_allergies:      meData?.food_allergies ?? '',
            food_dislikes:       meData?.food_dislikes  ?? '',
          })
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
    return e => {
      setForm(f => ({ ...f, [field]: e.target.value }))
      if (validation) setValidation(null)
    }
  }

  function setVal(field) {
    return val => {
      setForm(f => ({ ...f, [field]: val }))
      if (validation) setValidation(null)
    }
  }

  // Toggle identity trait — enforces "exactly 2" max
  function toggleTrait(trait) {
    setForm(f => {
      const current = Array.isArray(f.identity_traits) ? f.identity_traits : []
      if (current.includes(trait)) {
        return { ...f, identity_traits: current.filter(t => t !== trait) }
      }
      if (current.length >= 2) return f
      return { ...f, identity_traits: [...current, trait] }
    })
    if (validation) setValidation(null)
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

  // Save physical-stats and food-pref fields directly to users table (non-blocking).
  // These fields are not stored in health_assessments — they live in users.
  async function saveUsersProfile(payload) {
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/users/me`, {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
    } catch {
      // autosave failure is silent
    }
  }

  // ── Step navigation ──────────────────────────────────────────────────────────

  function handleWelcomeStart() {
    setStep(1)
  }

  function handleSection1Next() {
    const err = validateSection(1, form)
    if (err) { setValidation(err); return }
    save({
      first_name:     form.first_name.trim(),
      last_name:      form.last_name.trim(),
      email,
      phone:          form.phone.trim(),
      street_address: form.street_address.trim(),
      city:           form.city.trim(),
      state:          form.state.trim(),
      zip_code:       form.zip_code.trim(),
      country:        form.country.trim() || 'United States',
      date_of_birth:  form.date_of_birth,
      shirt_size:     form.shirt_size,
    })
    // Physical stats go directly to users table (not stored in health_assessments)
    const height_inches = parseInt(form.height_feet, 10) * 12 + parseInt(form.height_in, 10)
    saveUsersProfile({
      gender:              form.gender || null,
      height_inches:       height_inches > 0 ? height_inches : null,
      starting_weight_lbs: form.starting_weight_lbs ? Number(form.starting_weight_lbs) : null,
      goal_weight_lbs:     form.goal_weight_lbs     ? Number(form.goal_weight_lbs)      : null,
    })
    setValidation(null)
    setStep(2)
  }

  function handleSection2Next() {
    const err = validateSection(2, form)
    if (err) { setValidation(err); return }
    save({
      supplements:          form.supplements.trim(),
      goals_6_months:       form.goals_6_months.trim(),
      injuries_limitations: form.injuries_limitations.trim(),
      num_kids:             Number(form.num_kids),
      occupation:           form.occupation.trim(),
    })
    // Food preferences go directly to users table (not stored in health_assessments)
    saveUsersProfile({
      food_allergies: form.food_allergies,
      food_dislikes:  form.food_dislikes,
    })
    setValidation(null)
    setStep(3)
  }

  function handleSection3Next() {
    const err = validateSection(3, form)
    if (err) { setValidation(err); return }
    save({
      energy_level:      form.energy_level,
      sleep_hours:       form.sleep_hours,
      stress_management: form.stress_management,
      sleep_quality:     form.sleep_quality,
      daily_water:       form.daily_water,
      alcohol_weekdays:  Number(form.alcohol_weekdays),
      alcohol_weekends:  Number(form.alcohol_weekends),
      happiness_level:   form.happiness_level,
      confidence_level:  form.confidence_level,
      activity_level:    form.activity_level,
    })
    setValidation(null)
    setStep(4)
  }

  async function handleSection4Complete() {
    const err = validateSection(4, form)
    if (err) { setValidation(err); return }
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()

      // Flush users-table fields (blocking) in case fire-and-forget autosaves from earlier
      // sections failed silently. This guarantees gender, height, weights, and food prefs
      // are always written on final completion regardless of intermediate autosave success.
      const height_inches_final = parseInt(form.height_feet, 10) * 12 + parseInt(form.height_in, 10)
      await fetch(`${API_URL}/api/users/me`, {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          gender:              form.gender              || null,
          height_inches:       height_inches_final > 0 ? height_inches_final : null,
          starting_weight_lbs: form.starting_weight_lbs ? Number(form.starting_weight_lbs) : null,
          goal_weight_lbs:     form.goal_weight_lbs     ? Number(form.goal_weight_lbs)      : null,
          food_allergies:      form.food_allergies,
          food_dislikes:       form.food_dislikes,
        }),
      })

      // Final health assessment completion — include all fields as COALESCE fallback so that
      // any section whose fire-and-forget autosave failed silently still ends up persisted.
      const payload = {
        // Section 1 — contact & physical stats
        first_name:           form.first_name.trim()      || null,
        last_name:            form.last_name.trim()       || null,
        email,
        phone:                form.phone.trim()           || null,
        street_address:       form.street_address.trim()  || null,
        city:                 form.city.trim()             || null,
        state:                form.state.trim()            || null,
        zip_code:             form.zip_code.trim()         || null,
        country:              form.country.trim()          || 'United States',
        date_of_birth:        form.date_of_birth           || null,
        shirt_size:           form.shirt_size              || null,
        // Section 2 — about you
        supplements:          form.supplements.trim()          || null,
        goals_6_months:       form.goals_6_months.trim()       || null,
        injuries_limitations: form.injuries_limitations.trim() || null,
        num_kids:             form.num_kids !== '' && form.num_kids != null ? Number(form.num_kids) : null,
        occupation:           form.occupation.trim()           || null,
        // Section 3 — lifestyle
        energy_level:         form.energy_level      != null ? form.energy_level      : null,
        sleep_hours:          form.sleep_hours        || null,
        stress_management:    form.stress_management  != null ? form.stress_management  : null,
        sleep_quality:        form.sleep_quality      != null ? form.sleep_quality      : null,
        daily_water:          form.daily_water        || null,
        alcohol_weekdays:     form.alcohol_weekdays !== '' ? Number(form.alcohol_weekdays) : null,
        alcohol_weekends:     form.alcohol_weekends !== '' ? Number(form.alcohol_weekends) : null,
        happiness_level:      form.happiness_level   != null ? form.happiness_level   : null,
        confidence_level:     form.confidence_level  != null ? form.confidence_level  : null,
        activity_level:       form.activity_level    || null,
        // Section 4 — identity
        identity_traits: form.identity_traits,
        completed: true,
      }
      const res = await fetch(`${API_URL}/api/health-assessment`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('Save failed — please try again.')
      setValidation(null)
      setStep(5)
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

        {/* ── Cancel/back button for returning users ── */}
        {isReturningUser && (
          <div className="mb-4">
            <button
              onClick={() => navigate('/dashboard')}
              className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 transition-colors min-h-[44px] px-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                <path d="M15 19l-7-7 7-7" />
              </svg>
              <span className="text-sm font-medium">Back to App</span>
            </button>
          </div>
        )}

        {/* ── Welcome step ── */}
        {step === 0 && (
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="bg-gradient-to-br from-[#E8670A] to-[#d45a08] px-8 py-10 text-center">
              {/* Logo — white pill container matches sidebar treatment */}
              <div className="bg-white rounded-xl px-4 py-2.5 inline-block mb-5 shadow-sm">
                <img
                  src="/brand/warriorfit-logo-full.png"
                  alt="WarriorFIT AI"
                  className="h-10 w-auto object-contain"
                  onError={e => { e.currentTarget.style.display = 'none' }}
                />
              </div>
              <h1 className="text-2xl font-bold text-white mb-2">Metabolic &amp; Health Assessment</h1>
              <p className="text-white/80 text-sm leading-relaxed">
                One quick step before you dive in. This helps {coachTitle} understand your body,
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
                  <p className="text-xs text-gray-500">4 short sections. Your progress is saved as you go.</p>
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

                {/* ── Structured address ── */}
                <Field label="Street address">
                  <TextInput value={form.street_address} onChange={set('street_address')} placeholder="123 Main Street" />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="City">
                    <TextInput value={form.city} onChange={set('city')} placeholder="Dallas" />
                  </Field>
                  <Field label="State">
                    <TextInput value={form.state} onChange={set('state')} placeholder="TX" />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Zip code">
                    <TextInput value={form.zip_code} onChange={set('zip_code')} placeholder="75201" />
                  </Field>
                  <Field label="Country">
                    <TextInput value={form.country} onChange={set('country')} placeholder="United States" />
                  </Field>
                </div>

                <Field label="Date of birth">
                  <DateOfBirthInput value={form.date_of_birth} onChange={setVal('date_of_birth')} />
                </Field>

                <Field label="Shirt size">
                  <ButtonGroup value={form.shirt_size} onChange={setVal('shirt_size')} options={SHIRT_SIZES} />
                </Field>

                {/* ── Physical stats for TDEE / Katie context ── */}
                <Field label="Biological sex" hint="Used to calculate your calorie and macro targets.">
                  <div className="flex gap-3">
                    {['Female', 'Male'].map(g => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => { setForm(f => ({ ...f, gender: g.toLowerCase() })); if (validation) setValidation(null) }}
                        className={`flex-1 py-3 rounded-xl text-sm font-semibold border-2 transition-all min-h-[44px] ${
                          form.gender === g.toLowerCase()
                            ? 'bg-[#E8670A] border-[#E8670A] text-white shadow-sm'
                            : 'border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A] bg-white'
                        }`}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                </Field>

                <Field label="Height">
                  <div className="grid grid-cols-2 gap-3">
                    <select
                      value={form.height_feet}
                      onChange={set('height_feet')}
                      className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
                    >
                      {[4, 5, 6, 7].map(f => (
                        <option key={f} value={f}>{f} ft</option>
                      ))}
                    </select>
                    <select
                      value={form.height_in}
                      onChange={set('height_in')}
                      className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
                    >
                      {Array.from({ length: 12 }, (_, i) => i).map(i => (
                        <option key={i} value={i}>{i} in</option>
                      ))}
                    </select>
                  </div>
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Current weight (lbs)">
                    <TextInput
                      value={form.starting_weight_lbs}
                      onChange={set('starting_weight_lbs')}
                      type="number"
                      placeholder="165"
                    />
                  </Field>
                  <Field label="Goal weight (lbs)">
                    <TextInput
                      value={form.goal_weight_lbs}
                      onChange={set('goal_weight_lbs')}
                      type="number"
                      placeholder="145"
                    />
                  </Field>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100">
              {validation && step === 1 && (
                <p className="text-sm text-[#E8670A] mb-3 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  {validation}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  onClick={handleSection1Next}
                  className="px-8 py-3 bg-[#E8670A] hover:bg-[#d45a08] text-white font-bold rounded-xl shadow transition-all active:scale-[0.98]"
                >
                  Continue →
                </button>
              </div>
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

                <Field label="Food allergies &amp; intolerances" hint={`Leave blank if none. ${aiCoachName} will never suggest foods that trigger you.`}>
                  <TextArea
                    value={form.food_allergies}
                    onChange={set('food_allergies')}
                    placeholder="e.g. dairy, gluten, shellfish, tree nuts…"
                    rows={2}
                  />
                </Field>

                <Field label="Foods I dislike" hint={`Leave blank if none. ${aiCoachName} will avoid these in meal plans.`}>
                  <TextArea
                    value={form.food_dislikes}
                    onChange={set('food_dislikes')}
                    placeholder="e.g. mushrooms, fish, Brussels sprouts…"
                    rows={2}
                  />
                </Field>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100">
              {validation && step === 2 && (
                <p className="text-sm text-[#E8670A] mb-3 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  {validation}
                </p>
              )}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => { setStep(1); setValidation(null) }}
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
                  <div className="space-y-2">
                    {ACTIVITY_CARDS.map(card => {
                      const selected = form.activity_level === card.value
                      return (
                        <button
                          key={card.value}
                          type="button"
                          onClick={() => { setForm(f => ({ ...f, activity_level: card.value })); if (validation) setValidation(null) }}
                          className={`w-full text-left px-4 py-3.5 rounded-xl border-2 transition-all flex items-start gap-3 ${
                            selected
                              ? 'bg-[#1e2a3a] border-[#E8670A] text-white shadow-md'
                              : 'bg-white border-gray-200 text-gray-800 hover:border-[#E8670A] hover:bg-orange-50'
                          }`}
                        >
                          <span className={`mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 ${
                            selected ? 'bg-[#E8670A] border-[#E8670A] text-white text-xs font-bold' : 'border-gray-300 bg-white'
                          }`}>
                            {selected ? '✓' : ''}
                          </span>
                          <div>
                            <p className={`text-sm font-semibold leading-tight ${selected ? 'text-white' : 'text-gray-900'}`}>{card.label}</p>
                            <p className={`text-xs mt-0.5 leading-snug ${selected ? 'text-white/70' : 'text-gray-500'}`}>{card.desc}</p>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </Field>
              </div>

            </div>
            <div className="px-6 py-4 border-t border-gray-100">
              {validation && step === 3 && (
                <p className="text-sm text-[#E8670A] mb-3 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  {validation}
                </p>
              )}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => { setStep(2); setValidation(null) }}
                  className="px-5 py-3 text-sm text-gray-500 hover:text-gray-700 font-medium transition-colors"
                >
                  ← Back
                </button>
                <button
                  onClick={handleSection3Next}
                  className="px-8 py-3 bg-[#E8670A] hover:bg-[#d45a08] text-white font-bold rounded-xl shadow transition-all active:scale-[0.98]"
                >
                  Continue →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Section 4: Life Warrior Identity ── */}
        {step === 4 && (
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
            <StepProgress step={4} />
            <div className="px-6 py-6">
              <h2 className="text-xl font-bold text-gray-900 mb-1">Your Life Warrior identity</h2>
              <p className="text-sm text-gray-500 mb-1">
                Choose 2 traits that feel most true to who you're becoming.
              </p>
              <p className="text-xs text-[#E8670A] font-semibold mb-5">
                {form.identity_traits.length}/2 selected
              </p>

              <div className="space-y-2">
                {IDENTITY_TRAITS.map(trait => {
                  const selected = form.identity_traits.includes(trait)
                  const maxed    = form.identity_traits.length >= 2
                  const disabled = !selected && maxed
                  return (
                    <button
                      key={trait}
                      type="button"
                      onClick={() => toggleTrait(trait)}
                      disabled={disabled}
                      className={`w-full text-left px-4 py-3.5 rounded-xl border-2 transition-all min-h-[56px] flex items-center gap-3 ${
                        selected
                          ? 'bg-[#1e2a3a] border-[#E8670A] text-white shadow-md'
                          : disabled
                          ? 'bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed'
                          : 'bg-white border-gray-200 text-gray-800 hover:border-[#E8670A] hover:bg-orange-50'
                      }`}
                    >
                      <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full border-2 shrink-0 ${
                        selected
                          ? 'bg-[#E8670A] border-[#E8670A] text-white text-sm font-bold'
                          : 'border-gray-300 bg-white'
                      }`}>
                        {selected ? '✓' : ''}
                      </span>
                      <span className="text-sm font-medium">{trait}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100">
              {validation && step === 4 && (
                <p className="text-sm text-[#E8670A] mb-3 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  {validation}
                </p>
              )}
              {error && step === 4 && (
                <p className="text-sm text-red-500 mb-3 text-center">{error}</p>
              )}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => { setStep(3); setValidation(null) }}
                  className="px-5 py-3 text-sm text-gray-500 hover:text-gray-700 font-medium transition-colors"
                >
                  ← Back
                </button>
                <button
                  onClick={handleSection4Complete}
                  disabled={saving}
                  className="px-8 py-3 bg-[#E8670A] hover:bg-[#d45a08] disabled:opacity-60 text-white font-bold rounded-xl shadow transition-all active:scale-[0.98]"
                >
                  {saving ? 'Saving…' : 'Complete Assessment →'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 5: Complete ── */}
        {step === 5 && (
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden text-center">
            <div className="bg-gradient-to-br from-[#E8670A] to-[#d45a08] px-8 py-10">
              <div className="text-6xl mb-4">🎉</div>
              <h1 className="text-2xl font-bold text-white mb-2">You're all set!</h1>
              <p className="text-white/80 text-sm">
                {form.first_name ? `Great work, ${form.first_name}!` : 'Great work!'}{' '}
                {coachingType === 'hybrid' || coachingType === 'ai'
                  ? 'Your assessment has been saved and your AI coaching setup is ready.'
                  : 'Your assessment has been saved and sent to your coach.'}
              </p>
            </div>
            <div className="px-8 py-8 space-y-4">
              <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-left">
                <p className="text-sm font-semibold text-[#E8670A] mb-1">What happens next?</p>
                {coachingType === 'hybrid' || coachingType === 'ai' ? (
                  <ul className="space-y-1.5 text-xs text-gray-600">
                    <li className="flex items-start gap-2"><span className="text-[#E8670A] mt-0.5">•</span> Be sure to watch the video below — it walks you through how to get the best out of the app using {coachTitle}.</li>
                    <li className="flex items-start gap-2"><span className="text-[#E8670A] mt-0.5">•</span> You can update your assessment anytime in Settings.</li>
                  </ul>
                ) : (
                  <ul className="space-y-1.5 text-xs text-gray-600">
                    <li className="flex items-start gap-2"><span className="text-[#E8670A] mt-0.5">•</span> Your coach will review your assessment.</li>
                    <li className="flex items-start gap-2"><span className="text-[#E8670A] mt-0.5">•</span> We'll schedule your launch conference so you know exactly how to get started.</li>
                    <li className="flex items-start gap-2"><span className="text-[#E8670A] mt-0.5">•</span> You can update your assessment anytime in Settings.</li>
                  </ul>
                )}
              </div>

              <div className="text-left">
                {/* Video placeholder — swap this div's contents for an <iframe>/<video> embed when the real walkthrough is ready */}
                <div className="bg-gray-50 border border-gray-200 rounded-xl aspect-video flex items-center justify-center">
                  <div className="w-14 h-14 rounded-full bg-white shadow flex items-center justify-center">
                    <Play className="w-6 h-6 text-[#E8670A] fill-[#E8670A] ml-0.5" />
                  </div>
                </div>
                <p className="text-xs text-gray-400 text-center mt-2">{coachTitle} walkthrough video — coming soon</p>
              </div>

              <button
                onClick={handleEnterApp}
                className="w-full py-4 bg-[#E8670A] hover:bg-[#d45a08] text-white font-bold text-base rounded-xl shadow-lg transition-all hover:shadow-xl active:scale-[0.98]"
              >
                Enter WarriorFIT AI →
              </button>
            </div>
          </div>
        )}

        {/* Bottom brand note */}
        {step < 5 && (
          <p className="text-center text-white/30 text-xs mt-4">
            WarriorFIT AI · Your data is secure and private
          </p>
        )}

      </div>
    </div>
  )
}
