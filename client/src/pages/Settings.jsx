import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useUser } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

const ACTIVITY_OPTIONS = [
  { value: 'sedentary',         label: 'Sedentary (little or no exercise)' },
  { value: 'lightly_active',    label: 'Lightly Active (1-3 days/week)' },
  { value: 'moderately_active', label: 'Moderately Active (3-5 days/week)' },
  { value: 'very_active',       label: 'Very Active (6-7 days/week)' },
  { value: 'extra_active',      label: 'Extra Active (very hard exercise/physical job)' },
]

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

const ASSESSMENT_ACTIVITY_OPTIONS = [
  { value: 'sedentary',         label: 'Sedentary' },
  { value: 'lightly_active',    label: 'Lightly Active' },
  { value: 'moderately_active', label: 'Moderately Active' },
  { value: 'very_active',       label: 'Very Active' },
  { value: 'extra_active',      label: 'Extra Active' },
]

// Assessment sub-components (reused in Settings)
function AssRating({ value, onChange, lowLabel = 'Low', highLabel = 'High' }) {
  return (
    <div>
      <div className="flex gap-1.5">
        {[1,2,3,4,5].map(n => (
          <button key={n} type="button" onClick={() => onChange(n)}
            className={`flex-1 h-9 rounded-lg text-xs font-bold border-2 transition-all ${
              value === n
                ? 'bg-[#E8670A] border-[#E8670A] text-white'
                : 'border-gray-200 text-gray-500 hover:border-[#E8670A] hover:text-[#E8670A] bg-white'
            }`}>{n}</button>
        ))}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-gray-400">{lowLabel}</span>
        <span className="text-[10px] text-gray-400">{highLabel}</span>
      </div>
    </div>
  )
}

