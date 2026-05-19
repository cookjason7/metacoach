import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useUser } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
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

const ANGLES = ['front', 'side', 'back']

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
}

function formatLastActive(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86400_000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 30) return `${diffDays}d ago`
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
}

function formatConnectedAt(iso) {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function roleLabel(role) {
  if (!role) return 'Staff'
  return role.charAt(0).toUpperCase() + role.slice(1)
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
      <p className="text-[11px] sm:text-xs font-medium text-gray-600 mb-1.5 capitalize">{angle}</p>
      <div
        onClick={() => !uploading && inputRef.current?.click()}
        className={`w-full aspect-[4/5] rounded-lg sm:rounded-xl border-2 overflow-hidden cursor-pointer transition-colors flex items-center justify-center ${
          latest ? 'border-gray-200' : 'border-dashed border-gray-300 bg-gray-50 hover:border-[#E8670A] hover:bg-[#fff7ed]'
        }`}
      >
        {latest ? (
          <img src={latest.photo_url} alt={angle} className="w-full h-full object-cover" />
        ) : uploading ? (
          <span className="text-[10px] sm:text-xs text-gray-400">Uploading…</span>
        ) : (
          <span className="text-[10px] sm:text-xs text-gray-400 px-1.5 text-center leading-tight">Tap to upload</span>
        )}
      </div>
      {latest && (
        <p className="text-[10px] sm:text-xs text-gray-400 mt-1">{new Date(latest.taken_at).toLocaleDateString()}</p>
      )}
      {photos.length > 1 && (
        <p className="text-[10px] sm:text-xs text-gray-400">{photos.length} photos</p>
      )}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="text-[11px] sm:text-xs text-[#E8670A] hover:text-[#c45e09] mt-1 transition-colors disabled:opacity-50"
      >
        {uploading ? 'Uploading…' : latest ? 'Add Photo' : 'Upload'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"

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
  const [nameEditing, setNameEditing] = useState(false)
  const [team, setTeam] = useState([])
  const [teamLoading, setTeamLoading] = useState(false)
  const [teamError, setTeamError] = useState(null)
  const [showArchivedStaff, setShowArchivedStaff] = useState(false)
  const [editMember, setEditMember] = useState(null)   // staff object being edited
  const [editForm, setEditForm] = useState({})
  const [editSaving, setEditSaving] = useState(false)
  const [editSaved, setEditSaved] = useState(false)
  const [editError, setEditError] = useState(null)
  const [archiving, setArchiving] = useState(false)

  // Health assessment
  const [assessment,     setAssessment]     = useState(null)
  const [aForm,          setAForm]          = useState(EMPTY_ASSESSMENT)
  const [aOpen,          setAOpen]          = useState(false)
  const [aSaving,        setASaving]        = useState(false)
  const [aSaved,         setASaved]         = useState(false)
  const [aError,         setAError]         = useState(null)

  // Progress photos: each angle holds an array sorted newest-first
  const [photos, setPhotos] = useState({ front: [], back: [], side: [] })

  // Measurements
  const [measurements,   setMeasurements]   = useState([])
  const [mForm,          setMForm]          = useState({
    measurement_date: new Date().toISOString().slice(0, 10),
    chest: '', waist: '', hips: '',
  })
  const [mSaving, setMSaving] = useState(false)
  const [mSaved,  setMSaved]  = useState(false)
  const [mError,  setMError]  = useState(null)
  const [fitbitStatus, setFitbitStatus] = useState({ connected: false, last_synced_at: null, fitbit_user_id: null })
  const [fitbitLoading, setFitbitLoading] = useState(false)
  const [fitbitSyncing, setFitbitSyncing] = useState(false)
  const [fitbitMessage, setFitbitMessage] = useState('')
  const [fitbitError, setFitbitError] = useState('')

  const email = user?.primaryEmailAddress?.emailAddress ?? ''

  useEffect(() => {
    async function load() {
      const token = await getToken()
      const profileRes = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
      let loadedProfile = null
      if (profileRes.ok) {
        const data = await profileRes.json()
        loadedProfile = data
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
      if (loadedProfile?.role === 'admin' || loadedProfile?.role === 'coach') {
        loadTeam(token, false)
        return
      }

      const [photosRes, assessmentRes, measurementsRes, fitbitRes] = await Promise.all([
        fetch(`${API_URL}/api/progress-photos`,       { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/health-assessment/me`,  { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/measurements`,          { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/fitbit/status`,         { headers: { Authorization: `Bearer ${token}` } }),
      ])
      if (photosRes.ok) {
        const list = await photosRes.json()
        // Group by angle, newest first (API returns newest-first already)
        const byAngle = { front: [], back: [], side: [] }
        for (const p of list) {
          if (byAngle[p.angle]) byAngle[p.angle].push(p)
        }
        setPhotos(byAngle)
      }
      if (measurementsRes.ok) setMeasurements(await measurementsRes.json())
      if (fitbitRes.ok) setFitbitStatus(await fitbitRes.json())
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
      setNameEditing(false)
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

  async function saveMeasurement(e) {
    e.preventDefault()
    setMSaving(true); setMError(null); setMSaved(false)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/measurements`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          measurement_date: mForm.measurement_date,
          chest: mForm.chest !== '' ? Number(mForm.chest) : null,
          waist: mForm.waist !== '' ? Number(mForm.waist) : null,
          hips:  mForm.hips  !== '' ? Number(mForm.hips)  : null,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      const m = await res.json()
      setMeasurements(prev => [m, ...prev])
      setMForm({ measurement_date: new Date().toISOString().slice(0, 10), chest: '', waist: '', hips: '' })
      setMSaved(true)
      setTimeout(() => setMSaved(false), 3000)
    } catch (err) {
      setMError('Failed to save. Please try again.')
    } finally {
      setMSaving(false)
    }
  }

  function connectFitbit() {
    setFitbitError('')
    setFitbitMessage('')
    window.location.href = `${API_URL}/api/fitbit/connect`
  }

  async function refreshFitbitStatus() {
    setFitbitLoading(true)
    setFitbitError('')
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/fitbit/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Unable to load Fitbit status')
      setFitbitStatus(await res.json())
    } catch (err) {
      setFitbitError(err.message)
    } finally {
      setFitbitLoading(false)
    }
  }

  async function syncFitbit() {
    setFitbitSyncing(true)
    setFitbitError('')
    setFitbitMessage('')
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/fitbit/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Fitbit sync failed')
      setFitbitStatus(status => ({
        ...status,
        connected: true,
        last_synced_at: data.synced_at,
      }))
      const parts = []
      if (data.steps != null) parts.push(`${data.steps.toLocaleString()} steps`)
      if (data.sleep_minutes != null) parts.push(`${Math.floor(data.sleep_minutes / 60)}h ${data.sleep_minutes % 60}m sleep`)
      setFitbitMessage(parts.length ? `Synced ${parts.join(' and ')}.` : 'Google Health synced.')
    } catch (err) {
      setFitbitError(err.message)
    } finally {
      setFitbitSyncing(false)
    }
  }

  async function disconnectFitbit() {
    setFitbitLoading(true)
    setFitbitError('')
    setFitbitMessage('')
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/fitbit/disconnect`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Fitbit disconnect failed')
      setFitbitStatus({ connected: false, last_synced_at: null, fitbit_user_id: null })
      setFitbitMessage('Google Health disconnected.')
    } catch (err) {
      setFitbitError(err.message)
    } finally {
      setFitbitLoading(false)
    }
  }

  async function loadTeam(token, archived) {
    setTeamLoading(true)
    setTeamError(null)
    try {
      const status = archived ? 'archived' : 'active'
      const res = await fetch(`${API_URL}/api/coach-admin/team?status=${status}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      setTeam(await res.json())
    } catch (err) {
      setTeamError(err.message)
    } finally {
      setTeamLoading(false)
    }
  }

  async function toggleArchivedStaff() {
    const next = !showArchivedStaff
    setShowArchivedStaff(next)
    const token = await getToken()
    loadTeam(token, next)
  }

  async function archiveStaff() {
    setArchiving(true); setEditError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/staff/${editMember.id}/archive`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Failed to archive')
      setTeam(prev => prev.filter(m => m.id !== editMember.id))
      setEditMember(null)
    } catch (err) {
      setEditError(err.message)
    } finally {
      setArchiving(false)
    }
  }

  async function reactivateStaff() {
    setArchiving(true); setEditError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/staff/${editMember.id}/reactivate`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Failed to reactivate')
      setTeam(prev => prev.filter(m => m.id !== editMember.id))
      setEditMember(null)
    } catch (err) {
      setEditError(err.message)
    } finally {
      setArchiving(false)
    }
  }

  async function openEdit(member) {
    setEditError(null)
    setEditSaved(false)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/staff/${member.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setEditMember(data)
      setEditForm({
        first_name:   data.first_name   ?? '',
        last_name:    data.last_name    ?? '',
        phone_number: data.phone_number ?? '',
        role:         data.role         ?? 'coach',
      })
    } catch (err) {
      // Fall back to what we already have in the list
      setEditMember(member)
      setEditForm({
        first_name:   member.first_name ?? (member.name?.split(' ')[0] ?? ''),
        last_name:    member.last_name  ?? (member.name?.split(' ').slice(1).join(' ') ?? ''),
        phone_number: member.phone_number ?? '',
        role:         member.role ?? 'coach',
      })
    }
  }

  async function saveEdit(e) {
    e.preventDefault()
    setEditSaving(true); setEditError(null)
    try {
      const token = await getToken()
      const payload = {
        first_name:   editForm.first_name.trim()   || null,
        last_name:    editForm.last_name.trim()     || null,
        phone_number: editForm.phone_number.trim()  || null,
        ...(profile?.role === 'admin' ? { role: editForm.role } : {}),
      }
      const res = await fetch(`${API_URL}/api/coach-admin/staff/${editMember.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('Failed to save')
      const updated = await res.json()
      setTeam(prev => prev.map(m => m.id === updated.id ? {
        ...m,
        name: [updated.first_name, updated.last_name].filter(Boolean).join(' ') || m.name,
        first_name: updated.first_name,
        last_name:  updated.last_name,
        phone_number: updated.phone_number,
        role: updated.role,
      } : m))
      setEditSaved(true)
      setTimeout(() => { setEditMember(null); setEditSaved(false) }, 1000)
    } catch (err) {
      setEditError(err.message)
    } finally {
      setEditSaving(false)
    }
  }

  const anglesWithComparison = ANGLES.filter(a => photos[a].length >= 2)
  const isStaff = profile?.role === 'admin' || profile?.role === 'coach'

  return (
    <div className="w-full max-w-lg mx-auto pb-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Settings</h1>
      <p className="text-sm text-gray-500 mb-8">Account and preferences</p>

      {/* Account */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">Account</h2>
        {!nameEditing && (
          <button
            type="button"
            onClick={() => { setNameEditing(true); setNameSaved(false); setNameError(null) }}
            className="text-xs font-semibold text-[#E8670A] hover:text-[#c45e09] px-2 py-1 rounded-lg hover:bg-orange-50 transition-colors"
          >
            Edit
          </button>
        )}
      </div>
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
        <form onSubmit={saveName} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="First name">
              <input
                type="text"
                name="first_name"
                value={form.first_name}
                onChange={set}
                placeholder="First name"
                readOnly={!nameEditing}
                className={`w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A] ${
                  nameEditing ? 'bg-white' : 'bg-gray-50 text-gray-600 cursor-default'
                }`}
              />
            </Field>
            <Field label="Last name">
              <input
                type="text"
                name="last_name"
                value={form.last_name}
                onChange={set}
                placeholder="Last name"
                readOnly={!nameEditing}
                className={`w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A] ${
                  nameEditing ? 'bg-white' : 'bg-gray-50 text-gray-600 cursor-default'
                }`}
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
          {nameEditing ? (
            <button
              type="submit"
              disabled={nameSaving}
              className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors disabled:opacity-60"
            >
              {nameSaving ? 'Saving…' : 'Save Name'}
            </button>
          ) : nameSaved ? (
            <p className="text-xs font-medium text-emerald-600">Saved!</p>
          ) : null}
        </form>
      </div>

      {isStaff ? (
        <>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">
              Team / Coaches{showArchivedStaff ? ' — Archived' : ''}
            </h2>
            {profile?.role === 'admin' && (
              <button
                type="button"
                onClick={toggleArchivedStaff}
                className="text-xs font-semibold text-gray-500 hover:text-gray-700 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors"
              >
                {showArchivedStaff ? 'Show active' : 'Show archived'}
              </button>
            )}
          </div>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {teamLoading ? (
              <p className="text-sm text-gray-400 p-5">Loading team...</p>
            ) : teamError ? (
              <p className="text-sm text-red-500 p-5">{teamError}</p>
            ) : team.length === 0 ? (
              <p className="text-sm text-gray-500 p-5">No staff found yet.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {team.map(member => {
                  const count = Number(member.assigned_client_count) || 0
                  return (
                    <div key={member.id} className="p-4 sm:p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{member.name || member.email || 'Staff'}</p>
                          {member.email && <p className="text-xs text-gray-400 truncate mt-0.5">{member.email}</p>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-bold text-gray-600">
                            {roleLabel(member.role)}
                          </span>
                          <button
                            type="button"
                            onClick={() => openEdit(member)}
                            className="text-xs font-semibold text-[#E8670A] hover:text-[#c45e09] px-2 py-1 rounded-lg hover:bg-orange-50 transition-colors"
                          >
                            Edit
                          </button>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                        <div>
                          <p className="text-gray-400">Last active</p>
                          <p className="font-medium text-gray-700 mt-0.5">{formatLastActive(member.last_login_at)}</p>
                        </div>
                        <div>
                          <p className="text-gray-400">Assigned clients</p>
                          {count > 0 ? (
                            <Link
                              to={`/admin/clients?coach_id=${member.id}`}
                              className="inline-flex mt-0.5 font-semibold text-[#E8670A] hover:text-[#c45e09]"
                            >
                              {count}
                            </Link>
                          ) : (
                            <p className="font-medium text-gray-700 mt-0.5">0</p>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Staff edit modal */}
          {editMember && (
            <div
              className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-4 pb-4 sm:pb-0"
              onClick={e => { if (e.target === e.currentTarget) { setEditMember(null); setEditSaved(false) } }}
            >
              <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">Edit Staff Profile</h3>
                  <button
                    type="button"
                    onClick={() => { setEditMember(null); setEditSaved(false) }}
                    className="text-gray-400 hover:text-gray-600 text-lg leading-none px-1"
                    aria-label="Close"
                  >×</button>
                </div>
                <form onSubmit={saveEdit} className="p-5 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">First name</label>
                      <input
                        type="text"
                        value={editForm.first_name}
                        onChange={e => setEditForm(f => ({ ...f, first_name: e.target.value }))}
                        placeholder="First name"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Last name</label>
                      <input
                        type="text"
                        value={editForm.last_name}
                        onChange={e => setEditForm(f => ({ ...f, last_name: e.target.value }))}
                        placeholder="Last name"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                    <input
                      type="email"
                      value={editMember.email ?? ''}
                      readOnly
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
                    <input
                      type="tel"
                      value={editForm.phone_number}
                      onChange={e => setEditForm(f => ({ ...f, phone_number: e.target.value }))}
                      placeholder="Phone number"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
                    />
                  </div>
                  {profile?.role === 'admin' && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
                      <select
                        value={editForm.role}
                        onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A] bg-white"
                      >
                        <option value="coach">Coach</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                  )}
                  {(editMember.street_address || editMember.city || editMember.state) && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Mailing address</label>
                      <p className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2 leading-relaxed">
                        {[editMember.street_address, editMember.city, editMember.state, editMember.zip_code, editMember.country]
                          .filter(Boolean).join(', ')}
                      </p>
                    </div>
                  )}
                  {editError && <p className="text-xs text-red-500">{editError}</p>}
                  <button
                    type="submit"
                    disabled={editSaving || editSaved}
                    className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors disabled:opacity-60"
                  >
                    {editSaved ? 'Saved!' : editSaving ? 'Saving…' : 'Save Changes'}
                  </button>
                  {profile?.role === 'admin' && editMember?.id !== profile?.id && (
                    editMember?.staff_status === 'archived' ? (
                      <button
                        type="button"
                        onClick={reactivateStaff}
                        disabled={archiving}
                        className="w-full py-2 rounded-lg text-sm font-semibold border border-emerald-300 text-emerald-700 hover:bg-emerald-50 transition-colors disabled:opacity-60"
                      >
                        {archiving ? 'Reactivating…' : 'Reactivate'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={archiveStaff}
                        disabled={archiving}
                        className="w-full py-2 rounded-lg text-sm font-semibold border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-red-600 hover:border-red-200 transition-colors disabled:opacity-60"
                      >
                        {archiving ? 'Archiving…' : 'Archive staff member'}
                      </button>
                    )
                  )}
                </form>
              </div>
            </div>
          )}
        </>
      ) : profile ? (
        <>
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
          <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4 mb-8">
            <p className="text-xs sm:text-sm text-gray-500 mb-3 sm:mb-4">Upload front, side, and back photos to track your visual progress over time.</p>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
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

          {/* Measurements */}
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Measurements</h2>
          <div className="bg-white rounded-xl border border-gray-200 p-4 mb-8">
            <p className="text-sm text-gray-500 mb-4">Track chest, waist, and hip measurements over time.</p>
            <form onSubmit={saveMeasurement} className="space-y-3 mb-5">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
                <input type="date" value={mForm.measurement_date}
                  onChange={e => setMForm(f => ({ ...f, measurement_date: e.target.value }))}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full max-w-[180px] focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { key: 'chest', label: 'Chest/Bust', sub: 'nipple line' },
                  { key: 'waist', label: 'Waist',      sub: 'belly button' },
                  { key: 'hips',  label: 'Hips',       sub: 'widest point' },
                ].map(({ key, label, sub }) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      {label}
                      <span className="block text-[10px] font-normal text-gray-400">{sub}</span>
                    </label>
                    <div className="relative">
                      <input type="number" step="0.1" min="0" value={mForm[key]}
                        onChange={e => setMForm(f => ({ ...f, [key]: e.target.value }))}
                        placeholder="0.0"
                        className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full pr-7 focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]" />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">in</span>
                    </div>
                  </div>
                ))}
              </div>
              {mError && <p className="text-xs text-red-500">{mError}</p>}
              <button type="submit" disabled={mSaving}
                className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors disabled:opacity-60">
                {mSaved ? 'Saved!' : mSaving ? 'Saving…' : 'Save Measurement'}
              </button>
            </form>

            {measurements.length > 0 && (
              <div className="overflow-x-auto -mx-4 px-4">
                <p className="text-xs font-semibold text-gray-600 mb-2">Recent</p>
                <table className="w-full text-xs min-w-[280px]">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 text-[10px] uppercase tracking-wide">
                      <th className="px-3 py-2 text-left font-semibold">Date</th>
                      <th className="px-3 py-2 text-right font-semibold">Chest</th>
                      <th className="px-3 py-2 text-right font-semibold">Waist</th>
                      <th className="px-3 py-2 text-right font-semibold">Hips</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {measurements.slice(0, 5).map((m, i) => (
                      <tr key={m.id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}>
                        <td className="px-3 py-2 text-gray-700 font-medium whitespace-nowrap">{String(m.measurement_date).slice(0, 10)}</td>
                        <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.chest ? `${Number(m.chest).toFixed(1)}"` : '—'}</td>
                        <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.waist ? `${Number(m.waist).toFixed(1)}"` : '—'}</td>
                        <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.hips  ? `${Number(m.hips).toFixed(1)}"` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Connected Apps */}
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Connected Apps</h2>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {[
              { name: 'Apple Health',  icon: '🍎' },
              { name: 'Google Fit',    icon: '🏃' },
              { name: 'Google Health', icon: '❤️' },
            ].map(app => (
              app.name === 'Google Health' ? (
                <div key={app.name} className="px-4 py-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="text-xl shrink-0">{app.icon}</span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-gray-900">Google Health</p>
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                            fitbitStatus.connected
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                              : 'bg-gray-100 text-gray-400'
                          }`}>
                            {fitbitStatus.connected ? 'Google Health Connected' : 'Not connected'}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          Sync steps and sleep from Fitbit and other connected health apps.
                        </p>
                        {fitbitStatus.connected && (
                          <p className="text-xs text-gray-400 mt-1">
                            {formatConnectedAt(fitbitStatus.last_synced_at)
                              ? `Last synced ${formatConnectedAt(fitbitStatus.last_synced_at)}`
                              : 'Not synced yet'}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 sm:justify-end">
                      {fitbitStatus.connected ? (
                        <>
                          <button
                            type="button"
                            onClick={syncFitbit}
                            disabled={fitbitSyncing || fitbitLoading}
                            className="px-3 py-2 rounded-lg bg-[#E8670A] text-white text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors"
                          >
                            {fitbitSyncing ? 'Syncing...' : 'Sync Now'}
                          </button>
                          <button
                            type="button"
                            onClick={disconnectFitbit}
                            disabled={fitbitSyncing || fitbitLoading}
                            className="px-3 py-2 rounded-lg border border-gray-200 text-gray-600 text-xs font-semibold hover:bg-gray-50 disabled:opacity-60 transition-colors"
                          >
                            Disconnect
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={connectFitbit}
                          disabled={fitbitLoading}
                          className="px-3 py-2 rounded-lg bg-[#1e2a3a] text-white text-xs font-semibold hover:bg-[#111827] disabled:opacity-60 transition-colors"
                        >
                          Connect Google Health
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={refreshFitbitStatus}
                        disabled={fitbitLoading || fitbitSyncing}
                        className="px-3 py-2 rounded-lg border border-gray-200 text-gray-500 text-xs font-semibold hover:bg-gray-50 disabled:opacity-60 transition-colors"
                      >
                        Refresh
                      </button>
                    </div>
                  </div>
                  {fitbitMessage && <p className="text-xs text-emerald-600 mt-3">{fitbitMessage}</p>}
                  {fitbitError && <p className="text-xs text-red-500 mt-3">{fitbitError}</p>}
                </div>
              ) : (
                <div key={app.name} className="flex items-center justify-between gap-3 px-4 py-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xl shrink-0">{app.icon}</span>
                    <p className="text-sm font-medium text-gray-900 truncate">{app.name}</p>
                  </div>
                  <span className="text-xs text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full shrink-0 whitespace-nowrap">Coming soon</span>
                </div>
              )
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
