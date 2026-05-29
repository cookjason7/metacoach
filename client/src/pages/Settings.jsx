import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useUser } from '@clerk/clerk-react'
import { Link, useLocation } from 'react-router-dom'
import { API_URL } from '../config.js'
import BloodworkIntakeForm from '../components/BloodworkIntakeForm.jsx'

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

function ProgressPhotoPanel({ angle, photos, getToken, onUploaded, onDeleted }) {
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
          <img src={latest.photo_url} alt={angle} className="w-full h-full object-contain" />
        ) : uploading ? (
          <span className="text-[10px] sm:text-xs text-gray-400">Uploading…</span>
        ) : (
          <span className="text-[10px] sm:text-xs text-gray-400 px-1.5 text-center leading-tight">Tap to upload</span>
        )}
      </div>
      {latest && (
        <div className="mt-1">
          <p className="text-[10px] sm:text-xs text-gray-400">{new Date(latest.taken_at).toLocaleDateString()}</p>
          <button
            type="button"
            onClick={() => onDeleted(latest.id, angle)}
            className="text-[11px] sm:text-xs text-red-500 hover:text-red-600 transition-colors"
          >
            Delete
          </button>
        </div>
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

const BLOODWORK_CLIENT_ENABLED = import.meta.env.VITE_BLOODWORK_CLIENT_ENABLED === 'true'

function BloodworkSection({ getToken, profile }) {
  const [uploads, setUploads] = useState([])
  const [loadingList, setLoadingList] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState(null)
  const [labDate, setLabDate] = useState('')
  const [notes, setNotes] = useState('')
  const [uploadError, setUploadError] = useState(null)
  const fileRef = useRef(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/bloodwork`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setUploads(await res.json())
      } finally { setLoadingList(false) }
    }
    load()
  }, [getToken])

  async function handleUpload(e) {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      const token = await getToken()
      const body = new FormData()
      body.append('file', file)
      if (labDate) body.append('lab_date', labDate)
      if (notes.trim()) body.append('notes', notes.trim())
      const res = await fetch(`${API_URL}/api/bloodwork`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      const data = await res.json()
      if (!res.ok) { setUploadError(data.error ?? 'Upload failed.'); return }
      setUploads(prev => [data, ...prev])
      setFile(null)
      setLabDate('')
      setNotes('')
      if (fileRef.current) fileRef.current.value = ''
    } catch { setUploadError('Upload failed. Please try again.') }
    finally { setUploading(false) }
  }

  async function viewFile(id) {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/bloodwork/${id}/file`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const { url } = await res.json()
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    } catch { /* silent */ }
  }

  function fmtDate(iso) {
    if (!iso) return null
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="space-y-4 mb-8">
      <BloodworkIntakeForm
        intakeUrl={`${API_URL}/api/bloodwork/intake`}
        getToken={getToken}
        defaults={{
          age:           profile?.age,
          sex:           profile?.gender,
          height_inches: profile?.height_inches,
          weight_lbs:    profile?.starting_weight_lbs,
        }}
      />

      <div className="bg-white rounded-xl border border-gray-200 p-5">
      <p className="text-sm font-semibold text-gray-800 mb-1">Upload Lab Results</p>
      <p className="text-xs text-gray-500 mb-4">PDF, JPG, PNG, or WEBP. Max 20 MB. Your coach will be able to review and provide an AI-assisted educational summary.</p>

      <form onSubmit={handleUpload} className="space-y-3 mb-6">
        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            className="hidden"
            onChange={e => setFile(e.target.files[0] ?? null)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full py-2.5 rounded-lg border-2 border-dashed border-gray-300 text-sm text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors bg-gray-50"
          >
            {file ? file.name : 'Choose file…'}
          </button>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Lab date (optional)</label>
          <input
            type="date"
            value={labDate}
            onChange={e => setLabDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full max-w-[200px] focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. fasting labs, thyroid panel"
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
          />
        </div>
        {uploadError && <p className="text-xs text-red-500">{uploadError}</p>}
        <button
          type="submit"
          disabled={uploading || !file}
          className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      <p className="text-xs font-semibold text-gray-700 mb-2">Past uploads</p>
      {loadingList ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : uploads.length === 0 ? (
        <p className="text-xs text-gray-400">No bloodwork uploaded yet.</p>
      ) : (
        <ul className="space-y-2">
          {uploads.map(u => (
            <li key={u.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-800 truncate">{u.original_filename}</p>
                {u.lab_date && <p className="text-[11px] text-gray-400">{fmtDate(u.lab_date)}</p>}
                {!u.has_text && (
                  <p className="text-[10px] text-amber-600 mt-0.5">Could not extract readable lab text from this file. Please upload a clearer image or text-based PDF.</p>
                )}
              </div>
              <button
                onClick={() => viewFile(u.id)}
                className="shrink-0 text-xs font-medium text-[#E8670A] hover:text-[#c45e09]"
              >
                View
              </button>
            </li>
          ))}
        </ul>
      )}
      </div>
    </div>
  )
}

export default function Settings() {
  const { getToken }   = useAuth()
  const { user }       = useUser()
  const location       = useLocation()
  const [profile, setProfile]             = useState(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileError, setProfileError]   = useState(null)
  const [profileLoadKey, setProfileLoadKey] = useState(0)
  const [form, setForm]       = useState({
    first_name: '', last_name: '', age: '', feet: '', inches: '', activity_level: '',
    gender: '', phone_number: '',
  })
  const [saving, setSaving]   = useState(false)
  const [saved,  setSaved]    = useState(false)
  const [error,  setError]    = useState(null)
  const [prefForm, setPrefForm] = useState({ food_dislikes: '', food_allergies: '' })
  const [prefSaving, setPrefSaving] = useState(false)
  const [prefSaved,  setPrefSaved]  = useState(false)
  const [prefError,  setPrefError]  = useState(null)
  const [notifForm, setNotifForm] = useState({
    notif_master_enabled:    true,
    notif_dm_enabled:        true,
    notif_community_enabled: true,
  })
  const [notifSaving, setNotifSaving] = useState(false)
  const [notifSaved,  setNotifSaved]  = useState(false)
  const [notifError,  setNotifError]  = useState(null)
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
  const [editingMeasurementId, setEditingMeasurementId] = useState(null)
  const [measurementsOpen, setMeasurementsOpen] = useState(false)
  const [bloodworkOpen, setBloodworkOpen] = useState(false)
  const [fitbitStatus, setFitbitStatus] = useState({ connected: false, last_synced_at: null, fitbit_user_id: null })
  const [fitbitLoading, setFitbitLoading] = useState(false)
  const [fitbitSyncing, setFitbitSyncing] = useState(false)
  const [fitbitMessage, setFitbitMessage] = useState('')
  const [fitbitError, setFitbitError] = useState('')

  const email = user?.primaryEmailAddress?.emailAddress ?? ''

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('section') === 'bloodwork' && BLOODWORK_CLIENT_ENABLED) setBloodworkOpen(true)
  }, [location.search])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setProfileLoading(true)
      setProfileError(null)
      try {
        const token = await getToken()
        const profileRes = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
        if (!profileRes.ok) throw new Error(`Could not load profile (${profileRes.status})`)
        let loadedProfile = null
        const data = await profileRes.json()
        loadedProfile = data
        if (cancelled) return
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
        setPrefForm({
          food_dislikes:  data.food_dislikes  ?? '',
          food_allergies: data.food_allergies ?? '',
        })
        setNotifForm({
          notif_master_enabled:    data.notif_master_enabled    ?? true,
          notif_dm_enabled:        data.notif_dm_enabled        ?? true,
          notif_community_enabled: data.notif_community_enabled ?? true,
        })

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
        if (cancelled) return
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
          const aData = await assessmentRes.json()
          if (aData) {
            setAssessment(aData)
            setAForm({
              first_name:     aData.first_name     ?? '',
              last_name:      aData.last_name      ?? '',
              phone:          aData.phone          ?? '',
              street_address: aData.street_address ?? '',
              city:           aData.city           ?? '',
              state:          aData.state          ?? '',
              zip_code:       aData.zip_code       ?? '',
              country:        aData.country        ?? 'United States',
              date_of_birth:  aData.date_of_birth  ? aData.date_of_birth.slice(0, 10) : '',
              shirt_size:           aData.shirt_size           ?? '',
              supplements:          aData.supplements          ?? '',
              goals_6_months:       aData.goals_6_months       ?? '',
              injuries_limitations: aData.injuries_limitations ?? '',
              num_kids:             aData.num_kids             != null ? String(aData.num_kids) : '',
              occupation:           aData.occupation           ?? '',
              energy_level:         aData.energy_level         ?? null,
              sleep_hours:          aData.sleep_hours          ?? '',
              stress_management:    aData.stress_management    ?? null,
              sleep_quality:        aData.sleep_quality        ?? null,
              daily_water:          aData.daily_water          ?? '',
              alcohol_weekdays:     aData.alcohol_weekdays     != null ? String(aData.alcohol_weekdays) : '0',
              alcohol_weekends:     aData.alcohol_weekends     != null ? String(aData.alcohol_weekends) : '0',
              happiness_level:      aData.happiness_level      ?? null,
              confidence_level:     aData.confidence_level     ?? null,
              activity_level:       aData.activity_level       ?? '',
            })
          }
        }
      } catch (err) {
        if (!cancelled) setProfileError('Could not load your settings. Please check your connection and try again.')
      } finally {
        if (!cancelled) setProfileLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [getToken, profileLoadKey])

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

  async function savePreferences(e) {
    e.preventDefault()
    setPrefSaving(true); setPrefError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/users/me`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          food_dislikes:  prefForm.food_dislikes.trim()  || '',
          food_allergies: prefForm.food_allergies.trim() || '',
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setPrefSaved(true)
      setTimeout(() => setPrefSaved(false), 2500)
    } catch (err) {
      setPrefError(err.message)
    } finally {
      setPrefSaving(false)
    }
  }

  async function saveNotifPrefs() {
    setNotifSaving(true); setNotifError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/users/me`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notif_master_enabled:    notifForm.notif_master_enabled,
          notif_dm_enabled:        notifForm.notif_dm_enabled,
          notif_community_enabled: notifForm.notif_community_enabled,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setNotifSaved(true)
      setTimeout(() => setNotifSaved(false), 2500)
    } catch (err) {
      setNotifError(err.message)
    } finally {
      setNotifSaving(false)
    }
  }

  function handlePhotoUploaded(photo) {
    setPhotos(prev => ({
      ...prev,
      [photo.angle]: [photo, ...(prev[photo.angle] ?? [])],
    }))
  }

  async function deleteProgressPhoto(photoId, angle) {
    if (!window.confirm('Delete this progress photo? This cannot be undone.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/progress-photos/${photoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      setPhotos(prev => ({
        ...prev,
        [angle]: (prev[angle] ?? []).filter(p => p.id !== photoId),
      }))
    }
  }

  function editMeasurement(m) {
    setEditingMeasurementId(m.id)
    setMError(null)
    setMSaved(false)
    setMForm({
      measurement_date: String(m.measurement_date).slice(0, 10),
      chest: m.chest ?? '',
      waist: m.waist ?? '',
      hips: m.hips ?? '',
    })
  }

  function resetMeasurementForm() {
    setEditingMeasurementId(null)
    setMForm({ measurement_date: new Date().toISOString().slice(0, 10), chest: '', waist: '', hips: '' })
  }

  async function saveMeasurement(e) {
    e.preventDefault()
    setMSaving(true); setMError(null); setMSaved(false)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/measurements${editingMeasurementId ? `/${editingMeasurementId}` : ''}`, {
        method: editingMeasurementId ? 'PATCH' : 'POST',
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
      setMeasurements(prev => {
        const next = editingMeasurementId
          ? prev.map(item => item.id === editingMeasurementId ? m : item)
          : [m, ...prev]
        return next.sort((a, b) => String(b.measurement_date).localeCompare(String(a.measurement_date)))
      })
      resetMeasurementForm()
      setMSaved(true)
      setTimeout(() => setMSaved(false), 3000)
    } catch (err) {
      setMError('Failed to save. Please try again.')
    } finally {
      setMSaving(false)
    }
  }

  async function deleteMeasurement(id) {
    if (!window.confirm('Delete this measurement entry? This cannot be undone.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/measurements/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      setMeasurements(prev => prev.filter(m => m.id !== id))
      if (editingMeasurementId === id) resetMeasurementForm()
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

      {/* Profile loading skeleton */}
      {profileLoading && (
        <div className="animate-pulse space-y-4 mb-8">
          <div className="h-5 bg-gray-100 rounded w-24" />
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <div className="h-9 bg-gray-100 rounded-lg" />
            <div className="h-9 bg-gray-100 rounded-lg" />
            <div className="h-9 bg-gray-100 rounded-lg" />
          </div>
        </div>
      )}

      {/* Profile error */}
      {profileError && !profileLoading && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-6 mb-8 text-center">
          <p className="text-2xl mb-2">⚠️</p>
          <p className="text-sm font-semibold text-gray-700 mb-1">Could not load settings</p>
          <p className="text-xs text-gray-500 mb-4">{profileError}</p>
          <button
            type="button"
            onClick={() => setProfileLoadKey(k => k + 1)}
            className="inline-flex items-center gap-1.5 bg-[#E8670A] text-white text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-[#c45e09] transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {/* Account (shown once profile loads) */}
      {!profileLoading && !profileError && (
      <>

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

          {BLOODWORK_CLIENT_ENABLED && (
            <div className="bg-white rounded-xl border border-gray-200 mb-8 overflow-hidden">
              <button
                type="button"
                onClick={() => setBloodworkOpen(open => !open)}
                className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left"
              >
                <span className="text-sm font-semibold text-gray-700">Bloodwork</span>
                <span className="text-lg leading-none text-gray-400">{bloodworkOpen ? '-' : '+'}</span>
              </button>
              {bloodworkOpen && (
                <div className="border-t border-gray-100 p-5">
                  <BloodworkSection getToken={getToken} profile={profile} />
                </div>
              )}
            </div>
          )}

          {/* Measurements */}
          <div className="bg-white rounded-xl border border-gray-200 mb-8 overflow-hidden">
            <button
              type="button"
              onClick={() => setMeasurementsOpen(open => !open)}
              className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left"
            >
              <span className="text-sm font-semibold text-gray-700">Measurements</span>
              <span className="text-lg leading-none text-gray-400">{measurementsOpen ? '-' : '+'}</span>
            </button>
            {measurementsOpen && (
              <div className="border-t border-gray-100 p-4">
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
                      <th className="px-3 py-2 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {measurements.slice(0, 5).map((m, i) => (
                      <tr key={m.id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}>
                        <td className="px-3 py-2 text-gray-700 font-medium whitespace-nowrap">{String(m.measurement_date).slice(0, 10)}</td>
                        <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.chest ? `${Number(m.chest).toFixed(1)}"` : '-'}</td>
                        <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.waist ? `${Number(m.waist).toFixed(1)}"` : '-'}</td>
                        <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.hips  ? `${Number(m.hips).toFixed(1)}"` : '-'}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <button type="button" onClick={() => editMeasurement(m)} className="text-[#E8670A] font-semibold mr-3">Edit</button>
                          <button type="button" onClick={() => deleteMeasurement(m.id)} className="text-red-500 font-semibold">Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
              </div>
            )}
          </div>

          {/* Food Preferences */}
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Food Preferences</h2>
          <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
            <p className="text-xs text-gray-500 mb-4">
              Katie uses these when building meal plans. Leave blank if you have none.
            </p>
            <form onSubmit={savePreferences} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Allergies &amp; intolerances
                </label>
                <textarea
                  rows={2}
                  value={prefForm.food_allergies}
                  onChange={e => setPrefForm(f => ({ ...f, food_allergies: e.target.value }))}
                  placeholder="e.g. dairy, gluten, tree nuts, shellfish"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Foods I dislike
                </label>
                <textarea
                  rows={2}
                  value={prefForm.food_dislikes}
                  onChange={e => setPrefForm(f => ({ ...f, food_dislikes: e.target.value }))}
                  placeholder="e.g. mushrooms, fish, Brussels sprouts"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
                />
              </div>
              {prefError && <p className="text-xs text-red-500">{prefError}</p>}
              <button
                type="submit"
                disabled={prefSaving}
                className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors disabled:opacity-60"
              >
                {prefSaved ? 'Saved!' : prefSaving ? 'Saving…' : 'Save Preferences'}
              </button>
            </form>
          </div>

          {/* Notifications */}
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Notifications</h2>
          <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8 space-y-4">
            {/* Master toggle */}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800">Push notifications</p>
                <p className="text-xs text-gray-500 mt-0.5">Receive push notifications on this device</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={notifForm.notif_master_enabled}
                onClick={() => setNotifForm(f => ({ ...f, notif_master_enabled: !f.notif_master_enabled }))}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#E8670A]/40 ${
                  notifForm.notif_master_enabled ? 'bg-[#E8670A]' : 'bg-gray-200'
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  notifForm.notif_master_enabled ? 'translate-x-5' : 'translate-x-0'
                }`} />
              </button>
            </div>

            {/* Sub-toggles — disabled when master is off */}
            <div className={`space-y-3 pl-0 transition-opacity ${notifForm.notif_master_enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-gray-700">New message alerts</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={notifForm.notif_dm_enabled}
                  disabled={!notifForm.notif_master_enabled}
                  onClick={() => setNotifForm(f => ({ ...f, notif_dm_enabled: !f.notif_dm_enabled }))}
                  className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#E8670A]/40 ${
                    notifForm.notif_dm_enabled ? 'bg-[#E8670A]' : 'bg-gray-200'
                  }`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    notifForm.notif_dm_enabled ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </button>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-gray-700">New group post alerts</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={notifForm.notif_community_enabled}
                  disabled={!notifForm.notif_master_enabled}
                  onClick={() => setNotifForm(f => ({ ...f, notif_community_enabled: !f.notif_community_enabled }))}
                  className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#E8670A]/40 ${
                    notifForm.notif_community_enabled ? 'bg-[#E8670A]' : 'bg-gray-200'
                  }`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    notifForm.notif_community_enabled ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </button>
              </div>
            </div>

            {notifError && <p className="text-xs text-red-500">{notifError}</p>}
            <button
              type="button"
              onClick={saveNotifPrefs}
              disabled={notifSaving}
              className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors disabled:opacity-60"
            >
              {notifSaved ? 'Saved!' : notifSaving ? 'Saving…' : 'Save Preferences'}
            </button>
          </div>

          {/* Connected Apps */}
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Connected Apps</h2>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {[
              { name: 'Apple Health',  icon: '🍎' },
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

      {/* Notifications — shown to all users */}
      {isStaff && (
        <>
          <h2 className="text-sm font-semibold text-gray-700 mb-3 mt-10">Notifications</h2>
          <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800">Push notifications</p>
                <p className="text-xs text-gray-500 mt-0.5">Receive push notifications on this device</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={notifForm.notif_master_enabled}
                onClick={() => setNotifForm(f => ({ ...f, notif_master_enabled: !f.notif_master_enabled }))}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#E8670A]/40 ${
                  notifForm.notif_master_enabled ? 'bg-[#E8670A]' : 'bg-gray-200'
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  notifForm.notif_master_enabled ? 'translate-x-5' : 'translate-x-0'
                }`} />
              </button>
            </div>
            <div className={`space-y-3 transition-opacity ${notifForm.notif_master_enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-gray-700">New message alerts</p>
                <button
                  type="button"
                  role="switch"
                  aria-checked={notifForm.notif_dm_enabled}
                  disabled={!notifForm.notif_master_enabled}
                  onClick={() => setNotifForm(f => ({ ...f, notif_dm_enabled: !f.notif_dm_enabled }))}
                  className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#E8670A]/40 ${
                    notifForm.notif_dm_enabled ? 'bg-[#E8670A]' : 'bg-gray-200'
                  }`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    notifForm.notif_dm_enabled ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </button>
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-gray-700">New group post alerts</p>
                <button
                  type="button"
                  role="switch"
                  aria-checked={notifForm.notif_community_enabled}
                  disabled={!notifForm.notif_master_enabled}
                  onClick={() => setNotifForm(f => ({ ...f, notif_community_enabled: !f.notif_community_enabled }))}
                  className={`relative shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#E8670A]/40 ${
                    notifForm.notif_community_enabled ? 'bg-[#E8670A]' : 'bg-gray-200'
                  }`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    notifForm.notif_community_enabled ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </button>
              </div>
            </div>
            {notifError && <p className="text-xs text-red-500">{notifError}</p>}
            <button
              type="button"
              onClick={saveNotifPrefs}
              disabled={notifSaving}
              className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors disabled:opacity-60"
            >
              {notifSaved ? 'Saved!' : notifSaving ? 'Saving…' : 'Save Preferences'}
            </button>
          </div>
        </>
      )}

      {/* Legal */}
      {profile && (
        <>
          <h2 className="text-sm font-semibold text-gray-700 mb-3 mt-10">Legal</h2>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            <Link
              to="/terms"
              className="flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition-colors min-h-[56px]"
            >
              <span className="text-sm text-gray-700">Terms of Service</span>
              <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </Link>
            <Link
              to="/privacy"
              className="flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition-colors min-h-[56px]"
            >
              <span className="text-sm text-gray-700">Privacy Policy</span>
              <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </>
      )}

      </>
      )}
    </div>
  )
}