function AssOptions({ value, onChange, options }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(opt => (
        <button key={opt.value ?? opt} type="button" onClick={() => onChange(opt.value ?? opt)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium border-2 transition-all ${
            value === (opt.value ?? opt)
              ? 'bg-[#E8670A] border-[#E8670A] text-white'
              : 'border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A] bg-white'
          }`}>{opt.label ?? opt}</button>
      ))}
    </div>
  )
}

const ANGLES = ['front', 'back', 'side']

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
}

function ProgressPhotoPanel({ angle, photos, getToken, onUploaded }) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const latest = photos[0] ?? null

  async function handleFile(file) {
    if (!file) return
    setUploading(true)
    try {
      const token = await getToken()
      const body  = new FormData()
      body.append('photo', file)
      body.append('angle', angle)
      const res = await fetch(`${API_URL}/api/progress-photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      if (res.ok) onUploaded(await res.json())
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="text-center">
      <p className="text-xs font-medium text-gray-600 mb-2 capitalize">{angle}</p>
      <div
        onClick={() => !uploading && inputRef.current?.click()}
        className={`w-full aspect-[3/4] rounded-xl border-2 overflow-hidden cursor-pointer transition-colors flex items-center justify-center ${
          latest ? 'border-gray-200' : 'border-dashed border-gray-300 bg-gray-50 hover:border-[#E8670A] hover:bg-[#fff7ed]'
        }`}
      >
        {latest ? (
          <img src={latest.photo_url} alt={angle} className="w-full h-full object-cover" />
        ) : uploading ? (
          <span className="text-xs text-gray-400">Uploading…</span>
        ) : (
          <span className="text-xs text-gray-400">Tap to upload</span>
        )}
      </div>
      {latest && (
        <p className="text-xs text-gray-400 mt-1">{new Date(latest.taken_at).toLocaleDateString()}</p>
      )}
      {photos.length > 1 && (
        <p className="text-xs text-gray-400">{photos.length} photos</p>
      )}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="text-xs text-[#E8670A] hover:text-[#c45e09] mt-1 transition-colors disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : latest ? 'Add Photo' : 'Upload'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={e => handleFile(e.target.files[0])}
      />
    </div>
  )
}

const EMPTY_ASSESSMENT = {
  first_name: '', last_name: '', phone: '',
  street_address: '', city: '', state: '', zip_code: '', country: 'United States',
  date_of_birth: '', shirt_size: '',
  supplements: '', goals_6_months: '', injuries_limitations: '',
  num_kids: '', occupation: '',
  energy_level: null, sleep_hours: '', stress_management: null,
  sleep_quality: null, daily_water: '', alcohol_weekdays: '0',
  alcohol_weekends: '0', happiness_level: null, confidence_level: null,
  activity_level: '',
}

export default function Settings() {
  const { getToken }   = useAuth()
  const { user }       = useUser()
  const [profile, setProfile] = useState(null)
  const [form, setForm]       = useState({
    first_name: '', last_name: '', age: '', feet: '', inches: '', activity_level: '',
    gender: '', phone_number: '',
  })
  const [saving, setSaving]   = useState(false)
  const [saved,  setSaved]    = useState(false)
  const [error,  setError]    = useState(null)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameSaved,  setNameSaved]  = useState(false)
  const [nameError,  setNameError]  = useState(null)

  // Health assessment
  const [assessment,     setAssessment]     = useState(null)
  const [aForm,          setAForm]          = useState(EMPTY_ASSESSMENT)
  const [aOpen,          setAOpen]          = useState(false)
  const [aSaving,        setASaving]        = useState(false)
  const [aSaved,         setASaved]         = useState(false)
  const [aError,         setAError]         = useState(null)

  // Progress photos: each angle holds an array sorted newest-first
  const [photos, setPhotos] = useState({ front: [], back: [], side: [] })

  const email = user?.primaryEmailAddress?.emailAddress ?? ''

  useEffect(() => {
    async function load() {
      const token = await getToken()
      const [profileRes, photosRes, assessmentRes] = await Promise.all([
        fetch(`${API_URL}/api/users/me`,              { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/progress-photos`,       { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/health-assessment/me`,  { headers: { Authorization: `Bearer ${token}` } }),
      ])
      if (profileRes.ok) {
        const data = await profileRes.json()
        setProfile(data)
        setForm({
          first_name:     data.first_name     ?? '',
          last_name:      data.last_name      ?? '',
          age:            data.age            != null ? String(data.age) : '',
          feet:           data.height_inches  != null ? String(Math.floor(data.height_inches / 12)) : '',
          inches:         data.height_inches  != null ? String(data.height_inches % 12) : '',
          activity_level: data.activity_level ?? '',
          gender:         data.gender         ?? '',
          phone_number:   data.phone_number   ?? '',
        })
      }
      if (photosRes.ok) {
        const list = await photosRes.json()
        // Group by angle, newest first (API returns newest-first already)
        const byAngle = { front: [], back: [], side: [] }
        for (const p of list) {
          if (byAngle[p.angle]) byAngle[p.angle].push(p)
        }
        setPhotos(byAngle)
      }
      if (assessmentRes.ok) {
        const data = await assessmentRes.json()
        if (data) {
          setAssessment(data)
          setAForm({
            first_name:     data.first_name     ?? '',
            last_name:      data.last_name      ?? '',
            phone:          data.phone          ?? '',
            street_address: data.street_address ?? '',
            city:           data.city           ?? '',
            state:          data.state          ?? '',
            zip_code:       data.zip_code       ?? '',
            country:        data.country        ?? 'United States',
            date_of_birth:  data.date_of_birth  ? data.date_of_birth.slice(0, 10) : '',
            shirt_size:           data.shirt_size           ?? '',
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
    }
    load()
  }, [getToken])

  function set(e) {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: value }))
  }

  async function saveName(e) {
    e.preventDefault()
    setNameSaving(true); setNameError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/users/me`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: form.first_name.trim() || null,
          last_name:  form.last_name.trim()  || null,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 2500)
    } catch (err) {
      setNameError(err.message)
    } finally {
      setNameSaving(false)
    }
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const token  = await getToken()
      const feet   = parseInt(form.feet,   10)
      const inches = parseInt(form.inches, 10)
      const height_inches = (!isNaN(feet) && !isNaN(inches)) ? feet * 12 + inches : null

      const payload = {
        first_name:     form.first_name.trim()   || null,
        age:            form.age !== ''           ? parseInt(form.age, 10) : null,
        height_inches,
        activity_level: form.activity_level       || null,
        gender:         form.gender               || null,
        phone_number:   form.phone_number.trim()  || null,
      }

      const res = await fetch(`${API_URL}/api/users/me`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('Failed to save')
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function setA(field) {
    return e => setAForm(f => ({ ...f, [field]: e.target.value }))
  }
  function setAVal(field) {
    return val => setAForm(f => ({ ...f, [field]: val }))
  }

  async function saveAssessment(e) {
    e.preventDefault()
    setASaving(true); setAError(null)
    try {
      const token = await getToken()
      const payload = {
        first_name:     aForm.first_name.trim()     || null,
        last_name:      aForm.last_name.trim()      || null,
        email,
        phone:          aForm.phone.trim()          || null,
        street_address: aForm.street_address.trim() || null,
        city:           aForm.city.trim()           || null,
        state:          aForm.state.trim()          || null,
        zip_code:       aForm.zip_code.trim()       || null,
        country:        aForm.country.trim()        || 'United States',
        date_of_birth:  aForm.date_of_birth         || null,
        shirt_size:           aForm.shirt_size                  || null,
        supplements:          aForm.supplements.trim()          || null,
        goals_6_months:       aForm.goals_6_months.trim()       || null,
        injuries_limitations: aForm.injuries_limitations.trim() || null,
        num_kids:             aForm.num_kids !== '' ? Number(aForm.num_kids) : null,
        occupation:           aForm.occupation.trim()           || null,
        energy_level:      aForm.energy_level,
        sleep_hours:       aForm.sleep_hours      || null,
        stress_management: aForm.stress_management,
        sleep_quality:     aForm.sleep_quality,
        daily_water:       aForm.daily_water       || null,
        alcohol_weekdays:  aForm.alcohol_weekdays !== '' ? Number(aForm.alcohol_weekdays) : 0,
        alcohol_weekends:  aForm.alcohol_weekends !== '' ? Number(aForm.alcohol_weekends) : 0,
        happiness_level:   aForm.happiness_level,
        confidence_level:  aForm.confidence_level,
        activity_level:    aForm.activity_level   || null,
      }
      const res = await fetch(`${API_URL}/api/health-assessment`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('Failed to save')
      setAssessment(await res.json())
      setASaved(true)
      setTimeout(() => setASaved(false), 2500)
    } catch (err) {
      setAError(err.message)
    } finally {
      setASaving(false)
    }
  }

  function handlePhotoUploaded(photo) {
    setPhotos(prev => ({
      ...prev,
      [photo.angle]: [photo, ...(prev[photo.angle] ?? [])],
    }))
  }

  const anglesWithComparison = ANGLES.filter(a => photos[a].length >= 2)

  return (
    <div className="w-full max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Settings</h1>
      <p className="text-sm text-gray-500 mb-8">Account and preferences</p>

      {/* Account */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Account</h2>
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
        <form onSubmit={saveName} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name">
              <input
                type="text"
                name="first_name"
                value={form.first_name}
                onChange={set}
                placeholder="First name"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
              />
            </Field>
            <Field label="Last name">
              <input
                type="text"
                name="last_name"
                value={form.last_name}
                onChange={set}
                placeholder="Last name"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
              />
            </Field>
          </div>
          <Field label="Email">
            <input
              type="email"
              value={user?.primaryEmailAddress?.emailAddress ?? ''}
              readOnly
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
            />
          </Field>
          {nameError && <p className="text-xs text-red-500">{nameError}</p>}
          <button
            type="submit"
            disabled={nameSaving}
            className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors disabled:opacity-60"
          >
            {nameSaved ? 'Saved!' : nameSaving ? 'Saving…' : 'Save Name'}
          </button>
        </form>
      </div>

      {/* Health Profile */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Health Profile</h2>
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
        <p className="text-sm text-gray-500 mb-4">Your personal, health, and progress information is managed in your Health Profile.</p>
        <a
          href="/health-assessment"
          className="flex items-center justify-center w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors"
        >
          Edit Health Profile
        </a>
      </div>

      {/* Progress Photos */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Progress Photos</h2>
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-8">
        <p className="text-sm text-gray-500 mb-4">Upload front, back, and side photos to track your visual progress over time.</p>
        <div className="grid grid-cols-3 gap-2">
          {ANGLES.map(angle => (
            <ProgressPhotoPanel
              key={angle}
              angle={angle}
              photos={photos[angle]}
              getToken={getToken}
              onUploaded={handlePhotoUploaded}
            />
          ))}
        </div>
      </div>

      {/* Connected Apps */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Connected Apps</h2>
      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        {[
          { name: 'Apple Health', icon: '🍎' },
          { name: 'Google Fit',   icon: '🏃' },
          { name: 'Fitbit',       icon: '⌚' },
        ].map(app => (
          <div key={app.name} className="flex items-center justify-between gap-3 px-4 py-4">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xl shrink-0">{app.icon}</span>
              <p className="text-sm font-medium text-gray-900 truncate">{app.name}</p>
            </div>
            <span className="text-xs text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full shrink-0 whitespace-nowrap">Coming soon</span>
          </div>
        ))}
      </div>
    </div>
  )
}
