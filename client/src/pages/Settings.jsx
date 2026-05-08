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

export default function Settings() {
  const { getToken }   = useAuth()
  const { user }       = useUser()
  const [profile, setProfile] = useState(null)
  const [form, setForm]       = useState({
    first_name: '', age: '', feet: '', inches: '', activity_level: '',
    gender: '', phone_number: '',
  })
  const [saving, setSaving]   = useState(false)
  const [saved,  setSaved]    = useState(false)
  const [error,  setError]    = useState(null)

  // Progress photos: each angle holds an array sorted newest-first
  const [photos, setPhotos] = useState({ front: [], back: [], side: [] })

  useEffect(() => {
    async function load() {
      const token = await getToken()
      const [profileRes, photosRes] = await Promise.all([
        fetch(`${API_URL}/api/users/me`,         { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/progress-photos`,  { headers: { Authorization: `Bearer ${token}` } }),
      ])
      if (profileRes.ok) {
        const data = await profileRes.json()
        setProfile(data)
        setForm({
          first_name:     data.first_name     ?? '',
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
    }
    load()
  }, [getToken])

  function set(e) {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: value }))
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

  function handlePhotoUploaded(photo) {
    setPhotos(prev => ({
      ...prev,
      [photo.angle]: [photo, ...(prev[photo.angle] ?? [])],
    }))
  }

  const anglesWithComparison = ANGLES.filter(a => photos[a].length >= 2)

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Settings</h1>
      <p className="text-sm text-gray-500 mb-8">Account and preferences</p>

      {/* Profile */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Profile</h2>
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
        {profile === null ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <form onSubmit={save} className="space-y-4">
            {/* Email — read only from Clerk */}
            <Field label="Email">
              <input
                type="email"
                value={user?.primaryEmailAddress?.emailAddress ?? ''}
                readOnly
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
              />
            </Field>

            <Field label="First name">
              <input
                type="text"
                name="first_name"
                value={form.first_name}
                onChange={set}
                placeholder="Your first name"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </Field>

            <Field label="Phone number">
              <input
                type="tel"
                name="phone_number"
                value={form.phone_number}
                onChange={set}
                placeholder="(555) 000-0000"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </Field>

            <Field label="Gender">
              <div className="flex gap-2">
                {['male', 'female'].map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, gender: g }))}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors capitalize ${
                      form.gender === g
                        ? 'bg-[#E8670A] text-white border-[#E8670A]'
                        : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {g === 'male' ? 'Male' : 'Female'}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Age">
              <input
                type="number"
                name="age"
                value={form.age}
                onChange={set}
                min="1" max="120"
                placeholder="Your age"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </Field>

            <Field label="Height">
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type="number"
                    name="feet"
                    value={form.feet}
                    onChange={set}
                    min="3" max="8"
                    placeholder="5"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] pr-8"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">ft</span>
                </div>
                <div className="flex-1 relative">
                  <input
                    type="number"
                    name="inches"
                    value={form.inches}
                    onChange={set}
                    min="0" max="11"
                    placeholder="10"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] pr-10"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">in</span>
                </div>
              </div>
            </Field>

            <Field label="Activity level">
              <select
                name="activity_level"
                value={form.activity_level}
                onChange={set}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
              >
                <option value="">Select activity level</option>
                {ACTIVITY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <button
              type="submit"
              disabled={saving}
              className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60 ${
                saved ? 'bg-[#E8670A] text-white' : 'bg-[#E8670A] text-white hover:bg-[#c45e09]'
              }`}
            >
              {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Profile'}
            </button>
          </form>
        )}
      </div>

      {/* Progress Photos */}
      <h2 className="text-sm font-semibold text-gray-700 mb-1">Progress Photos</h2>
      <p className="text-xs text-gray-400 mb-3">Front, back, and side. Add photos over time to track your transformation.</p>
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="grid grid-cols-3 gap-4">
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

      {/* Before vs. Now comparison */}
      {anglesWithComparison.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
          <p className="text-xs font-semibold text-gray-700 mb-4">Before vs. Now</p>
          <div className="space-y-6">
            {anglesWithComparison.map(angle => {
              const list   = photos[angle]
              const newest = list[0]
              const oldest = list[list.length - 1]
              return (
                <div key={angle}>
                  <p className="text-xs font-medium text-gray-500 capitalize mb-2">{angle}</p>
                  <div className="grid grid-cols-2 gap-3">
                    {[{ label: 'Before', photo: oldest }, { label: 'Now', photo: newest }].map(({ label, photo }) => (
                      <div key={label} className="text-center">
                        <img
                          src={photo.photo_url}
                          alt={`${angle} ${label}`}
                          className="w-full aspect-[3/4] object-cover rounded-xl"
                        />
                        <p className="text-xs font-medium text-gray-600 mt-1">{label}</p>
                        <p className="text-xs text-gray-400">{new Date(photo.taken_at).toLocaleDateString()}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Connected Apps */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Connected Apps</h2>
      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        {[
          { name: 'Apple Health', icon: '🍎' },
          { name: 'Google Fit',   icon: '🏃' },
        ].map(app => (
          <div key={app.name} className="flex items-center justify-between px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="text-xl">{app.icon}</span>
              <p className="text-sm font-medium text-gray-900">{app.name}</p>
            </div>
            <span className="text-xs text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full">Coming soon</span>
          </div>
        ))}
      </div>
    </div>
  )
}
