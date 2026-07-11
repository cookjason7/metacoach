import { useState, useEffect, useCallback, Fragment, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { API_URL } from '../../config.js'
import BloodworkIntakeForm from '../../components/BloodworkIntakeForm.jsx'
import LinkifiedText from '../../components/LinkifiedText.jsx'
import ExerciseThumb from '../../components/ExerciseThumb.jsx'

// Display-only: "Day 1" -> "Day 1 Workout". Sequential day labels are the stored
// identifier (used to match exercises/schedules); this never touches that value.
function formatDayLabel(label) {
  return label && /^Day \d+$/.test(label) ? `${label} Workout` : label
}

// Truncates a note for inline display under a metric value (static text, no interaction).
function truncateNote(note, max = 30) {
  const text = String(note ?? '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const TABS = [
  { id: 'overview',    label: 'Overview',   icon: '◉' },
  { id: 'nutrition',   label: 'Nutrition',  icon: '🥗' },
  { id: 'progress',    label: 'Progress',   icon: '↗' },
  { id: 'assessment',  label: 'Forms',      icon: '★' },
  { id: 'notes',       label: 'Notes',      icon: '✎' },
  { id: 'messaging',   label: 'Messages',   icon: '✉' },
  { id: 'habits',      label: 'Calendar',   icon: '📅' },
  { id: 'engagement',  label: 'Engagement', icon: '⚡' },
  { id: 'bloodwork',   label: 'Bloodwork',  icon: '🩸' },
  { id: 'workouts',    label: 'Workouts',   icon: '💪' },
]
// First 7 always visible; rest tucked behind "More ▾" so the row fits desktop without scrolling.
const PRIMARY_TABS = TABS.slice(0, 7)
const MORE_TABS    = TABS.slice(7)

const MOMENTUM_COLORS = {
  'Locked In':  'bg-emerald-600 text-white',
  'Strong':     'bg-emerald-500 text-white',
  'Stable':     'bg-blue-500 text-white',
  'Building':   'bg-amber-500 text-white',
  'Rebuilding Momentum': 'bg-orange-500 text-white',
}

function daysSince(iso) {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso)) / 86400_000)
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
}

// Formats a DATE-only value (YYYY-MM-DD, no time component) as MM/DD/YYYY without
// going through `new Date()` — that would parse bare dates as UTC midnight and can
// shift the displayed day by one depending on the browser's local timezone.
function fmtDateOnly(iso) {
  if (!iso) return null
  const s = String(iso).slice(0, 10)
  const [y, m, d] = s.split('-')
  if (!y || !m || !d) return s
  return `${m}/${d}/${y}`
}

function fmtDob(iso) {
  return fmtDateOnly(iso)
}

function fmtHeight(inches) {
  if (inches == null || inches === '') return null
  const n = Number(inches)
  if (!Number.isFinite(n) || n <= 0) return null
  const ft = Math.floor(n / 12)
  const ins = Math.round(n % 12)
  return `${ft}'${ins}"`
}

function fmtActivityLevel(value) {
  if (!value) return null
  const map = {
    sedentary:         'Sedentary',
    lightly_active:    'Lightly Active',
    moderately_active: 'Moderately Active',
    very_active:       'Very Active',
    extra_active:      'Extra Active',
  }
  return map[String(value).trim().toLowerCase()] ?? value
}

function coachingTypeLabel(type) {
  if (type === 'vip') return 'VIP'
  if (type === 'hybrid') return 'Hybrid'
  if (type === 'basic') return 'Basic'
  if (type === 'ai') return 'Legacy AI'
  return 'Hybrid'
}

// Client status tag — mirrors computeStatusTag in coachAdmin.js (no API call needed)
function computeClientStatusTag(client) {
  if (client.client_status === 'invited') return 'Invited'
  if (!client.onboarding_complete || !client.assessment_complete) return 'New Client'
  const adh7  = Number(client.adherence_7d  || 0)
  const adh30 = Number(client.adherence_30d || 0)
  if (adh7 >= 80) return 'Consistent'
  if (adh7 >= 50) return 'Building Momentum'
  if (adh30 >= 50 && adh7 < 30) return 'Needs Attention'
  if (adh7 > adh30) return 'Rebuilding Momentum'
  return 'Building Momentum'
}

// Chip styles per status tag
function statusTagStyle(tag) {
  if (tag === 'Consistent')                               return 'bg-emerald-50 border-emerald-200 text-emerald-700'
  if (tag === 'Building Momentum' || tag === 'Rebuilding Momentum') return 'bg-orange-50 border-orange-200 text-[#E8670A]'
  if (tag === 'Needs Attention')                         return 'bg-amber-50 border-amber-200 text-amber-700'
  return 'bg-gray-50 border-gray-200 text-gray-600'
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ client, role, getToken, onUpdate }) {
  const [coaches, setCoaches] = useState([])
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const startDateInitial =
    client.start_date ? String(client.start_date).slice(0, 10) :
    client.effective_start_date ? String(client.effective_start_date).slice(0, 10) : ''
  const [form, setForm] = useState({
    first_name:           client.display_first_name ?? client.first_name ?? '',
    last_name:            client.display_last_name  ?? client.last_name  ?? '',
    coaching_type:        client.coaching_type ?? 'vip',
    assigned_coach_id:    client.assigned_coach_id ?? '',
    role:                 client.role ?? 'client',
    start_date:           startDateInitial,
    program_end_date:     client.program_end_date ? String(client.program_end_date).slice(0, 10) : '',
    phone_number:         client.phone_number ?? '',
    starting_weight_lbs:  client.starting_weight_lbs != null ? String(client.starting_weight_lbs) : '',
  })

  useEffect(() => {
    if (role !== 'admin') return
    async function load() {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/coaches`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setCoaches(await res.json())
    }
    load()
  }, [role, getToken])

  async function save() {
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${client.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name:           form.first_name.trim()  || null,
          last_name:            form.last_name.trim()   || null,
          coaching_type:        form.coaching_type,
          assigned_coach_id:    form.coaching_type === 'vip' && form.assigned_coach_id !== '' ? Number(form.assigned_coach_id) : null,
          role:                 form.role,
          start_date:           form.start_date || null,
          program_end_date:     form.program_end_date || null,
          phone_number:         form.phone_number || null,
          starting_weight_lbs:  form.starting_weight_lbs !== '' ? Number(form.starting_weight_lbs) : null,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Server ${res.status}`)
      }
      const updated = await res.json()
      onUpdate({
        ...updated,
        display_first_name: updated.first_name ?? null,
        display_last_name:  updated.last_name  ?? null,
      })
      setEditing(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const adh7  = Math.round(Number(client.adherence_7d)  || 0)
  const adh30 = Math.round(Number(client.adherence_30d) || 0)

  const displayStartDate =
    client.start_date ? fmtDateOnly(client.start_date) :
    client.effective_start_date ? `${fmtDateOnly(client.effective_start_date)} (auto)` :
    '—'

  return (
    <div className="space-y-4">
      {/* Momentum hero */}
      <div className="bg-gradient-to-br from-[#1e2a3a] to-[#243347] rounded-xl p-5 text-white">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs text-white/60 mb-1">Current Momentum</p>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-bold ${
                MOMENTUM_COLORS[client.momentum] ?? 'bg-gray-500 text-white'
              }`}>
                {client.momentum}
              </span>
            </div>
          </div>
          <div className="flex gap-6">
            <div>
              <p className="text-xs text-white/60">7-day adherence</p>
              <p className="text-2xl font-bold text-[#E8670A]">{adh7}%</p>
            </div>
            <div>
              <p className="text-xs text-white/60">30-day</p>
              <p className="text-2xl font-bold text-white/90">{adh30}%</p>
            </div>
            <div>
              <p className="text-xs text-white/60">Comebacks</p>
              <p className="text-2xl font-bold text-white/90">{client.comeback_count ?? 0}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Info card */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-sm font-semibold text-gray-900">Client Info</h3>
          {role === 'admin' && !editing && (
            <button onClick={() => setEditing(true)} className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">Edit</button>
          )}
        </div>

        {!editing ? (
          (() => {
            // Fallback chain: users table → health_assessments → null
            const fullName = [
              client.display_first_name || client.first_name,
              client.display_last_name  || client.last_name,
            ].filter(Boolean).join(' ') || null
            const phone = client.display_phone || client.phone_number || null
            const addr  = client.display_address
            const addressLine = (addr?.street || addr?.city)
              ? [
                  addr.street,
                  [addr.city, addr.state].filter(Boolean).join(', '),
                  addr.zip,
                  addr.country && addr.country !== 'United States' ? addr.country : null,
                ].filter(Boolean).join(' · ')
              : null
            const dob = client.display_dob ? fmtDob(String(client.display_dob)) : null
            return (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <InfoRow label="Full name"       value={fullName} />
                <InfoRow label="Email"           value={client.email} />
                <InfoRow label="Phone"           value={phone} />
                {client.assessment_has_data ? (
                  <>
                    <InfoRow label="Address"       value={addressLine} />
                    <InfoRow label="Date of birth" value={dob} />
                    <InfoRow label="Shirt size"    value={client.display_shirt_size} />
                  </>
                ) : (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-gray-400">Assessment data</p>
                    <p className="text-sm font-medium text-amber-600">No Health Assessment on File</p>
                  </div>
                )}
                <InfoRow label="Coaching type"   value={coachingTypeLabel(client.coaching_type)} />
                <InfoRow label="Assigned coach"      value={client.assigned_coach_name} emptyText={client.coaching_type === 'vip' ? 'Not assigned yet' : 'N/A'} />
                <InfoRow label="Starting weight"     value={client.starting_weight_lbs != null ? `${client.starting_weight_lbs} lbs` : null} />
                <InfoRow label="Goal weight"         value={client.goal_weight_lbs != null ? `${client.goal_weight_lbs} lbs` : null} />
                <InfoRow label="Height"              value={fmtHeight(client.height_inches)} />
                <InfoRow label="Gender"              value={client.gender ? client.gender.charAt(0).toUpperCase() + client.gender.slice(1) : null} />
                <InfoRow label="Activity level"      value={fmtActivityLevel(client.activity_level ?? client.assessment_activity_level)} />
                <InfoRow label="Food allergies"      value={client.food_allergies || null} />
                <InfoRow label="Foods disliked"      value={client.food_dislikes || null} />
                <InfoRow label="Program start date" value={displayStartDate} />
                <InfoRow label="Program end date"   value={client.program_end_date ? fmtDateOnly(client.program_end_date) : null} emptyText="Not set" />
                <InfoRow label="Last login"      value={fmtDate(client.last_login_at)} />
                <InfoRow label="Last meal log"   value={client.last_meal_at ? `${daysSince(client.last_meal_at)}d ago` : null} emptyText="Not logged yet" />
                <InfoRow label="Onboarding"      value={client.onboarding_complete ? '✓ Complete' : '○ In progress'} />
                <InfoRow label="Assessment"      value={
                  client.assessment_has_data
                    ? '✓ Complete'
                    : client.assessment_complete
                      ? '! Needs Assessment'
                      : '○ In progress'
                } />
                <InfoRow label="Client status"   value={(() => { const s = client.client_status ?? 'active'; return s.charAt(0).toUpperCase() + s.slice(1) })()} />
                <InfoRow label="Role"            value={client.role} />
              </div>
            )
          })()
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">First name</label>
                <input type="text" value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                  placeholder="First name"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Last name</label>
                <input type="text" value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                  placeholder="Last name"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Coaching type</label>
                <select
                  value={form.coaching_type === 'ai' ? 'legacy_ai' : form.coaching_type}
                  onChange={e => setForm(f => ({
                    ...f,
                    coaching_type: e.target.value,
                    assigned_coach_id: e.target.value === 'vip' ? f.assigned_coach_id : '',
                  }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                  <option value="basic">Basic</option>
                  <option value="hybrid">Hybrid</option>
                  <option value="vip">VIP</option>
                  {form.coaching_type === 'ai' && (
                    <option value="legacy_ai" disabled>Legacy AI</option>
                  )}
                </select>
                {form.coaching_type === 'ai' && (
                  <p className="text-[10px] text-gray-400 mt-1">
                    Existing legacy AI client. Choose Basic, Hybrid, or VIP to update.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                  <option value="client">Client</option>
                  <option value="coach">Coach</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <div>
              <label className={`block text-xs font-medium mb-1 ${form.coaching_type !== 'vip' ? 'text-gray-400' : 'text-gray-600'}`}>
                Assigned coach
                {form.coaching_type !== 'vip' && <span className="ml-1 font-normal italic">(VIP only)</span>}
              </label>
              <select
                value={form.assigned_coach_id}
                onChange={e => setForm(f => ({ ...f, assigned_coach_id: e.target.value }))}
                disabled={form.coaching_type !== 'vip'}
                className={`w-full border rounded-lg px-3 py-2 text-sm ${
                  form.coaching_type !== 'vip'
                    ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed opacity-60'
                    : 'border-gray-300 bg-white'
                }`}>
                <option value="">Unassigned</option>
                {coaches.map(c => (
                  <option key={c.id} value={c.id}>{c.first_name ?? c.email} {c.email && c.first_name ? `· ${c.email}` : ''}</option>
                ))}
              </select>
              <p className="text-[10px] text-gray-400 mt-1">
                {form.coaching_type !== 'vip'
                  ? 'Basic and Hybrid clients do not require a human coach assignment.'
                  : 'Only this coach (or admins) will see this client.'}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Phone number</label>
                <input type="tel" value={form.phone_number} onChange={e => setForm(f => ({ ...f, phone_number: e.target.value }))}
                  placeholder="(555) 000-0000"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Program start date</label>
                <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Program end date</label>
                <input type="date" value={form.program_end_date} onChange={e => setForm(f => ({ ...f, program_end_date: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Starting weight (lbs)</label>
                <input type="number" min="50" max="600" step="0.1"
                  value={form.starting_weight_lbs}
                  onChange={e => setForm(f => ({ ...f, starting_weight_lbs: e.target.value }))}
                  placeholder="e.g. 185"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-60"
              >
                {saving ? 'Saving...' : 'Save changes'}
              </button>
              <button
                onClick={() => { setEditing(false); setSaveError(null) }}
                disabled={saving}
                className="text-xs text-gray-500 px-3 py-2 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
            {saveError && <p className="text-xs text-red-500">{saveError}</p>}
          </div>
        )}
        {saved && !editing && <p className="text-xs font-medium text-emerald-600 mt-3">Saved.</p>}
      </div>

    </div>
  )
}

function InfoRow({ label, value, emptyText = 'Not provided yet' }) {
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-sm font-medium text-gray-800 truncate">{value ?? emptyText}</p>
    </div>
  )
}

// ─── Nutrition Targets Card ───────────────────────────────────────────────────

const MACRO_TARGET_FIELDS = [
  { key: 'goal_calories', label: 'Calories', unit: 'kcal' },
  { key: 'goal_protein',  label: 'Protein',  unit: 'g' },
  { key: 'goal_carbs',    label: 'Carbs',    unit: 'g' },
  { key: 'goal_fat',      label: 'Fat',      unit: 'g' },
]

function NutritionTargetsCard({ client, getToken, onUpdate }) {
  const [editing,    setEditing]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState(null)
  const [goalType,   setGoalType]   = useState('calories_protein') // 'calories_only' | 'calories_protein' | 'full_macros'
  const [form, setForm] = useState({
    goal_calories: client.goal_calories ?? '',
    goal_protein:  client.goal_protein  ?? '',
    goal_carbs:    client.goal_carbs    ?? '',
    goal_fat:      client.goal_fat      ?? '',
  })

  // ── Derived values ───────────────────────────────────────────────────────────
  const prot  = Math.max(0, Number(form.goal_protein)  || 0)
  const carbs = Math.max(0, Number(form.goal_carbs)    || 0)
  const fat   = Math.max(0, Number(form.goal_fat)      || 0)

  // Full Macros — calories computed from entered grams
  const computedCalories = Math.round(prot * 4 + carbs * 4 + fat * 9)

  const canSave = !saving

  async function save() {
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const toInt = v => v !== '' ? Math.max(0, Math.round(Number(v))) : null
      const body = {
        goal_calories: toInt(form.goal_calories),
        goal_protein:  null,
        goal_carbs:    null,
        goal_fat:      null,
      }
      if (goalType === 'calories_protein') {
        body.goal_protein = toInt(form.goal_protein)
      } else if (goalType === 'full_macros') {
        body.goal_protein = toInt(form.goal_protein)
        body.goal_carbs   = toInt(form.goal_carbs)
        body.goal_fat     = toInt(form.goal_fat)
        body.goal_calories = computedCalories || toInt(form.goal_calories)
      }
      const res = await fetch(`${API_URL}/api/admin/users/${client.id}/macros`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Save failed')
      onUpdate(await res.json())
      setEditing(false)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  const inputCls      = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30'
  const computedCls   = 'w-full border border-gray-200 bg-orange-50 rounded-lg px-3 py-2 text-sm font-semibold text-[#c45e09]'
  const computedErrCls = 'w-full border border-red-200 bg-red-50 rounded-lg px-3 py-2 text-sm font-semibold text-red-600'

  const GOAL_TYPES = [
    { id: 'calories_only',    label: 'Calories Only',       desc: 'Track calories only.' },
    { id: 'calories_protein', label: 'Calories + Protein',  desc: 'Most common. Add a protein target.' },
    { id: 'full_macros',      label: 'Full Macros',         desc: 'Enter protein, carbs & fat — calories auto-calculated.' },
  ]


  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-semibold text-gray-900">Nutrition Targets</h3>
        {!editing && (
          <button onClick={() => setEditing(true)} className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">Edit</button>
        )}
      </div>

      {!editing ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {MACRO_TARGET_FIELDS.map(({ key, label, unit }) => (
            <div key={key}>
              <p className="text-xs text-gray-400">{label}</p>
              <p className="text-sm font-medium text-gray-800">
                {client[key] != null ? `${client[key]} ${unit}` : '—'}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">

          {/* ── Goal type selector ── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {GOAL_TYPES.map(({ id, label, desc }) => (
              <button key={id} onClick={() => setGoalType(id)}
                className={`text-left rounded-xl border px-3 py-2.5 transition-all ${
                  goalType === id
                    ? 'border-[#E8670A] bg-orange-50 ring-1 ring-[#E8670A]'
                    : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}>
                <p className={`text-xs font-semibold mb-0.5 ${goalType === id ? 'text-[#c45e09]' : 'text-gray-800'}`}>{label}</p>
                <p className="text-[11px] text-gray-400 leading-snug">{desc}</p>
              </button>
            ))}
          </div>

          {/* ── Calories Only ── */}
          {goalType === 'calories_only' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Calories <span className="text-gray-400">(kcal)</span></label>
              <input type="number" min="0" value={form.goal_calories}
                onChange={e => setForm(f => ({ ...f, goal_calories: e.target.value }))}
                placeholder="—" className={inputCls} />
            </div>
          )}

          {/* ── Calories + Protein ── */}
          {goalType === 'calories_protein' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Calories <span className="text-gray-400">(kcal)</span></label>
                <input type="number" min="0" value={form.goal_calories}
                  onChange={e => setForm(f => ({ ...f, goal_calories: e.target.value }))}
                  placeholder="—" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Protein <span className="text-gray-400">(g)</span></label>
                <input type="number" min="0" value={form.goal_protein}
                  onChange={e => setForm(f => ({ ...f, goal_protein: e.target.value }))}
                  placeholder="—" className={inputCls} />
              </div>
            </div>
          )}

          {/* ── Full Macros ── */}
          {goalType === 'full_macros' && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                {[
                  { key: 'goal_protein', label: 'Protein' },
                  { key: 'goal_carbs',   label: 'Carbs'   },
                  { key: 'goal_fat',     label: 'Fat'     },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{label} <span className="text-gray-400">(g)</span></label>
                    <input type="number" min="0" value={form[key]}
                      onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                      placeholder="—" className={inputCls} />
                  </div>
                ))}
              </div>
              <div className="bg-orange-50 border border-orange-100 rounded-lg px-3 py-2.5 flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500">Calculated calories</span>
                <span className="text-sm font-bold text-[#c45e09]">{computedCalories > 0 ? `${computedCalories} kcal` : '—'}</span>
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={save} disabled={!canSave}
              className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-50">
              {saving ? 'Saving…' : 'Save targets'}
            </button>
            <button onClick={() => { setEditing(false); setError(null) }} className="text-xs text-gray-500 px-3 py-2">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Food Log Section (coach view) ───────────────────────────────────────────

const SLOT_DISPLAY_ORDER = ['Breakfast', 'Lunch', 'Dinner', 'Snack']
const SNACK_SLOTS = new Set(['Snack', 'AM Snack', 'PM Snack', 'Late Snack'])

function FoodLogSection({ clientId, date, getToken }) {
  const [meals,   setMeals]   = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/coach-admin/clients/${clientId}/meals?date=${date}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!cancelled && res.ok) setMeals(await res.json())
        else if (!cancelled) setMeals([])
      } catch { if (!cancelled) setMeals([]) }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [clientId, date, getToken])

  const grouped = {}
  for (const m of meals) {
    const slot = SNACK_SLOTS.has(m.meal_slot) ? 'Snack' : (m.meal_slot ?? 'Other')
    if (!grouped[slot]) grouped[slot] = []
    grouped[slot].push(m)
  }
  const slotsPresent = [
    ...SLOT_DISPLAY_ORDER.filter(s => grouped[s]?.length),
    ...Object.keys(grouped).filter(s => !SLOT_DISPLAY_ORDER.includes(s) && grouped[s]?.length),
  ]

  const fmt = (n, unit = '') => n != null && Number(n) > 0 ? `${n}${unit}` : null

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Food Log</h3>
      {loading ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : slotsPresent.length === 0 ? (
        <p className="text-xs text-gray-400 py-2">No meals logged for this day.</p>
      ) : (
        <div className="space-y-4">
          {slotsPresent.map(slot => (
            <div key={slot}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">{slot}</p>
              <div className="space-y-1">
                {grouped[slot].map(m => {
                  const serving = m.serving_size != null
                    ? `${m.serving_size}${m.serving_unit || 'g'}`
                    : null
                  const macros = [
                    fmt(m.calories, ' kcal'),
                    fmt(m.protein,  'g pro'),
                    fmt(m.carbs,    'g carbs'),
                    fmt(m.fat,      'g fat'),
                    m.fiber != null && Number(m.fiber) > 0 ? `${m.fiber}g fiber` : null,
                  ].filter(Boolean)

                  return (
                    <div key={m.id} className="flex items-start justify-between gap-2 py-1.5 border-b border-gray-50 last:border-0">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 leading-snug truncate">{m.meal_name}</p>
                        {serving && <p className="text-[11px] text-gray-400">{serving}</p>}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs text-gray-500 leading-relaxed">{macros.join(' · ')}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Food Log Modal ───────────────────────────────────────────────────────────

function FoodLogModal({ clientId, clientName, date, getToken, goals = {}, onClose, onDateChange }) {
  const today = localDateStr()
  const [nutrition, setNutrition] = useState(null)
  const [meals,     setMeals]     = useState([])
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setNutrition(null); setMeals([])
      try {
        const token = await getToken()
        const [nRes, mRes] = await Promise.all([
          fetch(`${API_URL}/api/coach-admin/clients/${clientId}/nutrition?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_URL}/api/coach-admin/clients/${clientId}/meals?date=${date}`,    { headers: { Authorization: `Bearer ${token}` } }),
        ])
        if (!cancelled) {
          if (nRes.ok) setNutrition(await nRes.json())
          if (mRes.ok) setMeals(await mRes.json()); else setMeals([])
        }
      } catch { if (!cancelled) setMeals([]) }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [clientId, date, getToken])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function shiftDay(n) {
    const d = new Date(date + 'T12:00:00Z')
    d.setDate(d.getDate() + n)
    return d.toISOString().slice(0, 10)
  }

  const grouped = {}
  for (const m of meals) {
    const slot = SNACK_SLOTS.has(m.meal_slot) ? 'Snack' : (m.meal_slot ?? 'Other')
    if (!grouped[slot]) grouped[slot] = []
    grouped[slot].push(m)
  }
  const slotsPresent = [
    ...SLOT_DISPLAY_ORDER.filter(s => grouped[s]?.length),
    ...Object.keys(grouped).filter(s => !SLOT_DISPLAY_ORDER.includes(s) && grouped[s]?.length),
  ]

  const n = nutrition ?? {}
  const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-1 min-w-0">
            <button
              onClick={() => onDateChange(shiftDay(-1))}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 font-bold text-lg leading-none shrink-0">
              ‹
            </button>
            <div className="min-w-0 px-1">
              {clientName && <p className="text-[11px] text-gray-400 truncate">{clientName}</p>}
              <p className="text-sm font-semibold text-gray-900 truncate">{dateLabel}</p>
            </div>
            <button
              onClick={() => onDateChange(shiftDay(1))}
              disabled={date >= today}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 font-bold text-lg leading-none disabled:opacity-25 shrink-0">
              ›
            </button>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1.5 leading-none shrink-0 text-lg">✕</button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1 p-4 space-y-4">
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-10">Loading…</p>
          ) : (
            <>
              {/* Macro summary grid */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Calories', actual: n.total_calories, goal: goals.goal_calories, unit: ' kcal' },
                  { label: 'Protein',  actual: n.total_protein,  goal: goals.goal_protein,  unit: 'g' },
                  { label: 'Carbs',    actual: n.total_carbs,    goal: goals.goal_carbs,    unit: 'g' },
                  { label: 'Fat',      actual: n.total_fat,      goal: goals.goal_fat,      unit: 'g' },
                ].map(({ label, actual, goal, unit }) => {
                  const a = actual != null ? Math.round(Number(actual)) : null
                  const g = goal   != null ? Math.round(Number(goal))   : null
                  const atGoal = a != null && g ? Math.abs(a - g) / g <= 0.12 : null
                  return (
                    <div key={label} className="bg-gray-50 rounded-xl p-3">
                      <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mb-0.5">{label}</p>
                      <p className="text-base font-bold text-gray-900">{a != null ? `${a.toLocaleString()}${unit}` : '—'}</p>
                      {g ? (
                        <p className={`text-[10px] mt-0.5 font-medium ${atGoal === true ? 'text-emerald-500' : atGoal === false ? 'text-amber-500' : 'text-gray-400'}`}>
                          Goal: {g.toLocaleString()}{unit}
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </div>

              {/* Fiber + Sodium inline */}
              {(Number(n.total_fiber) > 0 || Number(n.total_sodium_mg) > 0) && (
                <div className="flex gap-4 text-xs text-gray-500 px-1">
                  {Number(n.total_fiber)     > 0 && <span>Fiber <strong className="text-gray-700">{n.total_fiber}g</strong></span>}
                  {Number(n.total_sodium_mg) > 0 && <span>Sodium <strong className="text-gray-700">{Number(n.total_sodium_mg).toLocaleString()}mg</strong></span>}
                </div>
              )}

              {/* Food log by slot */}
              {slotsPresent.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-6">No meals logged for this day.</p>
              ) : (
                <div className="space-y-4">
                  {slotsPresent.map(slot => {
                    const slotMeals = grouped[slot]
                    const slotCal = slotMeals.reduce((s, m) => s + (Number(m.calories) || 0), 0)
                    return (
                      <div key={slot}>
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{slot}</p>
                          {slotCal > 0 && <p className="text-[10px] text-gray-400">{Math.round(slotCal)} kcal</p>}
                        </div>
                        <div className="space-y-0.5">
                          {slotMeals.map(m => {
                            const serving = m.serving_size != null
                              ? `${m.serving_size}${m.serving_unit || 'g'}`
                              : null
                            const macros = [
                              m.calories ? `${m.calories} cal`  : null,
                              m.protein  ? `${m.protein}g P`    : null,
                              m.carbs    ? `${m.carbs}g C`      : null,
                              m.fat      ? `${m.fat}g F`        : null,
                            ].filter(Boolean)
                            return (
                              <div key={m.id} className="flex items-start justify-between gap-3 py-1.5 border-b border-gray-50 last:border-0">
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-gray-900 leading-snug">{m.meal_name}</p>
                                  {serving && <p className="text-[11px] text-gray-400">{serving}</p>}
                                </div>
                                {macros.length > 0 && (
                                  <p className="shrink-0 text-[11px] text-gray-500 text-right leading-relaxed">{macros.join(' · ')}</p>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Nutrition Tab ────────────────────────────────────────────────────────────

function NutritionStat({ label, value, unit = '' }) {
  const hasValue = value != null
  return (
    <div className="bg-gray-50 rounded-xl p-3">
      <p className="text-[11px] text-gray-400 mb-0.5">{label}</p>
      <p className={`text-sm font-bold ${hasValue ? 'text-gray-900' : 'text-gray-400'}`}>
        {hasValue ? `${value}${unit}` : 'Not logged yet'}
      </p>
    </div>
  )
}

function DaySummaryRow({ label, actual, target, unit }) {
  const hasTarget = target != null && Number(target) > 0
  const hasActual = actual != null
  const roundedActual = hasActual ? Math.round(actual) : null
  const roundedTarget = hasTarget ? Math.round(target) : null
  const displayUnit   = unit.trim()

  let badge = null
  if (hasTarget && hasActual) {
    const diff = roundedActual - roundedTarget
    const tol  = Math.max(2, Math.round(roundedTarget * 0.05))
    if (Math.abs(diff) <= tol) {
      badge = { text: 'On track', cls: 'text-emerald-600' }
    } else if (diff < 0) {
      badge = { text: `${Math.abs(diff)}${displayUnit} under`, cls: 'text-amber-500' }
    } else {
      badge = { text: `${diff}${displayUnit} over`, cls: 'text-red-500' }
    }
  }

  return (
    <div className="flex items-center py-2.5 border-b border-gray-50 last:border-0 gap-2">
      <span className="text-xs font-medium text-gray-500 w-16 shrink-0">{label}</span>
      <span className={`text-sm font-semibold w-24 text-right ${roundedActual != null ? 'text-gray-900' : 'text-gray-400'}`}>
        {roundedActual != null ? `${roundedActual}${unit}` : 'Not logged'}
      </span>
      <span className="text-xs text-gray-400 w-16">
        {hasTarget ? `/ ${roundedTarget}${unit}` : 'No target'}
      </span>
      <span className={`text-[11px] font-semibold ml-auto ${badge ? badge.cls : 'text-gray-300'}`}>
        {badge ? badge.text : ''}
      </span>
    </div>
  )
}

// ─── Mifflin-St Jeor BMR / TDEE Calculator ────────────────────────────────────

function calculateAgeFromDob(dob) {
  if (!dob) return null
  const birth = new Date(dob)
  if (Number.isNaN(birth.getTime())) return null
  const today = new Date()
  let years = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) years -= 1
  return years > 0 ? years : null
}

function normalizeCalculatorSex(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (['male', 'man', 'm'].includes(v)) return 'male'
  if (['female', 'woman', 'f'].includes(v)) return 'female'
  return ''
}

function normalizeHeightInches(value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') return value > 0 ? String(Math.round(value * 10) / 10) : ''

  const raw = String(value).trim().toLowerCase()
  if (!raw) return ''
  const direct = Number(raw)
  if (Number.isFinite(direct) && direct > 0) return String(Math.round(direct * 10) / 10)

  const ftIn = raw.match(/(\d+(?:\.\d+)?)\s*(?:ft|feet|'|’)\s*(\d+(?:\.\d+)?)?/)
  if (ftIn) {
    const feet = Number(ftIn[1])
    const inches = Number(ftIn[2] ?? 0)
    const total = feet * 12 + inches
    return Number.isFinite(total) && total > 0 ? String(Math.round(total * 10) / 10) : ''
  }

  const inchesOnly = raw.match(/(\d+(?:\.\d+)?)\s*(?:in|inch|inches|")/)
  if (inchesOnly) {
    const inches = Number(inchesOnly[1])
    return Number.isFinite(inches) && inches > 0 ? String(Math.round(inches * 10) / 10) : ''
  }

  return ''
}

function positiveValueString(value) {
  if (value === null || value === undefined || value === '') return ''
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 10) / 10) : ''
}

function normalizeActivityFactor(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return '1.55'
  if (['1.2', '1.375', '1.55', '1.725', '1.9'].includes(v)) return v
  if (v.includes('sedentary') || v.includes('little') || v.includes('none')) return '1.2'
  if (v.includes('light')) return '1.375'
  if (v.includes('moderate') || v.includes('3') || v.includes('5')) return '1.55'
  if (v.includes('very') || v.includes('6') || v.includes('7')) return '1.725'
  if (v.includes('extra') || v.includes('physical') || v.includes('athlete')) return '1.9'
  return '1.55'
}

function BmrTdeeCalculator({ client, getToken, onUpdate }) {
  const defaults = client.nutrition_calculator_defaults ?? {}
  const initialAge = defaults.age ?? client.age ?? calculateAgeFromDob(client.display_dob)
  const initialWeight = defaults.weight_lbs ?? client.latest_weight_lbs ?? client.starting_weight_lbs ?? ''
  const initialHeight = defaults.height_inches ?? client.height_inches ?? ''
  const initialGoalWeight = defaults.goal_weight_lbs ?? client.goal_weight_lbs ?? ''
  const touchedRef = useRef(false)
  const clientIdRef = useRef(client.id)
  const [open,        setOpen]        = useState(false)
  const [sex,         setSex]         = useState(normalizeCalculatorSex(defaults.sex ?? client.gender))
  const [age,         setAge]         = useState(positiveValueString(initialAge))
  const [heightIn,    setHeightIn]    = useState(normalizeHeightInches(initialHeight))
  const [weightLbs,   setWeightLbs]   = useState(positiveValueString(initialWeight))
  const [goalWeight,  setGoalWeight]  = useState(positiveValueString(initialGoalWeight))
  const [activity,    setActivity]    = useState(normalizeActivityFactor(defaults.activity_level ?? client.activity_level ?? client.assessment_activity_level))
  const [adjustment,  setAdjustment]  = useState('0')
  const [applying,    setApplying]    = useState(false)
  const [applyError,  setApplyError]  = useState(null)
  const [applied,     setApplied]     = useState(false)

  useEffect(() => {
    if (clientIdRef.current !== client.id) {
      clientIdRef.current = client.id
      touchedRef.current = false
    }
    if (touchedRef.current) return

    const nextDefaults = client.nutrition_calculator_defaults ?? {}
    const nextAge = nextDefaults.age ?? client.age ?? calculateAgeFromDob(client.display_dob)
    const nextWeight = nextDefaults.weight_lbs ?? client.latest_weight_lbs ?? client.starting_weight_lbs ?? ''
    const nextHeight = nextDefaults.height_inches ?? client.height_inches ?? ''
    const nextGoalWeight = nextDefaults.goal_weight_lbs ?? client.goal_weight_lbs ?? ''

    setSex(normalizeCalculatorSex(nextDefaults.sex ?? client.gender))
    setAge(positiveValueString(nextAge))
    setHeightIn(normalizeHeightInches(nextHeight))
    setWeightLbs(positiveValueString(nextWeight))
    setGoalWeight(positiveValueString(nextGoalWeight))
    setActivity(normalizeActivityFactor(nextDefaults.activity_level ?? client.activity_level ?? client.assessment_activity_level))
  }, [client])

  function markTouched() {
    touchedRef.current = true
  }

  const ageN   = Number(age)
  const htN    = Number(heightIn)
  const wtN    = Number(weightLbs)
  const actN   = Number(activity)
  const adjN   = Number(adjustment)
  const valid  = sex && ageN > 0 && htN > 0 && wtN > 0

  const kg     = wtN / 2.2046
  const cm     = htN * 2.54
  const bmr    = valid ? Math.round(10 * kg + 6.25 * cm - 5 * ageN + (sex === 'male' ? 5 : -161)) : null
  const tdee   = bmr   ? Math.round(bmr * actN) : null
  const goalCal = tdee ? Math.max(800, tdee + adjN) : null
  const sourceLabels = {
    daily_log: 'Latest logged weight',
    weekly_checkin: 'Latest check-in weight',
    confirmed_weight: 'Confirmed weight fallback',
    starting_weight: 'Starting weight fallback',
  }
  const weightSource = sourceLabels[defaults.weight_source] ?? (client.latest_weight_lbs != null
    ? 'Latest logged weight'
    : client.starting_weight_lbs != null
      ? 'Starting weight fallback'
      : null)

  async function applyCalories() {
    if (!goalCal) return
    setApplying(true); setApplyError(null); setApplied(false)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/users/${client.id}/macros`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal_calories: goalCal }),
      })
      if (!res.ok) throw new Error('Failed to apply')
      onUpdate(await res.json())
      setApplied(true)
      setTimeout(() => setApplied(false), 3000)
    } catch (err) { setApplyError(err.message) } finally { setApplying(false) }
  }

  const ACTIVITY_OPTIONS = [
    { value: '1.2',   label: 'Sedentary (little/no exercise)' },
    { value: '1.375', label: 'Lightly active (1–3 days/wk)' },
    { value: '1.55',  label: 'Moderately active (3–5 days/wk)' },
    { value: '1.725', label: 'Very active (6–7 days/wk)' },
    { value: '1.9',   label: 'Extra active (physical job + training)' },
  ]
  const ADJ_OPTIONS = [
    { value: '-1000', label: '−1000 calories / ~2 lb per week'   },
    { value: '-750',  label: '−750 calories / ~1.5 lb per week'  },
    { value: '-500',  label: '−500 calories / ~1 lb per week'    },
    { value: '-250',  label: '−250 calories / ~0.5 lb per week'  },
    { value: '0',     label: 'Maintenance'                       },
    { value: '250',   label: '+250 calories / ~0.5 lb per week'  },
    { value: '500',   label: '+500 calories / ~1 lb per week'    },
  ]

  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 min-h-[44px]'

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">BMR / TDEE Calculator</span>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-4 space-y-4">
          {/* Row 1: inputs */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Sex</label>
              <select value={sex} onChange={e => { markTouched(); setSex(e.target.value) }} className={inputCls}>
                <option value="">Select…</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Age</label>
              <input type="number" min="1" max="120" value={age}
                onChange={e => { markTouched(); setAge(e.target.value) }}
                placeholder="yrs" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Height (in)</label>
              <input type="number" min="1" max="120" value={heightIn}
                onChange={e => { markTouched(); setHeightIn(e.target.value) }}
                placeholder="inches" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Current weight</label>
              <input type="number" min="1" max="1000" value={weightLbs}
                onChange={e => { markTouched(); setWeightLbs(e.target.value) }}
                placeholder="lbs" className={inputCls} />
              {weightSource && <p className="mt-1 text-[10px] text-gray-400">{weightSource}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Goal weight</label>
              <input type="number" min="1" max="1000" value={goalWeight}
                onChange={e => { markTouched(); setGoalWeight(e.target.value) }}
                placeholder="optional" className={inputCls} />
            </div>
          </div>

          {/* Row 2: activity + adjustment */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Activity Level</label>
              <select value={activity} onChange={e => { markTouched(); setActivity(e.target.value) }} className={inputCls}>
                {ACTIVITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Goal Adjustment</label>
              <select value={adjustment} onChange={e => { markTouched(); setAdjustment(e.target.value) }} className={inputCls}>
                {ADJ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {/* Results */}
          {valid ? (
            <>
              <div className="grid grid-cols-3 gap-3 bg-orange-50 border border-orange-100 rounded-xl p-4">
                <div className="text-center">
                  <p className="text-xs text-gray-500 mb-0.5">BMR</p>
                  <p className="text-xl font-bold text-gray-900">{bmr?.toLocaleString()}</p>
                  <p className="text-xs text-gray-400">kcal/day</p>
                </div>
                <div className="text-center border-x border-orange-100">
                  <p className="text-xs text-gray-500 mb-0.5">TDEE</p>
                  <p className="text-xl font-bold text-gray-900">{tdee?.toLocaleString()}</p>
                  <p className="text-xs text-gray-400">kcal/day</p>
                </div>
                <div className="text-center">
                  <p className="text-xs text-gray-500 mb-0.5">Goal Calories</p>
                  <p className="text-xl font-bold text-[#E8670A]">{goalCal?.toLocaleString()}</p>
                  <p className="text-xs text-gray-400">kcal/day</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={applyCalories}
                  disabled={applying}
                  className="flex-1 bg-[#f97316] hover:bg-[#E8670A] disabled:opacity-40 text-white text-sm font-semibold rounded-lg px-4 py-2.5 min-h-[44px] transition-colors">
                  {applying ? 'Applying…' : `Apply ${goalCal?.toLocaleString()} kcal to targets`}
                </button>
                {applied    && <span className="text-sm text-emerald-600 font-medium whitespace-nowrap">✓ Applied</span>}
                {applyError && <span className="text-sm text-red-500">{applyError}</span>}
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-400 text-center py-1">Enter sex, age, height, and weight to calculate.</p>
          )}
        </div>
      )}
    </div>
  )
}

function localDateStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function NutritionTab({ client, clientId, getToken, onUpdate }) {
  const today = localDateStr()
  const [date,    setDate]    = useState(today)
  const [daily,   setDaily]   = useState(null)
  const [weekly,  setWeekly]  = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const token = await getToken()
        const [dRes, wRes] = await Promise.all([
          fetch(`${API_URL}/api/coach-admin/clients/${clientId}/nutrition?date=${date}`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_URL}/api/coach-admin/clients/${clientId}/nutrition/weekly`,       { headers: { Authorization: `Bearer ${token}` } }),
        ])
        if (!cancelled) {
          if (dRes.ok) setDaily(await dRes.json())
          if (wRes.ok) setWeekly(await wRes.json())
        }
      } catch {} finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [clientId, date, getToken])

  function shiftNutrDate(n) {
    const d = new Date(date + 'T12:00:00Z')
    d.setDate(d.getDate() + n)
    return d.toISOString().slice(0, 10)
  }

  return (
    <div className="space-y-4">
      {/* 1. Date selector with prev/next */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setDate(shiftNutrDate(-1))}
          className="p-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-500 font-bold leading-none min-h-11 min-w-11 flex items-center justify-center">
          ‹
        </button>
        <input type="date" value={date} max={today}
          onChange={e => setDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 min-h-11" />
        <button
          onClick={() => setDate(shiftNutrDate(1))}
          disabled={date >= today}
          className="p-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-500 font-bold leading-none min-h-11 min-w-11 flex items-center justify-center disabled:opacity-30">
          ›
        </button>
        {date !== today && (
          <button onClick={() => setDate(today)} className="text-xs text-[#E8670A] font-medium hover:text-[#c45e09]">Today</button>
        )}
      </div>

      {/* 2. BMR / TDEE Calculator */}
      <BmrTdeeCalculator client={client} getToken={getToken} onUpdate={onUpdate} />

      {/* 3. Nutrition Targets */}
      <NutritionTargetsCard client={client} getToken={getToken} onUpdate={onUpdate} />

      {/* 4. Selected Day Summary */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Selected Day Summary</h3>
          <span className="text-xs text-gray-400">{date === today ? 'Today' : date}</span>
        </div>
        {loading ? <p className="text-xs text-gray-400">Loading…</p> : (
          <>
            <DaySummaryRow label="Calories" actual={daily?.total_calories} target={client.goal_calories} unit=" kcal" />
            <DaySummaryRow label="Protein"  actual={daily?.total_protein}  target={client.goal_protein}  unit="g" />
            <DaySummaryRow label="Carbs"    actual={daily?.total_carbs}    target={client.goal_carbs}    unit="g" />
            <DaySummaryRow label="Fat"      actual={daily?.total_fat}      target={client.goal_fat}      unit="g" />
            <DaySummaryRow label="Fiber"    actual={daily?.total_fiber}    target={client.goal_fiber}    unit="g" />
            <DaySummaryRow label="Water"    actual={daily?.water_oz}       target={client.goal_water}    unit=" oz" />
            <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-3 gap-2">
              <NutritionStat label="Steps"  value={daily?.steps} />
              <NutritionStat label="Weight" value={daily?.weight_lbs} unit=" lbs" />
              <NutritionStat label="Meals"  value={daily?.meal_count} />
            </div>
          </>
        )}
      </div>

      {/* 5. Food Log */}
      <FoodLogSection clientId={clientId} date={date} getToken={getToken} />

      {/* 6. 7-Day Averages */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">7-Day Averages</h3>
        {loading ? <p className="text-xs text-gray-400">Loading…</p> : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <NutritionStat label="Calories" value={weekly?.avg_calories}   unit=" kcal" />
            <NutritionStat label="Protein"  value={weekly?.avg_protein}    unit="g" />
            <NutritionStat label="Carbs"    value={weekly?.avg_carbs}      unit="g" />
            <NutritionStat label="Fat"      value={weekly?.avg_fat}        unit="g" />
            <NutritionStat label="Fiber"    value={weekly?.avg_fiber}      unit="g" />
            <NutritionStat label="Water"    value={weekly?.avg_water_oz}   unit=" oz" />
            <NutritionStat label="Steps"    value={weekly?.avg_steps} />
            <NutritionStat label="Weight"   value={weekly?.avg_weight_lbs} unit=" lbs" />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Habits Tab ───────────────────────────────────────────────────────────────

// Quick-assign buttons — clean labels only, no goal amounts.
// Coach sets target value + dates in the form.
const QUICK_PRESETS = [
  { label: 'Drink water',     habit_name: 'Drink water',     habit_type: 'numeric',    unit: 'oz',    identity_category: 'food_tracking' },
  { label: 'Step goal',       habit_name: 'Step goal',       habit_type: 'numeric',    unit: 'steps', identity_category: 'movement' },
  { label: 'Complete workout',habit_name: 'Complete workout',habit_type: 'completion',                identity_category: 'movement' },
  { label: 'Fiber goal',       habit_name: 'Fiber goal',       habit_type: 'numeric',    unit: 'g',     identity_category: 'food_tracking' },
  { label: 'Log food ahead',  habit_name: 'Log food ahead',  habit_type: 'boolean',                  identity_category: 'food_tracking' },
]

// Full habit library grouped by category
const HABIT_LIBRARY = [
  {
    category: 'Nutrition',
    identity_category: 'food_tracking',
    items: [
      { habit_name: 'Hit protein goal',         habit_type: 'numeric', unit: 'g' },
      { habit_name: 'Fiber goal',               habit_type: 'numeric', unit: 'g' },
      { habit_name: 'Log food',                 habit_type: 'boolean' },
      { habit_name: 'Log food ahead',           habit_type: 'boolean' },
      { habit_name: 'Eat vegetables',           habit_type: 'boolean' },
      { habit_name: 'Practice eating slowly',   habit_type: 'boolean' },
      { habit_name: 'Stop eating at 80% full',  habit_type: 'boolean' },
      { habit_name: 'Prepare your meals',       habit_type: 'boolean' },
      { habit_name: 'Drink only zero-calorie drinks', habit_type: 'boolean' },
      { habit_name: 'Follow portion guide',     habit_type: 'boolean' },
    ],
  },
  {
    category: 'Hydration',
    identity_category: 'food_tracking',
    items: [
      { habit_name: 'Drink water',    habit_type: 'numeric', unit: 'oz' },
      { habit_name: 'Hit water goal', habit_type: 'numeric', unit: 'oz' },
    ],
  },
  {
    category: 'Movement',
    identity_category: 'movement',
    items: [
      { habit_name: 'Step goal',          habit_type: 'numeric',    unit: 'steps' },
      { habit_name: 'Complete workout',   habit_type: 'completion' },
      { habit_name: 'Walk',               habit_type: 'boolean' },
      { habit_name: 'Stretch',            habit_type: 'boolean' },
      { habit_name: 'Mobility work',      habit_type: 'boolean' },
      { habit_name: 'Take an active route', habit_type: 'boolean' },
    ],
  },
  {
    category: 'Mindset',
    identity_category: 'mindset',
    items: [
      { habit_name: 'Journal',                     habit_type: 'boolean' },
      { habit_name: 'Watch brain mapping training',habit_type: 'boolean' },
      { habit_name: 'Complete mindset lesson',     habit_type: 'boolean' },
      { habit_name: 'Practice gratitude',          habit_type: 'boolean' },
      { habit_name: 'Self-care habit',             habit_type: 'boolean' },
    ],
  },
  {
    category: 'Sleep',
    identity_category: 'check_ins',
    items: [
      { habit_name: 'Bedtime routine',         habit_type: 'boolean' },
      { habit_name: 'Digital detox before bed',habit_type: 'boolean' },
      { habit_name: 'Sleep target',            habit_type: 'numeric', unit: 'hours' },
    ],
  },
  {
    category: 'Progress',
    identity_category: 'progress',
    items: [
      { habit_name: 'Daily weight',          habit_type: 'boolean' },
      { habit_name: 'Progress photos',       habit_type: 'boolean' },
      { habit_name: 'Complete check-in form',habit_type: 'boolean' },
      { habit_name: 'Measurements',          habit_type: 'boolean' },
    ],
  },
]

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

function habitActiveOnDay(h, date) {
  if (!h.active) return false
  const hStart = new Date(`${String(h.start_date).slice(0,10)}T00:00:00`)
  const hEnd   = h.end_date ? new Date(`${String(h.end_date).slice(0,10)}T00:00:00`) : null
  if (date < hStart) return false
  if (hEnd && date > hEnd) return false
  const dDow = date.getDay()
  if (h.frequency === 'specific_days') {
    const allowed = (h.days_of_week ?? '').split(',').map(s => parseInt(s, 10))
    return allowed.includes(dDow)
  }
  if (h.frequency === 'weekly') return dDow === hStart.getDay()
  return true
}

// Build a full-month grid for the coach calendar preview (habits + scheduled workouts).
// `viewMonth` is a Date anchored to the 1st of the month to display; defaults to the
// current month. `isToday` still compares against the real today, not viewMonth.
function buildMonthCalendar(habits, workoutCal = {}, viewMonth = new Date()) {
  const todayKey = localDateStr()
  const year = viewMonth.getFullYear()
  const month = viewMonth.getMonth()
  const firstDay = new Date(year, month, 1)
  const lastDay  = new Date(year, month + 1, 0)
  const monthName = firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  function cellFor(d, inMonth) {
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return {
      date: d, dateKey, inMonth, isToday: dateKey === todayKey,
      habits:   inMonth ? habits.filter(h => habitActiveOnDay(h, d)) : [],
      workouts: inMonth ? (workoutCal[dateKey] ?? []) : [],
    }
  }

  const cells = []
  // Pad days before month start
  for (let i = 0; i < firstDay.getDay(); i++) {
    const d = new Date(firstDay); d.setDate(d.getDate() - (firstDay.getDay() - i))
    cells.push(cellFor(d, false))
  }
  // Days in month
  for (let n = 1; n <= lastDay.getDate(); n++) {
    cells.push(cellFor(new Date(year, month, n), true))
  }
  // Pad end of last week
  const tail = cells.length % 7
  if (tail > 0) {
    let pad = new Date(lastDay); pad.setDate(pad.getDate() + 1)
    for (let i = 0; i < 7 - tail; i++) {
      cells.push(cellFor(pad, false))
      pad = new Date(pad); pad.setDate(pad.getDate() + 1)
    }
  }
  // Chunk into weeks
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return { monthName, weeks }
}

// Returns an array of 7 status objects for the last 7 days (oldest → today) for a given habit
function getHabitDots(habitId, calendar) {
  const todayKey = localDateStr()
  const dots = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    if (key > todayKey) { dots.push({ key, status: 'future' }); continue }
    const entry = (calendar[key] || []).find(e => e.habit.id === habitId)
    if (!entry) dots.push({ key, status: 'not_scheduled' })
    else if (entry.completion) dots.push({ key, status: 'completed' })
    else dots.push({ key, status: 'missed' })
  }
  return dots
}

function CalendarTab({ clientId, getToken }) {
  const [habits, setHabits] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [showPreview, setShowPreview] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [workoutCal, setWorkoutCal] = useState({})
  const [workoutDetail, setWorkoutDetail] = useState(null) // { assignment, dateISO } for read-only exercise list
  // Month currently shown in the calendar preview grid (1st-of-month anchor); navigable via prev/next.
  const [viewMonth, setViewMonth] = useState(() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), 1)
  })
  const [form, setForm] = useState({
    habit_name: '', habit_type: 'boolean', target_value: '', unit: '',
    frequency: 'daily', start_date: localDateStr(),
    end_date: '', days_of_week: '', notes: '', identity_category: '',
  })
  const [compCalendar, setCompCalendar] = useState(null)
  const [compLoading, setCompLoading] = useState(false)
  const [compError, setCompError] = useState(null)
  const [submitError, setSubmitError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/habits`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setHabits(await res.json())
    setLoading(false)
  }, [clientId, getToken])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    let cancelled = false
    async function loadCompliance() {
      setCompLoading(true)
      try {
        const now = new Date()
        const todayISO = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
        const d6 = new Date(now); d6.setDate(now.getDate() - 6)
        const startISO = `${d6.getFullYear()}-${String(d6.getMonth()+1).padStart(2,'0')}-${String(d6.getDate()).padStart(2,'0')}`
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/coach-admin/clients/${clientId}/habits/calendar?start=${startISO}&end=${todayISO}`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (!res.ok) throw new Error('Could not load compliance data')
        const data = await res.json()
        if (!cancelled) setCompCalendar(data.calendar)
      } catch (e) {
        if (!cancelled) setCompError(e.message)
      } finally {
        if (!cancelled) setCompLoading(false)
      }
    }
    loadCompliance()
    return () => { cancelled = true }
  }, [clientId, getToken])

  // Scheduled workouts for the visible month-grid — same shape as habits/calendar,
  // fetched with a week of padding on each side to cover the grid's leading/trailing days.
  // Re-fetches whenever the coach navigates to a different month.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1 - 7)
        const last  = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0 + 7)
        const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/coach-admin/clients/${clientId}/workout-schedules/calendar?start=${fmt(first)}&end=${fmt(last)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (res.ok && !cancelled) setWorkoutCal((await res.json()).calendar ?? {})
      } catch { /* calendar preview is best-effort */ }
    })()
    return () => { cancelled = true }
  }, [clientId, getToken, viewMonth])

  function applyPreset(p) {
    setForm(f => ({
      ...f,
      habit_name:        p.habit_name,
      habit_type:        p.habit_type === 'completion' ? 'boolean' : p.habit_type,
      target_value:      '',  // coach sets the goal
      unit:              p.unit ?? '',
      frequency:         'daily',
      start_date:        localDateStr(),
      end_date:          '',
      days_of_week:      '',
      notes:             '',
      identity_category: p.identity_category ?? '',
    }))
    setShowForm(true)
    setShowLibrary(false)
  }

  function toggleDay(idx) {
    const current = form.days_of_week ? form.days_of_week.split(',').map(Number) : []
    const next = current.includes(idx) ? current.filter(d => d !== idx) : [...current, idx].sort()
    setForm(f => ({ ...f, days_of_week: next.join(',') }))
  }

  async function submit() {
    if (!form.habit_name.trim() || !form.start_date) {
      setSubmitError('Habit name and start date are required.')
      return
    }
    setSubmitting(true); setSubmitError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/habits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          target_value:      form.target_value !== '' ? Number(form.target_value) : null,
          end_date:          form.end_date || null,
          days_of_week:      form.frequency === 'specific_days' ? (form.days_of_week || null) : null,
          identity_category: form.identity_category || null,
        }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || `Failed to assign habit (${res.status})`)
      }
      setForm({
        habit_name: '', habit_type: 'boolean', target_value: '', unit: '',
        frequency: 'daily', start_date: localDateStr(),
        end_date: '', days_of_week: '', notes: '', identity_category: '',
      })
      setShowForm(false)
      await load()
    } catch (err) {
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function deleteHabit(habitId) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/habits/${habitId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setHabits(h => h.filter(x => x.id !== habitId))
  }

  function startEdit(h) {
    setEditingId(h.id)
    setEditForm({
      habit_name:   h.habit_name,
      habit_type:   (h.habit_type === 'completion' ? 'boolean' : h.habit_type) ?? 'boolean',
      target_value: h.target_value != null ? String(h.target_value) : '',
      unit:         h.unit ?? '',
      frequency:    h.frequency ?? 'daily',
      start_date:   String(h.start_date).slice(0, 10),
      end_date:     h.end_date ? String(h.end_date).slice(0, 10) : '',
      notes:        h.notes ?? '',
      days_of_week: h.days_of_week ?? '',
    })
  }

  async function saveEdit(habitId) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/habits/${habitId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        habit_name:   editForm.habit_name.trim() || undefined,
        habit_type:   editForm.habit_type || undefined,
        target_value: editForm.target_value !== '' ? Number(editForm.target_value) : null,
        unit:         editForm.unit || undefined,
        frequency:    editForm.frequency || undefined,
        start_date:   editForm.start_date || undefined,
        end_date:     editForm.end_date || null,
        notes:        editForm.notes.trim() || null,
        days_of_week: editForm.frequency === 'specific_days' ? (editForm.days_of_week || null) : null,
      }),
    })
    if (res.ok) {
      const updated = await res.json()
      setHabits(prev => prev.map(h => h.id === habitId ? updated : h))
      setEditingId(null)
    }
  }

  function toggleEditDay(idx) {
    const current = editForm.days_of_week ? editForm.days_of_week.split(',').map(Number) : []
    const next = current.includes(idx) ? current.filter(d => d !== idx) : [...current, idx].sort()
    setEditForm(f => ({ ...f, days_of_week: next.join(',') }))
  }

  const monthCal = buildMonthCalendar(habits, workoutCal, viewMonth)
  const hasCalendarData = habits.length > 0 || Object.keys(workoutCal).length > 0
  const isCurrentMonth = (() => {
    const n = new Date()
    return viewMonth.getFullYear() === n.getFullYear() && viewMonth.getMonth() === n.getMonth()
  })()
  function prevMonth() { setViewMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1)) }
  function nextMonth() { setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1)) }
  function jumpToCurrentMonth() {
    const n = new Date()
    setViewMonth(new Date(n.getFullYear(), n.getMonth(), 1))
  }

  return (
    <div className="space-y-4">
      {/* Quick presets */}
      <div className="bg-white border border-gray-200 rounded-xl p-3">
        <p className="text-xs font-semibold text-gray-700 mb-2">Quick assign</p>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_PRESETS.map(p => (
            <button key={p.label} onClick={() => applyPreset(p)}
              className="px-2 py-1 rounded-lg text-xs font-medium border border-gray-200 text-gray-700 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors">
              + {p.label}
            </button>
          ))}
          <button onClick={() => setShowForm(s => !s)}
            className="px-2 py-1 rounded-lg text-xs font-bold bg-[#E8670A] text-white hover:bg-[#c45e09]">
            + Custom
          </button>
          <button onClick={() => setShowLibrary(s => !s)}
            className="px-2 py-1 rounded-lg text-xs font-medium border border-[#1e2a3a] text-[#1e2a3a] hover:bg-[#1e2a3a] hover:text-white transition-colors">
            📚 Library
          </button>
          {hasCalendarData && (
            <button onClick={() => setShowPreview(s => !s)}
              className="px-2 py-1 rounded-lg text-xs font-medium border border-[#1e2a3a] text-[#1e2a3a] hover:bg-[#1e2a3a] hover:text-white transition-colors">
              📅 {showPreview ? 'Hide Calendar' : 'Show Calendar'}
            </button>
          )}
        </div>
      </div>

      {/* Month calendar — habits + scheduled workouts together */}
      {showPreview && hasCalendarData && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-sm font-semibold text-gray-700">📅 {monthCal.monthName} — Client calendar</p>
            <div className="flex items-center gap-2">
              <button onClick={prevMonth} aria-label="Previous month"
                className="w-9 h-9 rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 min-h-[44px] min-w-[44px] flex items-center justify-center">
                ←
              </button>
              {!isCurrentMonth && (
                <button onClick={jumpToCurrentMonth} className="text-xs text-[#E8670A] hover:text-[#c45e09] font-semibold px-1">
                  Today
                </button>
              )}
              <button onClick={nextMonth} aria-label="Next month"
                className="w-9 h-9 rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 min-h-[44px] min-w-[44px] flex items-center justify-center">
                →
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DAYS.map(d => (
              <p key={d} className="text-[10px] font-bold text-gray-400 text-center py-1">{d}</p>
            ))}
          </div>
          {monthCal.weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7 gap-1 mb-1">
              {week.map(({ date, dateKey, habits: dayHabits, workouts: dayWorkouts, inMonth, isToday }) => (
                <div key={dateKey} className={`border rounded-lg p-1 min-h-[68px] ${
                  !inMonth ? 'border-transparent bg-gray-50/40 opacity-40' :
                  isToday  ? 'border-[#E8670A] bg-orange-50' : 'border-gray-200 bg-white'
                }`}>
                  <p className={`text-[10px] font-bold leading-tight mb-0.5 ${isToday ? 'text-[#E8670A]' : inMonth ? 'text-gray-600' : 'text-gray-300'}`}>
                    {date.getDate()}
                  </p>
                  <div className="space-y-0.5">
                    {dayWorkouts.map((w, wi2) => (
                      <button
                        key={`w-${w.assignment.id}-${wi2}`}
                        onClick={() => setWorkoutDetail({ assignment: w.assignment, dateISO: dateKey })}
                        title={`${formatDayLabel(w.assignment.day_label)} · ${w.assignment.workout_name}`}
                        className="w-full text-left text-[8px] font-semibold bg-orange-50 text-[#c45e09] border border-orange-200 px-1 py-px rounded truncate leading-tight hover:bg-orange-100 transition-colors"
                      >
                        {w.log ? '✓ ' : ''}{formatDayLabel(w.assignment.day_label)}
                      </button>
                    ))}
                    {dayHabits.slice(0, 3).map(h => (
                      <div key={h.id} className="text-[8px] bg-emerald-50 text-emerald-700 px-1 py-px rounded truncate leading-tight" title={h.habit_name}>
                        {h.habit_name}
                      </div>
                    ))}
                    {dayHabits.length > 3 && (
                      <p className="text-[8px] text-gray-400">+{dayHabits.length - 3}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
          <p className="text-[10px] text-gray-400 mt-2 italic">
            Preview of what your client sees on their Calendar.
          </p>
        </div>
      )}

      {/* Full library (collapsed by default) */}
      {showLibrary && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-gray-900">Habit library</p>
            <button onClick={() => setShowLibrary(false)} className="text-xs text-gray-400 hover:text-gray-600">Close</button>
          </div>
          <div className="space-y-4">
            {HABIT_LIBRARY.map(group => (
              <div key={group.category}>
                <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider mb-1.5">{group.category}</p>
                <div className="flex flex-wrap gap-1.5">
                  {group.items.map(item => (
                    <button key={item.habit_name} onClick={() => applyPreset({ ...item, identity_category: group.identity_category })}
                      className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 text-gray-700 hover:border-[#E8670A] hover:text-[#E8670A] hover:bg-orange-50 transition-colors">
                      + {item.habit_name}{item.unit ? ` (${item.unit})` : ''}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="bg-white border border-orange-200 rounded-xl p-5 space-y-3">
          <p className="text-sm font-semibold text-gray-900">Assign new habit</p>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Habit name</label>
            <input value={form.habit_name} onChange={e => setForm(f => ({ ...f, habit_name: e.target.value }))}
              placeholder="e.g. Drink 48 oz of water"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
          <div className={`grid gap-2 ${form.habit_type === 'numeric' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1'}`}>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
              <select value={form.habit_type} onChange={e => setForm(f => ({ ...f, habit_type: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white">
                <option value="boolean">Completion</option>
                <option value="numeric">Progress goal</option>
              </select>
            </div>
            {form.habit_type === 'numeric' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Target</label>
                <input type="number" value={form.target_value} onChange={e => setForm(f => ({ ...f, target_value: e.target.value }))}
                  placeholder="48"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            )}
            {form.habit_type === 'numeric' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                <input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                  placeholder="oz / steps"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Frequency</label>
            <select value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
              <option value="daily">Daily</option>
              <option value="specific_days">Specific days of week</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          {form.frequency === 'specific_days' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Days</label>
              <div className="flex gap-1.5 flex-wrap">
                {DAYS.map((d, i) => {
                  const selected = (form.days_of_week || '').split(',').map(Number).includes(i)
                  return (
                    <button key={d} type="button" onClick={() => toggleDay(i)}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border-2 ${
                        selected ? 'bg-[#E8670A] border-[#E8670A] text-white' : 'border-gray-200 text-gray-600 hover:border-[#E8670A]'
                      }`}>{d}</button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Start date</label>
              <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">End date (optional)</label>
              <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Habit Category</label>
            <select value={form.identity_category} onChange={e => setForm(f => ({ ...f, identity_category: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">— None —</option>
              <option value="food_tracking">Food Tracking</option>
              <option value="hydration">Hydration</option>
              <option value="movement">Movement</option>
              <option value="mindset">Mindset</option>
              <option value="check_ins">Check-Ins</option>
              <option value="progress">Progress</option>
            </select>
          </div>
          {/* Coach note field hidden — notes column preserved in DB; existing
              notes still display on assigned habit cards below. */}
          {submitError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{submitError}</p>
          )}
          <div className="flex gap-2">
            <button onClick={submit} disabled={submitting}
              className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60">
              {submitting ? 'Assigning…' : 'Assign Habit'}
            </button>
            <button onClick={() => { setShowForm(false); setSubmitError(null) }} className="text-sm text-gray-500 px-3 py-2">Cancel</button>
          </div>
        </div>
      )}

      {/* Active habits */}
      <div>
        <p className="text-sm font-semibold text-gray-700 mb-2">Coach-assigned habits</p>
        {loading && <p className="text-sm text-gray-400">Loading…</p>}
        {!loading && habits.length === 0 && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-6 text-center text-sm text-gray-500">
            No habits assigned yet. Use a preset above to get started.
          </div>
        )}
        <div className="space-y-2">
          {habits.map(h => (
            <div key={h.id} className="bg-white border border-gray-200 rounded-xl p-4">
              {editingId === h.id ? (
                <div className="space-y-3">
                  <p className="text-sm font-semibold text-gray-900">Edit habit</p>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Habit name</label>
                    <input value={editForm.habit_name} onChange={e => setEditForm(f => ({ ...f, habit_name: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
                  </div>
                  <div className={`grid gap-2 ${editForm.habit_type === 'numeric' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1'}`}>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
                      <select value={editForm.habit_type} onChange={e => setEditForm(f => ({ ...f, habit_type: e.target.value }))}
                        className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white">
                        <option value="boolean">Completion</option>
                        <option value="numeric">Progress goal</option>
                      </select>
                    </div>
                    {editForm.habit_type === 'numeric' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Target</label>
                        <input type="number" value={editForm.target_value} onChange={e => setEditForm(f => ({ ...f, target_value: e.target.value }))}
                          placeholder="—" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                      </div>
                    )}
                    {editForm.habit_type === 'numeric' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                        <input value={editForm.unit} onChange={e => setEditForm(f => ({ ...f, unit: e.target.value }))}
                          placeholder="oz / steps" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Frequency</label>
                    <select value={editForm.frequency} onChange={e => setEditForm(f => ({ ...f, frequency: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white">
                      <option value="daily">Daily</option>
                      <option value="specific_days">Specific days</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </div>
                  {editForm.frequency === 'specific_days' && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Days</label>
                      <div className="flex gap-1.5 flex-wrap">
                        {DAYS.map((d, i) => {
                          const sel = (editForm.days_of_week || '').split(',').map(Number).includes(i)
                          return (
                            <button key={d} type="button" onClick={() => toggleEditDay(i)}
                              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border-2 ${
                                sel ? 'bg-[#E8670A] border-[#E8670A] text-white' : 'border-gray-200 text-gray-600 hover:border-[#E8670A]'
                              }`}>{d}</button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Start date</label>
                      <input type="date" value={editForm.start_date} onChange={e => setEditForm(f => ({ ...f, start_date: e.target.value }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">End date (clear = ongoing)</label>
                      <input type="date" value={editForm.end_date} onChange={e => setEditForm(f => ({ ...f, end_date: e.target.value }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Coach note (optional)</label>
                    <input value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                      placeholder="Optional message shown to client"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => saveEdit(h.id)}
                      className="bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09]">Save</button>
                    <button onClick={() => setEditingId(null)}
                      className="text-sm text-gray-500 px-3 py-2 hover:text-gray-700">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 text-sm">{h.habit_name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {h.target_value ? `${h.target_value} ${h.unit ?? ''} · ` : ''}{h.frequency}
                      {h.days_of_week && ` (${h.days_of_week.split(',').map(d => DAYS[d]).join(', ')})`}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {String(h.start_date).slice(0, 10)}
                      {h.end_date ? ` → ${String(h.end_date).slice(0, 10)}` : ' → ongoing'}
                      {h.assigned_by_name && ` · by ${h.assigned_by_name}`}
                    </p>
                    {h.identity_category && (
                      <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-50 text-[#E8670A] border border-orange-200">
                        {{food_tracking:'Food Tracking',hydration:'Hydration',movement:'Movement',mindset:'Mindset',check_ins:'Check-Ins',progress:'Progress'}[h.identity_category] ?? h.identity_category}
                      </span>
                    )}
                    {h.notes && <p className="text-xs text-[#E8670A] italic mt-1">"{h.notes}"</p>}
                    {/* 7-day compliance row */}
                    {compLoading && !compCalendar && (
                      <p className="text-[10px] text-gray-300 mt-2">Loading compliance…</p>
                    )}
                    {compError && !compCalendar && (
                      <p className="text-[10px] text-gray-300 mt-2">Compliance unavailable</p>
                    )}
                    {compCalendar && (() => {
                      const dots = getHabitDots(h.id, compCalendar)
                      const scheduled = dots.filter(d => d.status !== 'not_scheduled' && d.status !== 'future')
                      const completed = dots.filter(d => d.status === 'completed')
                      return (
                        <div className="flex items-center gap-1 mt-2">
                          {dots.map(dot => (
                            <div key={dot.key} title={dot.key} className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                              dot.status === 'completed'     ? 'bg-emerald-500' :
                              dot.status === 'missed'        ? 'bg-red-400' :
                              'bg-gray-200'
                            }`} />
                          ))}
                          <span className="text-[10px] text-gray-400 ml-0.5">
                            {scheduled.length > 0
                              ? `${completed.length}/${scheduled.length} this week`
                              : 'No scheduled days this week'}
                          </span>
                        </div>
                      )
                    })()}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => startEdit(h)}
                      className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">Edit</button>
                    <button onClick={() => deleteHabit(h.id)}
                      className="text-xs text-red-400 hover:text-red-600 font-medium">Remove</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {workoutDetail && (
        <WorkoutDetailPanel
          clientId={clientId}
          assignment={workoutDetail.assignment}
          dateISO={workoutDetail.dateISO}
          getToken={getToken}
          onClose={() => setWorkoutDetail(null)}
        />
      )}
    </div>
  )
}

// Read-only exercise list for a scheduled workout day — coaches view what's
// scheduled, they don't log sets on a client's behalf (that stays client-only).
function WorkoutDetailPanel({ clientId, assignment, dateISO, getToken, onClose }) {
  const [exercises, setExercises] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/workouts/${assignment.workout_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        const data = await res.json()
        if (alive) setExercises((data.exercises ?? []).filter(ex => ex.day === assignment.day_label))
      } catch (err) {
        if (alive) setError(err.message)
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [clientId, assignment, getToken])

  const dateLabel = new Date(dateISO + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[92vh] flex flex-col overflow-hidden shadow-xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{formatDayLabel(assignment.day_label)}</p>
            <p className="text-[11px] text-gray-400 truncate">{assignment.workout_name} &middot; {dateLabel}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1.5 leading-none shrink-0 text-lg">&#10005;</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 space-y-3">
          {loading ? (
            <p className="text-xs text-gray-400">Loading&hellip;</p>
          ) : error ? (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          ) : exercises.length === 0 ? (
            <p className="text-sm text-gray-500">No exercises found for this workout day.</p>
          ) : exercises.map(ex => (
            <div key={ex.id} className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-2.5 p-2.5 bg-gray-50">
                <ExerciseThumb src={ex.image_url} alt={ex.exercise_name} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{ex.exercise_name}</p>
                  <p className="text-[11px] text-gray-500">
                    {ex.sets ?? '—'} sets
                    {ex.reps ? ` · ${ex.reps} reps` : ''}
                    {ex.weight ? ` · ${ex.weight}` : ''}
                    {ex.rest_seconds ? ` · ${ex.rest_seconds}s rest` : ''}
                  </p>
                  {ex.notes && <p className="text-[11px] text-gray-400 whitespace-pre-wrap break-words">{ex.notes}</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end px-4 py-3 border-t border-gray-100 shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Progress Tab ─────────────────────────────────────────────────────────────

const MFIELDS = [
  { key: 'chest', label: 'Chest/Bust', sub: 'nipple line' },
  { key: 'waist', label: 'Waist',      sub: 'belly button' },
  { key: 'hips',  label: 'Hips',       sub: 'widest point' },
]

function MeasurementsSection({ clientId, getToken, startDate, endDate }) {
  const [measurements, setMeasurements] = useState([])
  const [mLoading,     setMLoading]     = useState(true)
  const [showForm,     setShowForm]     = useState(false)
  const [mForm,        setMForm]        = useState({
    measurement_date: localDateStr(),
    chest: '', waist: '', hips: '',
  })
  const [mSaving, setMSaving] = useState(false)
  const [mError,  setMError]  = useState(null)
  const [editingId, setEditingId] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const params = startDate && endDate ? `?start_date=${startDate}&end_date=${endDate}` : ''
        const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/measurements${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok && !cancelled) setMeasurements(await res.json())
      } finally { if (!cancelled) setMLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [clientId, getToken, startDate, endDate])

  async function addMeasurement(e) {
    e.preventDefault()
    setMSaving(true); setMError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/measurements`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          measurement_date: mForm.measurement_date,
          chest: mForm.chest !== '' ? Number(mForm.chest) : null,
          waist: mForm.waist !== '' ? Number(mForm.waist) : null,
          hips:  mForm.hips  !== '' ? Number(mForm.hips)  : null,
        }),
      })
      if (res.ok) {
        const m = await res.json()
        setMeasurements(prev => [m, ...prev].sort((a, b) => String(b.measurement_date).localeCompare(String(a.measurement_date))))
        setMForm({ measurement_date: localDateStr(), chest: '', waist: '', hips: '' })
        setShowForm(false)
      } else {
        setMError('Failed to save. Please try again.')
      }
    } catch { setMError('Failed to save. Please try again.') }
    finally  { setMSaving(false) }
  }

  function startEdit(m) {
    setEditingId(m.id)
    setShowForm(true)
    setMError(null)
    setMForm({
      measurement_date: String(m.measurement_date).slice(0, 10),
      chest: m.chest ?? '',
      waist: m.waist ?? '',
      hips: m.hips ?? '',
    })
  }

  async function updateMeasurement(e) {
    e.preventDefault()
    setMSaving(true); setMError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/measurements/${editingId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          measurement_date: mForm.measurement_date,
          chest: mForm.chest !== '' ? Number(mForm.chest) : null,
          waist: mForm.waist !== '' ? Number(mForm.waist) : null,
          hips:  mForm.hips  !== '' ? Number(mForm.hips)  : null,
        }),
      })
      if (!res.ok) throw new Error()
      const updated = await res.json()
      setMeasurements(prev => prev
        .map(m => m.id === editingId ? updated : m)
        .sort((a, b) => String(b.measurement_date).localeCompare(String(a.measurement_date))))
      setEditingId(null)
      setShowForm(false)
      setMForm({ measurement_date: new Date().toISOString().slice(0, 10), chest: '', waist: '', hips: '' })
    } catch { setMError('Failed to save. Please try again.') }
    finally  { setMSaving(false) }
  }

  async function deleteMeasurement(id) {
    if (!window.confirm('Delete this measurement entry? This cannot be undone.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/measurements/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setMeasurements(prev => prev.filter(m => m.id !== id))
  }

  const latest = measurements[0] ?? null
  const first  = measurements.length > 1 ? measurements[measurements.length - 1] : null

  function delta(key) {
    if (!latest || !first) return null
    const l = Number(latest[key]), f = Number(first[key])
    if (!l || !f) return null
    const d = +(l - f).toFixed(1)
    return { d, from: f.toFixed(1), to: l.toFixed(1) }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-gray-900">Measurements</p>
        <button onClick={() => setShowForm(s => !s)}
          className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={editingId ? updateMeasurement : addMeasurement} className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
            <input type="date" value={mForm.measurement_date}
              onChange={e => setMForm(f => ({ ...f, measurement_date: e.target.value }))}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full max-w-[180px]" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            {MFIELDS.map(({ key, label, sub }) => (
              <div key={key}>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {label} <span className="font-normal text-gray-400 hidden sm:inline">({sub})</span>
                </label>
                <div className="relative">
                  <input type="number" step="0.1" min="0" value={mForm[key]}
                    onChange={e => setMForm(f => ({ ...f, [key]: e.target.value }))}
                    placeholder="0.0"
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full pr-7" />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">in</span>
                </div>
              </div>
            ))}
          </div>
          {mError && <p className="text-xs text-red-500">{mError}</p>}
          <button type="submit" disabled={mSaving}
            className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-60">
            {mSaving ? 'Saving…' : 'Save Measurement'}
          </button>
        </form>
      )}

      {mLoading && <p className="text-xs text-gray-400 py-4 text-center">Loading…</p>}

      {!mLoading && measurements.length === 0 && (
        <p className="text-xs text-gray-400 bg-gray-50 border border-dashed border-gray-200 rounded-lg px-3 py-2">
          No measurements recorded yet.
        </p>
      )}

      {!mLoading && measurements.length > 0 && (
        <>
          {/* Latest + trend summary */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4">
            {MFIELDS.map(({ key, label }) => {
              const val = latest?.[key] ? `${Number(latest[key]).toFixed(1)}"` : '—'
              const d = delta(key)
              return (
                <div key={key} className="bg-gray-50 rounded-lg p-2.5 sm:p-3">
                  <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mb-0.5 truncate">{label}</p>
                  <p className="text-base font-bold text-gray-900">{val}</p>
                  {d && (
                    <p className={`text-[10px] font-medium mt-0.5 ${d.d < 0 ? 'text-emerald-600' : d.d > 0 ? 'text-red-500' : 'text-gray-400'}`}>
                      {d.from}" → {d.to}" ({d.d > 0 ? '+' : ''}{d.d}")
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {/* History table */}
          <div className="overflow-x-auto -mx-4 px-4">
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
                {measurements.map((m, i) => (
                  <tr key={m.id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}>
                    <td className="px-3 py-2 text-gray-700 font-medium whitespace-nowrap">{String(m.measurement_date).slice(0, 10)}</td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.chest ? `${Number(m.chest).toFixed(1)}"` : '-'}</td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.waist ? `${Number(m.waist).toFixed(1)}"` : '-'}</td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{m.hips  ? `${Number(m.hips).toFixed(1)}"` : '-'}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button type="button" onClick={() => startEdit(m)} className="text-[#E8670A] font-semibold mr-3">Edit</button>
                      <button type="button" onClick={() => deleteMeasurement(m.id)} className="text-red-500 font-semibold">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function MiniChart({ series, valueKey = 'value', series2, valueKey2, color = '#E8670A', color2 = '#10b981' }) {
  // Sort oldest→newest using timestamp — pg returns date columns as JS Date
  // objects, so String().localeCompare() gives wrong (alphabetical weekday) order.
  const sorted1 = (series  ?? []).slice().sort((a, b) => new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime())
  const sorted2 = (series2 ?? []).slice().sort((a, b) => new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime())
  const vals1 = sorted1.map(d => Number(d[valueKey]) || 0)
  const vals2 = series2 ? sorted2.map(d => Number(d[valueKey2 ?? valueKey]) || 0) : []
  if (vals1.length < 2) return <p className="text-[11px] text-gray-300 text-center py-6">Not enough data</p>
  const all = [...vals1, ...vals2].filter(v => v > 0)
  const mn = all.length ? Math.min(...all) : 0
  const mx = all.length ? Math.max(...all) : 1
  const sp = mx - mn || 1
  const W = 300, H = 72
  function pts(vals) {
    return vals.map((v, i) => {
      const x = (i / Math.max(vals.length - 1, 1)) * W
      const y = H - 4 - ((v - mn) / sp) * (H - 12)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: 72 }}>
      <polyline points={pts(vals1)} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {vals2.length >= 2 && (
        <polyline points={pts(vals2)} fill="none" stroke={color2} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="5 3" />
      )}
    </svg>
  )
}

function ChartCard({ title, legend, series, valueKey, series2, valueKey2, color, color2, fmtVal }) {
  const points = (series ?? [])
    .filter(d => d[valueKey] != null && Number.isFinite(Number(d[valueKey])))
    .sort((a, b) => new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime())
  const hasEnoughData = points.length >= 2
  const vals1   = points.map(d => Number(d[valueKey]))
  const minVal  = hasEnoughData ? Math.min(...vals1) : null
  const maxVal  = hasEnoughData ? Math.max(...vals1) : null
  const fmt     = v => fmtVal ? fmtVal(v) : (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1))
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <p className="text-xs font-semibold text-gray-700">{title}</p>
        {legend && <div className="flex items-center gap-3 text-[10px] text-gray-400">{legend}</div>}
      </div>
      {hasEnoughData ? (
        <>
          {/* Min/max labels — matches the client-facing ChartCard style */}
          {!series2 && minVal != null && (
            <div className="flex justify-between text-[10px] text-gray-400 mb-0.5">
              <span>{fmt(minVal)}</span>
              <span>{fmt(maxVal)}</span>
            </div>
          )}
          <MiniChart series={series} valueKey={valueKey} series2={series2} valueKey2={valueKey2} color={color} color2={color2} />
        </>
      ) : (
        <p className="text-[11px] text-gray-300 text-center py-6">Need 2+ entries to chart.</p>
      )}
    </div>
  )
}

function SummaryCard({ label, value, sub, color }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3 sm:p-4">
      <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide truncate">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold mt-0.5 ${color ?? 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function ProgressTab({ clientId, clientName, getToken, role }) {
  const [range,       setRange]       = useState('daily')
  const [foodLogDate, setFoodLogDate] = useState(null)
  const today = localDateStr()
  const thirtyDaysAgo = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const [startDate, setStartDate] = useState(thirtyDaysAgo)
  const [endDate,   setEndDate]   = useState(today)
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(false)
    async function load() {
      try {
        const token = await getToken()
        const params = new URLSearchParams({ range })
        if (range === 'custom') {
          params.set('start_date', startDate)
          params.set('end_date', endDate)
        }
        const res = await fetch(
          `${API_URL}/api/coach-admin/clients/${clientId}/progress?${params.toString()}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!cancelled) {
          if (res.ok) setData(await res.json()); else setError(true)
          setLoading(false)
        }
      } catch { if (!cancelled) { setError(true); setLoading(false) } }
    }
    load()
    return () => { cancelled = true }
  }, [clientId, getToken, range, startDate, endDate])

  const s      = data?.summary        ?? {}
  const wt     = data?.weight_series  ?? []
  const mac    = data?.macro_series   ?? []
  const stp    = data?.step_series    ?? []
  const slp    = data?.sleep_series   ?? []
  const rows   = data?.table_rows     ?? []
  const photoSessions = data?.progress_photos ?? []
  const effectiveStart = data?.start_date ?? startDate
  const effectiveEnd   = data?.end_date ?? endDate

  const weightCurrent      = data?.weight_current      ?? data?.starting_weight_lbs ?? null
  const profileAge         = data?.age                 ?? null
  const heightInches       = data?.height_inches       ?? null
  const startingWeightLbs  = data?.starting_weight_lbs ?? null
  const profileStartDate   = data?.effective_start_date ?? null
  const profileEndDate     = data?.program_end_date    ?? null
  const goalCalories       = data?.goal_calories       ?? null
  const goalProtein        = data?.goal_protein        ?? null
  const goalCarbs          = data?.goal_carbs          ?? null
  const goalFat            = data?.goal_fat            ?? null

  // Photo comparison state
  const [showCompare, setShowCompare] = useState(false)
  const [sessionAIdx, setSessionAIdx] = useState(0)
  const [sessionBIdx, setSessionBIdx] = useState(1)

  // Weight change = current weight minus starting weight (all-time)
  const overallWtChange = (weightCurrent != null && startingWeightLbs != null)
    ? Math.round((Number(weightCurrent) - Number(startingWeightLbs)) * 10) / 10
    : null
  const overallWtColor = overallWtChange == null ? 'text-gray-900'
    : overallWtChange < 0 ? 'text-emerald-600'
    : overallWtChange > 0 ? 'text-red-500'
    : 'text-gray-900'

  const wc = s.weight_change
  const wtColor = wc == null ? 'text-gray-900' : wc < 0 ? 'text-emerald-600' : wc > 0 ? 'text-red-500' : 'text-gray-900'
  const rangeLabel = range === 'custom'
    ? `${effectiveStart} to ${effectiveEnd}`
    : range.charAt(0).toUpperCase() + range.slice(1)

  function fmtSleep(mins) {
    if (!mins) return '—'
    const h = Math.floor(Number(mins) / 60)
    const m = Number(mins) % 60
    return m ? `${h}h ${m}m` : `${h}h`
  }

  function fmtHeight(inches) {
    if (!inches) return '—'
    const ft = Math.floor(Number(inches) / 12)
    const in_ = Number(inches) % 12
    return `${ft}'${in_}"`
  }

  function goalTag(cal, prot, carbs, fat) {
    const parts = []
    if (cal)   parts.push(`Cal ${Number(cal).toLocaleString()}`)
    if (prot)  parts.push(`P ${prot}`)
    if (carbs) parts.push(`C ${carbs}`)
    if (fat)   parts.push(`F ${fat}`)
    return parts.length ? parts.join(' · ') : null
  }
  // Convert sleep series minutes → hours for chart display
  const slpHrs = slp.map(d => ({ date: d.date, value: d.value ? +(Number(d.value) / 60).toFixed(1) : 0 }))

  async function deleteProgressPhoto(photoId) {
    if (!window.confirm('Delete this progress photo? This cannot be undone.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/progress-photos/${photoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return
    setData(prev => {
      if (!prev) return prev
      const progress_photos = (prev.progress_photos ?? [])
        .map(session => {
          const photos = { ...session.photos }
          for (const angle of ['front', 'side', 'back']) {
            if (photos[angle]?.id === photoId) photos[angle] = null
          }
          return { ...session, photos }
        })
        .filter(session => ['front', 'side', 'back'].some(angle => session.photos[angle]))
      return { ...prev, progress_photos }
    })
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <h2 className="text-lg font-bold text-gray-900">Progress</h2>

      {/* Quick stats strip */}
      {data && (
        <div className="grid grid-cols-4 sm:grid-cols-7 gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2.5">
          {[
            { label: 'Age',       value: profileAge      ? String(profileAge)             : '—' },
            { label: 'Height',    value: fmtHeight(heightInches) },
            { label: 'Start Wt',  value: startingWeightLbs ? `${startingWeightLbs} lbs`   : '—' },
            { label: 'Current Wt',value: weightCurrent   ? `${weightCurrent} lbs`         : '—' },
            { label: 'Change',    value: overallWtChange != null ? `${overallWtChange > 0 ? '+' : ''}${overallWtChange} lbs` : '—', color: overallWtColor },
            { label: 'Joined',    value: profileStartDate ? fmtDate(profileStartDate)      : '—' },
            { label: 'Prog. End', value: profileEndDate  ? fmtDate(profileEndDate)         : '—' },
          ].map(({ label, value, color }) => (
            <div key={label} className="text-center min-w-0">
              <p className="text-[9px] text-gray-400 font-medium uppercase tracking-wide truncate">{label}</p>
              <p className={`text-xs sm:text-sm font-bold truncate ${color ?? 'text-gray-800'}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Range controls */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-semibold">
          {['daily','weekly','monthly','custom'].map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-3 py-2 capitalize transition-colors min-h-11 ${range === r ? 'bg-[#E8670A] text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-gray-500">
            <span className="hidden sm:inline">Start Date</span>
            <input
              type="date"
              aria-label="Start Date"
              value={startDate}
              onChange={e => { setStartDate(e.target.value); setRange('custom') }}
              max={endDate}
              className="min-h-11 rounded-lg border border-gray-200 px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </label>
          <label className="flex items-center gap-1 text-gray-500">
            <span className="hidden sm:inline">End Date</span>
            <input
              type="date"
              aria-label="End Date"
              value={endDate}
              onChange={e => { setEndDate(e.target.value); setRange('custom') }}
              min={startDate}
              max={today}
              className="min-h-11 rounded-lg border border-gray-200 px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </label>
        </div>
      </div>

      {loading && <p className="text-sm text-gray-400 text-center py-10">Loading…</p>}
      {error   && <p className="text-sm text-red-500 text-center py-10">Failed to load progress data.</p>}

      {!loading && !error && (
        <>
          {/* Averages & Trends table — table-first, above charts */}
          {rows.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 px-4 py-3 border-b border-gray-100">
                <p className="text-sm font-semibold text-gray-900">Averages &amp; Trends</p>
                <p className="text-[11px] text-gray-400">
                  {range === 'weekly' ? 'Weekly averages are Monday-Sunday.' : rangeLabel}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[860px]">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 text-[10px] uppercase tracking-wide">
                      <th className="px-3 py-2 text-left font-semibold sticky left-0 bg-gray-50">Period</th>
                      <th className="px-2 py-2 text-right font-semibold">Weight</th>
                      <th className="px-2 py-2 text-right font-semibold">Calories</th>
                      <th className="px-2 py-2 text-right font-semibold">Protein</th>
                      <th className="px-2 py-2 text-right font-semibold">Fats</th>
                      <th className="px-2 py-2 text-right font-semibold">Fiber</th>
                      <th className="px-2 py-2 text-right font-semibold">Sodium</th>
                      <th className="px-2 py-2 text-right font-semibold">Sugar</th>
                      <th className="px-2 py-2 text-left font-semibold">Goals</th>
                      <th className="px-2 py-2 text-right font-semibold">Steps</th>
                      <th className="px-2 py-2 text-right font-semibold">Sleep</th>
                      <th className="px-2 py-2 text-right font-semibold">Water</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {rows.map((r, i) => {
                      const gt = goalTag(goalCalories, goalProtein, goalCarbs, goalFat)
                      const isDaily = range === 'daily' || range === 'custom'
                      return (
                        <tr
                          key={i}
                          onClick={isDaily ? () => setFoodLogDate(r.date) : undefined}
                          className={`${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'} ${isDaily ? 'cursor-pointer hover:bg-orange-50/60 transition-colors' : ''}`}
                        >
                          <td className="px-3 py-2 text-gray-700 font-medium whitespace-nowrap sticky left-0 bg-inherit">
                            {isDaily
                              ? <span className="text-[#E8670A] hover:underline">{r.period}</span>
                              : r.period}
                          </td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums whitespace-nowrap align-top">
                            {r.weight ? `${r.weight} lbs` : '—'}
                            {r.weight_note && (
                              <p className="text-[10px] text-gray-400 italic truncate" title={r.weight_note}>
                                {truncateNote(r.weight_note)}
                              </p>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums font-medium">{r.calories  ? Number(r.calories).toLocaleString()          : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.protein   ? `${r.protein}g`                                         : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.fat       ? `${r.fat}g`                                             : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.fiber     ? `${r.fiber}g`                                           : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.sodium_mg ? `${Number(r.sodium_mg).toLocaleString()}mg`             : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.sugar     ? `${r.sugar}g`                                           : '—'}</td>
                          <td className="px-2 py-2 text-left text-[10px] text-gray-400 whitespace-nowrap">{gt ?? '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.steps      ? Number(r.steps).toLocaleString()                      : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums whitespace-nowrap align-top">
                            {r.sleep_minutes != null ? fmtSleep(r.sleep_minutes) : '—'}
                            {r.sleep_note && (
                              <p className="text-[10px] text-gray-400 italic truncate" title={r.sleep_note}>
                                {truncateNote(r.sleep_note)}
                              </p>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums whitespace-nowrap align-top">
                            {r.water_oz ? `${r.water_oz} oz` : '—'}
                            {r.water_note && (
                              <p className="text-[10px] text-gray-400 italic truncate" title={r.water_note}>
                                {truncateNote(r.water_note)}
                              </p>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <SummaryCard
              label="Weight change"
              value={wc != null ? `${wc > 0 ? '+' : ''}${wc} lbs` : '—'}
              sub={rangeLabel}
              color={wtColor}
            />
            <SummaryCard
              label="Avg calories"
              value={s.avg_calories ? `${Number(s.avg_calories).toLocaleString()} kcal` : '—'}
              sub={`${s.logged_day_count ?? 0} logged day${s.logged_day_count !== 1 ? 's' : ''}`}
            />
            <SummaryCard
              label="Avg steps"
              value={s.avg_steps ? Number(s.avg_steps).toLocaleString() : '—'}
              sub="per day with data"
            />
            <SummaryCard
              label="Avg sleep"
              value={fmtSleep(s.avg_sleep_minutes)}
              sub="per night with data"
            />
          </div>

          {/* Charts — no Movement per Period */}
          <div className="grid sm:grid-cols-2 gap-4">
            <ChartCard title="Weight (lbs)" series={wt} valueKey="value" fmtVal={v => `${v} lbs`} />
            <ChartCard
              title="Calories & Protein"
              legend={<><span style={{ color: '#E8670A' }}>— Cal</span><span style={{ color: '#10b981' }}>- - Prot</span></>}
              series={mac} valueKey="calories"
              series2={mac} valueKey2="protein" color2="#10b981"
            />
            <ChartCard title="Daily Steps" series={stp} valueKey="value" fmtVal={v => Number(v).toLocaleString()} />
            <ChartCard title="Sleep (hrs)" series={slpHrs} valueKey="value" color="#6366f1" fmtVal={v => `${v}h`} />
          </div>

          {/* Measurements */}
          <MeasurementsSection clientId={clientId} getToken={getToken} startDate={effectiveStart} endDate={effectiveEnd} />

          {/* Progress photos — grouped by session */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-900">Progress Photos</p>
              {photoSessions.length >= 2 && (
                <button
                  onClick={() => setShowCompare(s => !s)}
                  className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors">
                  {showCompare ? 'Show All' : 'Compare Sessions'}
                </button>
              )}
            </div>

            {/* ── Compare mode ── */}
            {showCompare && photoSessions.length >= 2 && (() => {
              const fmtDate = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              const sessionA = photoSessions[Math.min(sessionAIdx, photoSessions.length - 1)]
              const sessionB = photoSessions[Math.min(sessionBIdx, photoSessions.length - 1)]
              return (
                <div className="space-y-4">
                  {/* Selectors */}
                  <div className="grid grid-cols-2 gap-3">
                    {[['A', sessionAIdx, setSessionAIdx], ['B', sessionBIdx, setSessionBIdx]].map(([label, idx, setIdx]) => (
                      <div key={label}>
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Session {label}</p>
                        <select
                          value={idx}
                          onChange={e => setIdx(Number(e.target.value))}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                          {photoSessions.map((s, i) => (
                            <option key={i} value={i}>{fmtDate(s.session_date)}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                  {/* Side-by-side comparison */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {['front', 'side', 'back'].map(angle => {
                      const pA = sessionA?.photos?.[angle]
                      const pB = sessionB?.photos?.[angle]
                      return (
                        <div key={angle}>
                          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider text-center mb-2 capitalize">{angle}</p>
                          <div className="grid grid-cols-2 gap-1.5">
                            {[pA, pB].map((p, pi) => (
                              <div key={pi} className="relative">
                                <p className="text-[8px] font-semibold text-center text-gray-400 mb-0.5">{pi === 0 ? 'A' : 'B'}</p>
                                {p ? (
                                  <a href={p.photo_url} target="_blank" rel="noopener noreferrer"
                                    className="block rounded-lg overflow-hidden bg-gray-50 border border-gray-100 hover:opacity-85 transition-opacity">
                                    <div className="h-36 flex items-center justify-center">
                                      <img src={p.photo_url} alt={`${angle} ${pi === 0 ? 'A' : 'B'}`}
                                        className="w-full h-full object-contain" />
                                    </div>
                                  </a>
                                ) : (
                                  <div className="h-36 rounded-lg bg-gray-50 border border-dashed border-gray-200 flex items-center justify-center">
                                    <span className="text-[9px] text-gray-300">—</span>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <p className="text-[10px] text-gray-400 italic">Click a photo to open full size.</p>
                </div>
              )
            })()}

            {photoSessions.length === 0 ? (
              <p className="text-xs text-gray-400 bg-gray-50 border border-dashed border-gray-200 rounded-lg px-3 py-2">
                No progress photos yet.
              </p>
            ) : !showCompare && (
              <div className="space-y-5">
                {photoSessions.map((session, si) => {
                  const photoCount = ['front', 'side', 'back'].filter(a => session.photos[a]).length
                  const dateStr    = new Date(session.session_date).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })
                  return (
                    <div key={session.session_id ?? si}>
                      {/* Session header */}
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold text-gray-700">{dateStr}</span>
                        <span className="text-[10px] text-gray-400 ml-auto">{photoCount}/3</span>
                      </div>
                      {/* 3-column photo grid — compact on desktop */}
                      <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:max-w-3xl">
                        {['front', 'side', 'back'].map(angle => {
                          const p = session.photos[angle]
                          return (
                            <div key={angle} className="text-center">
                              <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1 capitalize">{angle}</p>
                              {p ? (
                                <>
                                  <a
                                    href={p.photo_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block rounded-lg overflow-hidden bg-gray-50 border border-gray-100 hover:opacity-85 transition-opacity"
                                  >
                                    {/* Compact on desktop, full image visible */}
                                    <div className="h-40 sm:h-36 lg:h-32 xl:h-28 flex items-center justify-center">
                                      <img
                                        src={p.photo_url}
                                        alt={angle}
                                        className="w-full h-full object-contain"
                                      />
                                    </div>
                                  </a>
                                  {role === 'admin' && (
                                    <button
                                      type="button"
                                      onClick={() => deleteProgressPhoto(p.id)}
                                      className="mt-1 min-h-8 w-full rounded-lg border border-red-100 text-[10px] font-semibold text-red-600"
                                    >
                                      Delete
                                    </button>
                                  )}
                                </>
                              ) : (
                                <div className="h-40 sm:h-36 lg:h-32 xl:h-28 rounded-lg bg-gray-50 border border-dashed border-gray-200 flex items-center justify-center">
                                  <span className="text-[9px] text-gray-300">—</span>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      {/* Divider between sets */}
                      {si < photoSessions.length - 1 && (
                        <div className="mt-4 border-t border-gray-100" />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Food Log Modal — opens when a daily row is clicked */}
      {foodLogDate && (
        <FoodLogModal
          clientId={clientId}
          clientName={clientName}
          date={foodLogDate}
          getToken={getToken}
          goals={{ goal_calories: goalCalories, goal_protein: goalProtein, goal_carbs: goalCarbs, goal_fat: goalFat }}
          onClose={() => setFoodLogDate(null)}
          onDateChange={setFoodLogDate}
        />
      )}
    </div>
  )
}

// ─── Assessment Tab ───────────────────────────────────────────────────────────

// Small "Scheduled" indicator showing pending/scheduled/recurring form deliveries
// for this client, with next-send time. Renders nothing while loading or empty.
function ScheduledFormsStatus({ clientId, getToken }) {
  const [items,   setItems]   = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/form-schedules?client_id=${clientId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok && !cancelled) {
          const rows = await res.json()
          setItems(rows.filter(r => ['pending', 'active', 'paused'].includes(r.status)))
        }
      } catch {} finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [clientId, getToken])

  if (loading || items.length === 0) return null

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <h3 className="text-xs font-bold text-[#E8670A] uppercase tracking-wider mb-2">Scheduled</h3>
      <div className="space-y-1.5">
        {items.map(it => (
          <div key={it.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-gray-700 truncate">{it.form_title}</span>
            <span className="flex items-center gap-1.5 shrink-0">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                it.assignment_type === 'recurring'
                  ? (it.status === 'paused' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-blue-50 text-blue-700 border-blue-200')
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
              }`}>
                {it.assignment_type === 'recurring' ? (it.status === 'paused' ? 'Recurring · Paused' : 'Recurring') : 'Scheduled'}
              </span>
              <span className="text-gray-400">
                {it.next_send_at ? `Next ${fmtDateTime(it.next_send_at)}` : '—'}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Compact form-send control for the Assessment tab
function FormSendSection({ clientId, getToken }) {
  const [templates, setTemplates] = useState([])
  const [tplLoading, setTplLoading] = useState(true)
  const [selectedId, setSelectedId] = useState('')
  const [sendMode, setSendMode] = useState('now')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null) // { ok: bool, msg: string }
  const [schedDate, setSchedDate] = useState('')
  const [schedTime, setSchedTime] = useState('09:00')
  const [recurDay, setRecurDay] = useState(1)
  const [recurTime, setRecurTime] = useState('09:00')
  const [recurEndDate, setRecurEndDate] = useState('')

  const dayLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const todayLocal = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()

  function timezonePayload(selectedLocalTime) {
    return {
      selected_local_time: selectedLocalTime,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezone_offset_minutes: new Date().getTimezoneOffset(),
    }
  }

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/forms`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const all = await res.json()
          const published = all.filter(f => f.status === 'published')
          setTemplates(published)
          if (published.length > 0) setSelectedId(String(published[0].id))
        }
      } finally { setTplLoading(false) }
    }
    load()
  }, [getToken])

  async function sendForm() {
    if (!selectedId) return
    setSending(true); setResult(null)
    try {
      const token = await getToken()
      let res
      if (sendMode === 'now') {
        res = await fetch(`${API_URL}/api/coach-admin/forms/${selectedId}/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_ids: [clientId] }),
        })
      } else if (sendMode === 'scheduled') {
        if (!schedDate || !schedTime) throw new Error('Please pick a date and time.')
        res = await fetch(`${API_URL}/api/coach-admin/forms/${selectedId}/schedule`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_ids: [clientId],
            send_mode: 'scheduled',
            send_at: new Date(`${schedDate}T${schedTime}:00`).toISOString(),
            ...timezonePayload(`${schedDate} ${schedTime}`),
          }),
        })
      } else {
        res = await fetch(`${API_URL}/api/coach-admin/forms/${selectedId}/schedule`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_ids: [clientId],
            send_mode: 'recurring',
            recurring_rule: {
              day_of_week: recurDay,
              hour: parseInt(recurTime.split(':')[0], 10),
              minute: parseInt(recurTime.split(':')[1], 10),
              end_date: recurEndDate || null,
            },
            ...timezonePayload(`${dayLabels[recurDay]} ${recurTime}`),
          }),
        })
      }
      const data = await res.json()
      if (res.ok) {
        if (sendMode === 'now' && (data.sent ?? 1) === 0) {
          const reason = data.skipped_list?.[0]?.reason ?? 'Form could not be delivered to this client.'
          setResult({ ok: false, msg: reason })
        } else {
          const msg = sendMode === 'now'
            ? `Form sent to ${data.sent ?? 1} client(s).`
            : sendMode === 'scheduled'
              ? 'Form scheduled successfully.'
              : 'Recurring form scheduled successfully.'
          setResult({ ok: true, msg })
        }
      }
      else setResult({ ok: false, msg: data.error ?? 'Failed to send form.' })
    } catch (err) { setResult({ ok: false, msg: err.message || 'Failed to send form.' }) }
    finally { setSending(false) }
  }

  if (tplLoading) return null
  if (templates.length === 0) return null

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider mb-3">Send Form</p>
      <div className="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1">
        {[
          ['now', 'Send Now'],
          ['scheduled', 'Schedule'],
          ['recurring', 'Recurring'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => { setSendMode(value); setResult(null) }}
            className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors ${
              sendMode === value ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[160px]">
          <label className="block text-xs font-medium text-gray-600 mb-1">Form template</label>
          <select
            value={selectedId}
            onChange={e => { setSelectedId(e.target.value); setResult(null) }}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </div>
        <button
          onClick={sendForm}
          disabled={sending || !selectedId}
          className="bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 min-h-[40px]">
          {sending ? 'Working…' : sendMode === 'now' ? 'Send Now' : sendMode === 'scheduled' ? 'Schedule' : 'Set Recurring'}
        </button>
      </div>
      {sendMode === 'scheduled' && (
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
            <input type="date" value={schedDate} min={todayLocal} onChange={e => setSchedDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Time</label>
            <input type="time" value={schedTime} onChange={e => setSchedTime(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
        </div>
      )}
      {sendMode === 'recurring' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Day</label>
            <select value={recurDay} onChange={e => setRecurDay(parseInt(e.target.value, 10))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
              {dayLabels.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Time</label>
            <input type="time" value={recurTime} onChange={e => setRecurTime(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">End Date (optional)</label>
            <input type="date" value={recurEndDate} min={todayLocal} onChange={e => setRecurEndDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
        </div>
      )}
      {result && (
        <p className={`text-xs mt-2 ${result.ok ? 'text-emerald-600' : 'text-red-500'}`}>{result.msg}</p>
      )}
    </div>
  )
}

// ─── Form Submissions section (inside Forms tab) ──────────────────────────────

function renderAnswer(field, val) {
  if (val === undefined || val === null || val === '') return <span className="text-gray-400">—</span>
  if (field.type === 'rating') {
    return (
      <span className="inline-flex gap-0.5">
        {[1,2,3,4,5].map(n => (
          <span key={n} className={`w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center ${
            n <= val ? 'bg-[#E8670A] text-white' : 'bg-gray-100 text-gray-300'
          }`}>{n}</span>
        ))}
      </span>
    )
  }
  if (field.type === 'multi_choice' && Array.isArray(val)) return <span>{val.join(', ')}</span>
  return <span>{String(val)}</span>
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function notePreview(note) {
  const text = String(note ?? '').trim()
  if (!text) return '—'
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

function ReviewedBadge({ sub }) {
  if (sub.completed_at) {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className="inline-flex items-center rounded-full bg-purple-50 border border-purple-200 px-2 py-0.5 text-[10px] font-bold text-purple-700 uppercase tracking-wide">
          Complete
        </span>
        {sub.reviewed_by_name && (
          <span className="text-[10px] text-gray-400">
            Reviewed by {sub.reviewed_by_name} · {new Date(sub.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </span>
    )
  }
  if (sub.reviewed_at) {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className="inline-flex items-center rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-bold text-emerald-700 uppercase tracking-wide">
          Reviewed
        </span>
        {sub.reviewed_by_name && (
          <span className="text-[10px] text-gray-400">
            by {sub.reviewed_by_name} · {new Date(sub.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-700 uppercase tracking-wide">
      Not Reviewed
    </span>
  )
}

function isCheckInSubmission(sub) {
  const t = (sub.form_title ?? '').toLowerCase()
  return t.includes('check-in') || t.includes('check in')
}

function FormSubmissionsSection({ clientId, getToken }) {
  const [submissions, setSubmissions] = useState(undefined)
  const [loading,     setLoading]     = useState(true)
  const [openId,      setOpenId]      = useState(null)
  const [reviewing,   setReviewing]   = useState(null)
  const [completing,  setCompleting]  = useState(null)
  const [savingNote,  setSavingNote]  = useState(null)
  const [noteDrafts,  setNoteDrafts]  = useState({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/form-submissions`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!cancelled) setSubmissions(res.ok ? await res.json() : [])
      } catch { if (!cancelled) setSubmissions([]) }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [clientId, getToken])

  function handleView(sub) {
    if (openId === sub.id) { setOpenId(null); return }
    setOpenId(sub.id)
    if (noteDrafts[sub.id] === undefined) {
      setNoteDrafts(prev => ({ ...prev, [sub.id]: sub.coach_note ?? '' }))
    }
  }

  async function handleMarkReviewed(sub) {
    if (reviewing === sub.id) return
    setReviewing(sub.id)
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/coach-admin/form-submissions/${sub.id}/mark-reviewed`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } },
      )
      if (res.ok) {
        const data = await res.json()
        setSubmissions(prev => prev.map(s =>
          s.id === sub.id
            ? { ...s, reviewed_at: data.reviewed_at, reviewed_by: data.reviewed_by, reviewed_by_name: data.reviewed_by_name }
            : s
        ))
      }
    } catch {}
    finally { setReviewing(null) }
  }

  async function handleMarkComplete(sub) {
    if (completing === sub.id) return
    setCompleting(sub.id)
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/coach-admin/form-submissions/${sub.id}/mark-complete`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } },
      )
      if (res.ok) {
        const data = await res.json()
        setSubmissions(prev => prev.map(s =>
          s.id === sub.id
            ? { ...s, completed_at: data.completed_at, completed_by: data.completed_by, completed_by_name: data.completed_by_name }
            : s
        ))
      }
    } catch {}
    finally { setCompleting(null) }
  }

  async function handleSaveNote(sub) {
    if (savingNote === sub.id) return
    const note = noteDrafts[sub.id] ?? ''
    setSavingNote(sub.id)
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/coach-admin/form-submissions/${sub.id}/note`,
        {
          method:  'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ note }),
        },
      )
      if (res.ok) {
        const data = await res.json()
        const savedNote = data.coach_note ?? null
        setSubmissions(prev => prev.map(s =>
          s.id === sub.id ? { ...s, coach_note: savedNote } : s
        ))
        setNoteDrafts(prev => ({ ...prev, [sub.id]: savedNote ?? '' }))
      }
    } catch {}
    finally { setSavingNote(null) }
  }

  // Inline render — avoids nested-component identity issues that cause React to
  // remount on every parent render, breaking controlled inputs.
  function renderExpanded(sub) {
    const schema  = Array.isArray(sub.version_schema) ? sub.version_schema : []
    const draft   = noteDrafts[sub.id] ?? sub.coach_note ?? ''
    const isDirty = draft !== (sub.coach_note ?? '')

    return (
      <div className="space-y-4">
        {schema.length === 0 ? (
          <p className="text-xs text-gray-400">No schema available.</p>
        ) : (
          <div className="space-y-3">
            {schema.map(field => (
              <div key={field.id}>
                <p className="text-[10px] uppercase tracking-wider text-gray-400 font-bold mb-0.5">{field.label}</p>
                <p className="text-sm text-gray-800">{renderAnswer(field, sub.answers?.[field.id])}</p>
              </div>
            ))}
          </div>
        )}

        <div className="pt-3 border-t border-gray-200">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 font-bold mb-1">Staff Note</p>
          <textarea
            rows={2}
            value={draft}
            onChange={e => setNoteDrafts(prev => ({ ...prev, [sub.id]: e.target.value }))}
            placeholder="Add a note about this submission…"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
          <button
            onClick={() => handleSaveNote(sub)}
            disabled={savingNote === sub.id || !isDirty}
            className="mt-1.5 min-h-11 md:min-h-0 text-xs bg-[#E8670A] text-white font-bold px-3 py-1.5 rounded-lg hover:bg-[#c45e09] disabled:opacity-50"
          >
            {savingNote === sub.id ? 'Saving…' : 'Save Note'}
          </button>
        </div>

        <div className="pt-2 border-t border-gray-200 space-y-2">
          {sub.completed_at ? (
            <div className="space-y-0.5">
              <p className="text-xs text-emerald-700 font-semibold">
                Reviewed{sub.reviewed_by_name ? ` by ${sub.reviewed_by_name}` : ''} · {new Date(sub.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
              <p className="text-xs text-purple-700 font-semibold">
                Complete{sub.completed_by_name ? ` · ${sub.completed_by_name}` : ''} · {new Date(sub.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
          ) : sub.reviewed_at ? (
            <div className="flex items-center justify-between">
              <p className="text-xs text-emerald-700 font-semibold">
                Reviewed{sub.reviewed_by_name ? ` by ${sub.reviewed_by_name}` : ''} · {new Date(sub.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
              <button
                onClick={() => handleMarkComplete(sub)}
                disabled={completing === sub.id}
                className="text-xs bg-purple-600 text-white font-bold px-4 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50"
              >
                {completing === sub.id ? 'Marking…' : 'Mark Complete'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => handleMarkReviewed(sub)}
              disabled={reviewing === sub.id}
              className="text-xs bg-emerald-600 text-white font-bold px-4 py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
            >
              {reviewing === sub.id ? 'Marking…' : 'Mark Reviewed'}
            </button>
          )}
        </div>
      </div>
    )
  }

  function renderList(subs, emptyMsg) {
    if (loading) return <p className="text-sm text-gray-400 py-2">Loading…</p>
    if (!subs || subs.length === 0) return (
      <div className="bg-gray-50 border border-gray-100 rounded-xl p-5 text-center">
        <p className="text-sm text-gray-500">{emptyMsg}</p>
      </div>
    )
    return (
      <>
        {/* Desktop table */}
        <div className="hidden md:block bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200 text-[10px] text-gray-500 uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Form</th>
                <th className="text-left px-4 py-2.5 font-semibold">Submitted</th>
                <th className="text-left px-4 py-2.5 font-semibold">Reviewed</th>
                <th className="text-left px-4 py-2.5 font-semibold">Notes</th>
                <th className="text-right px-4 py-2.5 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {subs.map(sub => {
                const isOpen = openId === sub.id
                return (
                  <Fragment key={sub.id}>
                    <tr className="border-t border-gray-100 hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm font-semibold text-gray-900 truncate max-w-[200px]">{sub.form_title}</p>
                        {sub.version_num && <p className="text-[10px] text-gray-400 mt-0.5">v{sub.version_num}</p>}
                        {sub.is_late && (
                          <span className="mt-1 inline-flex rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">
                            Late
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{fmtDateTime(sub.submitted_at)}</td>
                      <td className="px-4 py-3"><ReviewedBadge sub={sub} /></td>
                      <td className="px-4 py-3 text-xs text-gray-500 max-w-[140px]">
                        <span className="truncate block" title={sub.coach_note || ''}>{notePreview(sub.coach_note)}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleView(sub)}
                          className="text-xs text-[#E8670A] hover:text-[#c45e09] font-semibold"
                        >
                          {isOpen ? 'Close' : 'View'}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={5} className="px-4 pb-4 pt-2 bg-gray-50/60">
                          {renderExpanded(sub)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden space-y-3">
          {subs.map(sub => {
            const isOpen = openId === sub.id
            return (
              <div key={sub.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{sub.form_title}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{fmtDateTime(sub.submitted_at)}</p>
                      {sub.is_late && (
                        <span className="mt-1 inline-flex rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">
                          Late
                        </span>
                      )}
                    </div>
                    <ReviewedBadge sub={sub} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 truncate max-w-[60%]">
                      {notePreview(sub.coach_note)}
                    </span>
                    <button
                      onClick={() => handleView(sub)}
                      className="text-xs text-[#E8670A] hover:text-[#c45e09] font-semibold ml-2"
                    >
                      {isOpen ? 'Close' : 'View'}
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50">
                    {renderExpanded(sub)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </>
    )
  }

  const checkIns            = submissions?.filter(isCheckInSubmission) ?? []
  const otherForms          = submissions?.filter(s => !isCheckInSubmission(s)) ?? []
  const unreviewedCheckIns  = checkIns.filter(s => !s.reviewed_at)
  const unreviewedOtherForms = otherForms.filter(s => !s.reviewed_at)

  return (
    <div className="space-y-6">
      {/* Check-Ins section */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider">Check-Ins</p>
          {!loading && unreviewedCheckIns.length > 0 && (
            <span className="text-[10px] bg-orange-100 text-[#E8670A] font-bold px-1.5 py-0.5 rounded-full">
              {unreviewedCheckIns.length} unreviewed
            </span>
          )}
        </div>
        {renderList(checkIns, 'No check-ins submitted yet.')}
      </div>

      {/* Other Forms — only shown when there are non-check-in submissions */}
      {!loading && otherForms.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider">Other Forms</p>
            {unreviewedOtherForms.length > 0 && (
              <span className="text-[10px] bg-orange-100 text-[#E8670A] font-bold px-1.5 py-0.5 rounded-full">
                {unreviewedOtherForms.length} unreviewed
              </span>
            )}
          </div>
          {renderList(otherForms, 'No other form submissions.')}
        </div>
      )}
    </div>
  )
}

// ─── Assessment tab ────────────────────────────────────────────────────────────

function AssessmentTab({ clientId, getToken }) {
  const [data, setData] = useState(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/assessment`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setData(await res.json())
        else setData(null)
      } finally { setLoading(false) }
    }
    load()
  }, [clientId, getToken])

  function Field({ label, value, full = false }) {
    if (!value && value !== 0) return null
    return (
      <div className={full ? 'sm:col-span-2' : ''}>
        <p className="text-[10px] uppercase tracking-wider text-gray-400 font-bold mb-0.5">{label}</p>
        <p className="text-sm text-gray-800 whitespace-pre-wrap">{value}</p>
      </div>
    )
  }

  function Rating({ value }) {
    if (!value) return <span className="text-gray-400">—</span>
    return (
      <span className="inline-flex gap-0.5">
        {[1,2,3,4,5].map(n => (
          <span key={n} className={`w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center ${
            n <= value ? 'bg-[#E8670A] text-white' : 'bg-gray-100 text-gray-300'
          }`}>{n}</span>
        ))}
      </span>
    )
  }

  return (
    <div className="space-y-6">

      {/* ── Scheduled form deliveries ── */}
      <ScheduledFormsStatus clientId={clientId} getToken={getToken} />

      {/* ── Send a form to this client ── */}
      <FormSendSection clientId={clientId} getToken={getToken} />

      {/* ── Form Submissions: Check-Ins + Other Forms ── */}
      <FormSubmissionsSection clientId={clientId} getToken={getToken} />

      {/* ── Health Assessment / Intake Form ── */}
      <div>
        <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider mb-3">Health Assessment</p>

        {loading ? (
          <p className="text-sm text-gray-400 py-3">Loading assessment…</p>
        ) : !data ? (
          <div className="bg-gray-50 border border-gray-100 rounded-xl p-6 text-center">
            <p className="text-sm text-gray-500">No intake form submitted yet.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {data.completed_at && (
              <p className="text-xs text-gray-400">
                Completed {fmtDate(data.completed_at)}
                {data.updated_at && ` · Last updated ${fmtDate(data.updated_at)}`}
              </p>
            )}

            {/* Life Warrior identity */}
            {Array.isArray(data.identity_traits) && data.identity_traits.length > 0 && (
              <div className="bg-gradient-to-br from-[#1e2a3a] to-[#243347] rounded-xl p-5 text-white">
                <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider mb-2">Life Warrior Identity</p>
                <div className="space-y-1.5">
                  {data.identity_traits.map((trait, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="text-[#E8670A] mt-0.5">✓</span>
                      <p className="text-sm font-medium text-white/95">{trait}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Goals & limitations */}
            <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
              <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider">Goals &amp; Health</p>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="6-month goals" value={data.goals_6_months} full />
                <Field label="Injuries / limitations" value={data.injuries_limitations} full />
                <Field label="Supplements" value={data.supplements} full />
                <Field label="Occupation" value={data.occupation} />
                <Field label="Kids" value={data.num_kids != null ? String(data.num_kids) : null} />
                <Field label="Shirt size" value={data.shirt_size} />
                <Field label="Activity level" value={data.activity_level} />
              </div>
            </div>

            {/* Ratings */}
            <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
              <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider">Energy &amp; Lifestyle</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between"><span className="text-xs text-gray-500">Energy</span><Rating value={data.energy_level} /></div>
                <div className="flex items-center justify-between"><span className="text-xs text-gray-500">Sleep quality</span><Rating value={data.sleep_quality} /></div>
                <div className="flex items-center justify-between"><span className="text-xs text-gray-500">Stress mgmt</span><Rating value={data.stress_management} /></div>
                <div className="flex items-center justify-between"><span className="text-xs text-gray-500">Happiness</span><Rating value={data.happiness_level} /></div>
                <div className="flex items-center justify-between"><span className="text-xs text-gray-500">Confidence</span><Rating value={data.confidence_level} /></div>
              </div>
              <div className="grid sm:grid-cols-3 gap-3 pt-2 border-t border-gray-100">
                <Field label="Sleep hours" value={data.sleep_hours} />
                <Field label="Daily water" value={data.daily_water} />
                <Field label="Drinks weekday" value={data.alcohol_weekdays != null ? `${data.alcohol_weekdays}/day` : null} />
                <Field label="Drinks weekend" value={data.alcohol_weekends != null ? `${data.alcohol_weekends}/day` : null} />
              </div>
            </div>

            {/* Contact */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider mb-3">Contact</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Phone" value={data.phone} />
                <Field label="Date of birth" value={fmtDob(data.date_of_birth)} />
                <Field label="Coach name" value={data.coach_name} />
                {(data.street_address || data.city) && (
                  <div className="sm:col-span-2">
                    <p className="text-[10px] uppercase tracking-wider text-gray-400 font-bold mb-0.5">Address</p>
                    <p className="text-sm text-gray-800">
                      {data.street_address && <>{data.street_address}<br /></>}
                      {[data.city, data.state].filter(Boolean).join(', ')}{data.zip_code ? ` ${data.zip_code}` : ''}
                      {data.country && data.country !== 'United States' && <><br />{data.country}</>}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Notes Tab ────────────────────────────────────────────────────────────────

function NotesTab({ clientId, role, getToken }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [body, setBody] = useState('')
  const [visibility, setVisibility] = useState('shared_staff')
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editBody, setEditBody] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  const load = useCallback(async () => {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/notes`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setNotes(await res.json())
    setLoading(false)
  }, [clientId, getToken])

  useEffect(() => { load() }, [load])

  async function submit() {
    if (!body.trim()) return
    setSaving(true)
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note_body: body, visibility }),
    })
    setSaving(false)
    if (res.ok) {
      setBody('')
      load()
    }
  }

  async function deleteNote(id) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/notes/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setNotes(n => n.filter(x => x.id !== id))
  }

  async function saveEdit(id) {
    if (!editBody.trim()) return
    setEditSaving(true)
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/notes/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note_body: editBody }),
    })
    setEditSaving(false)
    if (res.ok) {
      const updated = await res.json()
      setNotes(prev => prev.map(n => n.id === id ? { ...n, note_body: updated.note_body } : n))
      setEditingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={3}
          placeholder="Add a note about this client…"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
          {role === 'admin' ? (
            <select value={visibility} onChange={e => setVisibility(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs bg-white">
              <option value="shared_staff">🔓 Shared with staff</option>
              <option value="admin_private">🔒 Admin private</option>
            </select>
          ) : (
            <span className="text-xs text-gray-400">🔓 Visible to staff</span>
          )}
          <button onClick={submit} disabled={saving || !body.trim()}
            className="bg-[#E8670A] text-white px-4 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-40">
            {saving ? 'Saving…' : 'Add Note'}
          </button>
        </div>
      </div>

      {loading && <p className="text-sm text-gray-400 text-center py-4">Loading…</p>}
      {!loading && notes.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-4">No notes yet.</p>
      )}

      <div className="space-y-2">
        {notes.map(n => (
          <div key={n.id} className={`border rounded-xl p-4 ${
            n.visibility === 'admin_private'
              ? 'bg-amber-50 border-amber-200'
              : 'bg-white border-gray-200'
          }`}>
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-gray-700">{n.author_name ?? 'Staff'}</span>
                <span className="text-[10px] text-gray-400">{new Date(n.created_at).toLocaleString()}</span>
                {n.visibility === 'admin_private' && (
                  <span className="text-[10px] font-bold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">🔒 Admin only</span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {editingId !== n.id && (
                  <button
                    onClick={() => { setEditingId(n.id); setEditBody(n.note_body) }}
                    className="text-[10px] text-gray-400 hover:text-[#E8670A]">
                    Edit
                  </button>
                )}
                <button onClick={() => deleteNote(n.id)} className="text-[10px] text-gray-400 hover:text-red-500">Delete</button>
              </div>
            </div>
            {editingId === n.id ? (
              <div className="space-y-2 mt-1">
                <textarea
                  value={editBody}
                  onChange={e => setEditBody(e.target.value)}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => saveEdit(n.id)}
                    disabled={editSaving || !editBody.trim()}
                    className="bg-[#E8670A] text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-40">
                    {editSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="text-xs text-gray-500 px-3 py-1.5 hover:text-gray-700">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{n.note_body}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Messaging Tab ────────────────────────────────────────────────────────────

function KatieHistoryPanel({ client, getToken }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading]   = useState(true)
  const clientName = client.display_first_name || client.first_name || 'Client'

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/coach-admin/clients/${client.id}/katie-history`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (res.ok && !cancelled) setMessages(await res.json())
      } catch {}
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [client.id, getToken])

  return (
    <div className="space-y-3">
      {/* Read-only banner */}
      <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2.5">
        <p className="text-xs text-purple-700">
          🤖 <strong>Katie conversation history — read only.</strong> These are the client's private AI coaching messages. Staff cannot reply here.
        </p>
      </div>

      {/* Message list */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 min-h-[300px] max-h-[560px] overflow-y-auto">
        {loading && <p className="text-center text-sm text-gray-400 py-8">Loading…</p>}
        {!loading && messages.length === 0 && (
          <p className="text-center text-sm text-gray-400 py-8">
            No Katie conversation history yet for this client.
          </p>
        )}
        <div className="space-y-3">
          {messages.map((m, i) => {
            const isKatie = m.role === 'assistant'
            return (
              <div key={i} className={`flex items-end gap-2 ${isKatie ? 'justify-start' : 'justify-end'}`}>
                {isKatie && (
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#E8670A] flex items-center justify-center text-white text-[10px] font-bold">
                    K
                  </div>
                )}
                <div className={`max-w-[78%] rounded-2xl px-4 py-2 ${
                  isKatie
                    ? 'bg-white border border-gray-200 text-gray-800'
                    : 'bg-[#1e2a3a] text-white'
                }`}>
                  <p className="text-[10px] font-semibold opacity-60 mb-0.5">
                    {isKatie ? 'Katie' : clientName} · {new Date(m.created_at).toLocaleString()}
                    {m.is_proactive && (
                      <span className="ml-2 bg-purple-100 text-purple-700 rounded px-1 py-0.5 text-[9px]">
                        proactive{m.proactive_trigger ? `: ${m.proactive_trigger}` : ''}
                      </span>
                    )}
                  </p>
                  <p className="text-sm whitespace-pre-wrap"><LinkifiedText text={m.message} /></p>
                </div>
                {!isKatie && (
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 text-[10px] font-bold">
                    {clientName[0]?.toUpperCase() ?? 'C'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function MessagingTab({ client, role, meId, getToken }) {
  const isAI = client.coaching_type === 'ai'

  const availableThreads = []
  if (isAI) {
    if (role === 'admin') availableThreads.push({ id: 'ai_admin', label: 'AI ↔ Admin', icon: '🤖' })
  } else {
    availableThreads.push({ id: 'coach_thread', label: 'Coach Thread', icon: '💬' })
    if (role === 'admin') availableThreads.push({ id: 'admin_private', label: 'Admin Private', icon: '🔒' })
  }
  // Katie Chat: available for all client types, admin + coaches (canAccessClient enforced on backend) — read-only
  availableThreads.push({ id: 'katie_history', label: 'Katie Chat', icon: '🤖' })

  // Default to a writable thread this role can actually send to — never Katie Chat (read-only),
  // and never a thread type this role has no write access to. Previously this defaulted AI-client
  // conversations straight to 'ai_admin' even for coaches, who can't write there and don't even see
  // it as a tab — landing them on a dead thread with no visible way to send a first message. Falls
  // back to Katie Chat only when that's genuinely the only thing available (nothing writable at all).
  const writableThreads = availableThreads.filter(t => t.id !== 'katie_history')
  const initialThread = (role === 'admin' && !isAI ? 'admin_private' : writableThreads[0]?.id) ?? 'katie_history'
  const [thread, setThread] = useState(initialThread)
  const [messages,     setMessages]     = useState([])
  const [hasMore,      setHasMore]      = useState(false)
  const [nextBeforeId, setNextBeforeId] = useState(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [menuMsgId, setMenuMsgId] = useState(null) // message id with delete affordance revealed (mobile long-press)
  const longPressTimer = useRef(null)

  const isKatieThread = thread === 'katie_history'

  const load = useCallback(async () => {
    if (isKatieThread) return  // handled by KatieHistoryPanel
    setLoading(true)
    setHasMore(false)
    setNextBeforeId(null)
    const token = await getToken()
    const res = await fetch(
      `${API_URL}/api/coach-admin/clients/${client.id}/messages?thread=${thread}&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (res.ok) {
      const data = await res.json()
      setMessages(data.messages ?? [])
      setHasMore(data.hasMore ?? false)
      setNextBeforeId(data.nextBeforeId ?? null)
    }
    setLoading(false)
  }, [client.id, thread, getToken, isKatieThread])

  const loadOlder = useCallback(async () => {
    if (!nextBeforeId || loadingOlder) return
    setLoadingOlder(true)
    try {
      const token = await getToken()
      const res = await fetch(
        `${API_URL}/api/coach-admin/clients/${client.id}/messages?thread=${thread}&limit=50&before_id=${nextBeforeId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (res.ok) {
        const data = await res.json()
        setMessages(prev => [...(data.messages ?? []), ...prev])
        setHasMore(data.hasMore ?? false)
        setNextBeforeId(data.nextBeforeId ?? null)
      }
    } finally { setLoadingOlder(false) }
  }, [client.id, thread, nextBeforeId, loadingOlder, getToken])

  useEffect(() => { if (!isKatieThread) load() }, [load, isKatieThread])

  async function send() {
    if (!body.trim()) return
    setSending(true)
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${client.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_body: body, thread_type: thread }),
    })
    setSending(false)
    if (res.ok) {
      const newMsg = await res.json()
      setMessages(m => [...m, newMsg])
      setBody('')
    }
  }

  // Delete own message (soft-delete on the server). Confirm first.
  async function deleteMessage(id) {
    if (!window.confirm('Delete this message?')) { setMenuMsgId(null); return }
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${client.id}/messages/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setMessages(prev => prev.filter(m => m.id !== id))
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.error ?? 'Could not delete message')
      }
    } catch { alert('Could not delete message') }
    finally { setMenuMsgId(null) }
  }

  function startLongPress(id) {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = setTimeout(() => setMenuMsgId(id), 500)
  }
  function cancelLongPress() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null }
  }

  return (
    <div className="space-y-3">
      {/* Thread selector */}
      <div className="flex gap-2 flex-wrap">
        {availableThreads.map(t => (
          <button key={t.id} onClick={() => setThread(t.id)}
            className={`px-3 py-2 rounded-lg text-xs font-semibold border-2 transition-colors ${
              thread === t.id
                ? 'bg-[#E8670A] border-[#E8670A] text-white'
                : 'border-gray-200 text-gray-600 hover:border-[#E8670A]'
            }`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Katie Chat — read-only panel rendered separately */}
      {isKatieThread ? (
        <KatieHistoryPanel client={client} getToken={getToken} />
      ) : (
        <>
          {/* Message list */}
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 min-h-[300px] max-h-[500px] overflow-y-auto">
            {hasMore && !loading && (
              <div className="text-center pb-2">
                <button
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  className="text-xs text-gray-500 hover:text-[#E8670A] disabled:opacity-40 underline"
                >
                  {loadingOlder ? 'Loading…' : 'Load older messages'}
                </button>
              </div>
            )}
            {loading && <p className="text-center text-sm text-gray-400 py-8">Loading…</p>}
            {!loading && messages.length === 0 && (
              <p className="text-center text-sm text-gray-400 py-8">
                No messages yet in this thread. Start the conversation below.
              </p>
            )}
            <div className="space-y-3">
              {messages.filter(m => !m.deleted_at).map(m => {
                const isStaff = m.sender_role === 'admin' || m.sender_role === 'coach'
                const isMine = meId != null && m.sender_id === meId
                return (
                  <div key={m.id} className={`flex ${isStaff ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className="group relative flex items-end gap-1 max-w-[80%]"
                      onTouchStart={isMine ? () => startLongPress(m.id) : undefined}
                      onTouchEnd={isMine ? cancelLongPress : undefined}
                      onTouchMove={isMine ? cancelLongPress : undefined}
                      onContextMenu={isMine ? e => { e.preventDefault(); setMenuMsgId(m.id) } : undefined}
                    >
                      {isMine && (
                        <button
                          type="button"
                          onClick={() => deleteMessage(m.id)}
                          aria-label="Delete message"
                          title="Delete message"
                          className={`shrink-0 flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 transition-opacity ${
                            menuMsgId === m.id
                              ? 'opacity-100 pointer-events-auto'
                              : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
                          }`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                      <div className={`min-w-0 rounded-2xl px-4 py-2 ${
                        isStaff
                          ? 'bg-[#E8670A] text-white'
                          : 'bg-white border border-gray-200 text-gray-800'
                      }`}>
                        <p className="text-[10px] font-semibold opacity-70 mb-0.5">
                          {m.sender_name ?? m.sender_role} · {new Date(m.created_at).toLocaleString()}
                        </p>
                        <p className="text-sm whitespace-pre-wrap"><LinkifiedText text={m.message_body} /></p>
                        {isStaff && m.read_at && (
                          <p className="text-[9px] opacity-60 text-right mt-0.5">
                            Read {new Date(m.read_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Compose — read-only for admins on the coach thread */}
          {role === 'admin' && thread === 'coach_thread' ? (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5">
              <p className="text-xs text-blue-700">
                👁 Viewing coach–client thread (read-only). Switch to <strong>Admin Private</strong> to send your own message.
              </p>
            </div>
          ) : (
            <div className="flex gap-2">
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={2}
                placeholder={`Message ${client.display_first_name || client.first_name || 'client'}…`}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
              />
              <button onClick={send} disabled={sending || !body.trim()}
                className="bg-[#E8670A] text-white px-5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 self-stretch">
                {sending ? '…' : 'Send'}
              </button>
            </div>
          )}

          {thread === 'admin_private' && (
            <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
              🔒 This thread is admin-only. Coaches cannot see these messages.
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ─── Identity Momentum Snapshot (admin) ──────────────────────────────────────

function IdentityMomentumSnapshot({ clientId, getToken }) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/coach-admin/clients/${clientId}/identity-momentum`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (res.ok) setData(await res.json())
      } catch {}
      setLoading(false)
    }
    load()
  }, [clientId, getToken])

  if (loading) return (
    <div className="animate-pulse space-y-2 mb-6">
      <div className="h-3 bg-gray-100 rounded w-32" />
      <div className="h-16 bg-gray-100 rounded-xl" />
    </div>
  )
  if (!data) return null

  const STAGE_COLORS = {
    'Starting Strong':     'bg-sky-50 text-sky-700 border-sky-100',
    'Momentum Builder':    'bg-violet-50 text-violet-700 border-violet-100',
    'Self-Trust Builder':  'bg-blue-50 text-blue-700 border-blue-100',
    'Consistency Warrior': 'bg-emerald-50 text-emerald-700 border-emerald-100',
    'Resilient Warrior':   'bg-amber-50 text-amber-700 border-amber-100',
    'Life Warrior':        'bg-orange-50 text-orange-700 border-orange-100',
  }
  const stageColor = STAGE_COLORS[data.identity_stage] ?? 'bg-gray-50 text-gray-700 border-gray-100'

  return (
    <div className="mb-6">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Identity Momentum</h3>
      <div className={`border rounded-xl p-4 ${stageColor}`}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-sm font-bold">{data.identity_stage}</p>
            <p className="text-xs opacity-75 mt-0.5">{data.stage_description}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs font-semibold">{data.active_count}/5 pillars</p>
            <p className="text-[10px] opacity-60">{data.active_weeks} active weeks</p>
          </div>
        </div>

        {/* This week's pillars */}
        <div className="flex flex-wrap gap-1.5 mb-2">
          {data.categories.map(c => (
            <span
              key={c.key}
              className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${
                c.active ? 'bg-white/60 border-current' : 'bg-black/5 border-transparent opacity-40'
              }`}
            >
              {c.label}
            </span>
          ))}
        </div>

        {/* Weakest category */}
        {data.weakest_category && (
          <p className="text-[10px] opacity-60">
            Opportunity area: <span className="font-semibold">{data.weakest_category}</span>
          </p>
        )}

        {/* Comeback note */}
        {data.is_comeback && data.comeback_message && (
          <div className="mt-2 pt-2 border-t border-current/20">
            <p className="text-xs font-semibold">{data.comeback_message}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Mindset Watch Section ────────────────────────────────────────────────────

function MindsetWatchSection({ clientId, getToken }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/mindset-progress`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!cancelled && res.ok) setData(await res.json())
      } catch {} finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [clientId, getToken])

  function videoStatus(v) {
    if (v.completed)         return { label: 'Completed',   cls: 'bg-emerald-100 text-emerald-700' }
    if (v.highest_pct >= 50) return { label: '50% watched', cls: 'bg-blue-100 text-blue-700' }
    if (v.started)           return { label: 'Started',     cls: 'bg-amber-100 text-amber-700' }
    return                          { label: 'Not started',  cls: 'bg-gray-100 text-gray-500' }
  }

  if (loading) return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs text-gray-400">Loading mindset watch data…</p>
    </div>
  )

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-900">🧠 Mindset Watch</p>
        <span className="text-[10px] text-gray-400">Only in-app Mindset videos are tracked.</span>
      </div>

      {!data ? (
        <p className="text-xs text-gray-400 bg-gray-50 border border-dashed border-gray-200 rounded-lg px-3 py-2">
          No in-app Mindset video progress yet.
        </p>
      ) : (
        <>
          {/* This week */}
          <div>
            <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider mb-2">This Week</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: 'Watched 50%+',  value: data.thisWeek.watched50Count },
                { label: 'Completed',     value: data.thisWeek.completedCount },
                { label: 'Best progress', value: data.thisWeek.bestProgress != null ? `${Math.round(data.thisWeek.bestProgress)}%` : '—' },
                { label: 'Last watched',  value: data.thisWeek.lastWatchedAt ? fmtDate(data.thisWeek.lastWatchedAt) : '—' },
              ].map(({ label, value }) => (
                <div key={label} className="bg-gray-50 rounded-lg p-3">
                  <p className="text-[11px] text-gray-400 mb-0.5">{label}</p>
                  <p className="text-sm font-bold text-gray-900">{value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* All-time totals */}
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">All-time (in-app)</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Watched 50%+', value: data.totals.watched50Count },
                { label: 'Completed',    value: data.totals.completedCount },
              ].map(({ label, value }) => (
                <div key={label} className="bg-gray-50 rounded-lg p-3">
                  <p className="text-[11px] text-gray-400 mb-0.5">{label}</p>
                  <p className="text-sm font-bold text-gray-900">{value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Recent videos */}
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Recent videos</p>
            {data.recentVideos.length === 0 ? (
              <p className="text-xs text-gray-400 bg-gray-50 border border-dashed border-gray-200 rounded-lg px-3 py-2">
                No published in-app Mindset videos yet.
              </p>
            ) : (
              <div className="space-y-2">
                {data.recentVideos.map(v => {
                  const status = videoStatus(v)
                  return (
                    <div key={v.id} className="flex items-center justify-between gap-3 bg-gray-50 rounded-lg px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{v.title}</p>
                        {v.module_name && <p className="text-[11px] text-gray-400">{v.module_name}</p>}
                      </div>
                      <div className="shrink-0 text-right space-y-1">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${status.cls}`}>
                          {status.label}
                        </span>
                        {v.highest_pct > 0 && (
                          <p className="text-[10px] text-gray-400">{Math.round(v.highest_pct)}%</p>
                        )}
                        {v.last_watched_at && (
                          <p className="text-[10px] text-gray-400">{fmtDate(v.last_watched_at)}</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Engagement Tab ───────────────────────────────────────────────────────────

function EngagementTab({ clientId, getToken }) {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/engagement`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setStats(await res.json())
      setLoading(false)
    }
    load()
  }, [clientId, getToken])

  const foodLogs = Number(stats?.food_logs_week) || 0
  const movement = Number(stats?.movement_week) || 0
  const waterLogs = Number(stats?.water_logs_week) || 0
  const stepLogs = Number(stats?.step_logs_week) || 0
  const habitsComplete = Number(stats?.habits_complete_week) || 0
  const habitsMissed = Number(stats?.habits_missed_week) || 0
  const comebackCount = Number(stats?.comeback_count) || 0
  const lastMealDays = stats?.last_meal_at ? daysSince(stats.last_meal_at) : null
  const lastDailyLogDays = stats?.last_daily_log ? daysSince(stats.last_daily_log) : null
  const lastActivityDays =
    [lastMealDays, lastDailyLogDays].filter(v => v !== null).sort((a, b) => a - b)[0] ?? null
  const hasActivity =
    foodLogs > 0 ||
    movement > 0 ||
    waterLogs > 0 ||
    stepLogs > 0 ||
    habitsComplete > 0 ||
    habitsMissed > 0 ||
    comebackCount > 0 ||
    lastActivityDays !== null

  function Stat({ label, value, sub, tone = 'default' }) {
    const toneClass = tone === 'attention'
      ? 'border-amber-200 bg-amber-50'
      : tone === 'positive'
        ? 'border-emerald-200 bg-emerald-50'
        : 'border-gray-200 bg-white'
    return (
      <div className={`border rounded-xl p-4 ${toneClass}`}>
        <p className="text-xs text-gray-400 mb-1">{label}</p>
        <p className="text-2xl font-bold text-gray-900">{value ?? 0}</p>
        {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
      </div>
    )
  }

  function EmptyNote({ children }) {
    return (
      <p className="text-xs text-gray-400 bg-gray-50 border border-dashed border-gray-200 rounded-lg px-3 py-2">
        {children}
      </p>
    )
  }

  const activityText =
    lastActivityDays === null ? 'No activity yet' :
    lastActivityDays === 0 ? 'Active today' :
    lastActivityDays === 1 ? 'Yesterday' :
    `${lastActivityDays} days ago`
  const followUps = []
  if (lastActivityDays === null) followUps.push('No activity logged yet. Consider a first check-in or onboarding nudge.')
  else if (lastActivityDays >= 3) followUps.push('No recent activity in the last few days. A quick follow-up may help.')
  if (foodLogs === 0) followUps.push('No food logs this week.')
  if (movement === 0) followUps.push('No movement logged this week.')
  if (habitsMissed > habitsComplete) followUps.push('More missed habit days than completed days this week.')

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">Engagement</h2>
        <p className="text-sm text-gray-500 mt-1">
          Use this section to quickly see whether the client is staying active with their plan and where they may need follow-up.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-4">Loading engagement…</p>
      ) : !stats ? (
        <p className="text-sm text-red-500 text-center py-4">Failed to load engagement data.</p>
      ) : !hasActivity ? (
        <div className="bg-white border border-gray-200 rounded-xl p-6 sm:p-8 text-center">
          <p className="text-2xl mb-2">⚡</p>
          <p className="text-sm text-gray-500 max-w-xl mx-auto">
            Engagement data will appear here once the client starts logging food, workouts, habits, messages, or check-ins.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              label="Last activity"
              value={activityText}
              sub={lastDailyLogDays !== null ? `Daily log ${lastDailyLogDays === 0 ? 'today' : `${lastDailyLogDays}d ago`}` : 'No daily log yet'}
              tone={lastActivityDays !== null && lastActivityDays <= 1 ? 'positive' : 'attention'}
            />
            <Stat label="Food logs" value={foodLogs} sub="this week" />
            <Stat label="Movement" value={movement} sub="workouts + activity this week" />
            <Stat label="Habits" value={`${habitsComplete}/${habitsComplete + habitsMissed}`} sub="completed this week" />
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Habit follow-through</p>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Completed" value={habitsComplete || '—'} sub={habitsComplete > 0 ? 'this week' : 'Not logged yet'} />
                <Stat label="Missed" value={habitsMissed || '—'} sub={habitsMissed > 0 ? 'this week' : 'No misses logged'} tone={habitsMissed > habitsComplete ? 'attention' : 'default'} />
              </div>
            </div>
            <div>
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Coach follow-up</p>
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                {followUps.length === 0 ? (
                  <p className="text-sm text-emerald-700 font-medium">Client looks active this week.</p>
                ) : (
                  <div className="space-y-2">
                    {followUps.map((item, i) => (
                      <p key={i} className="text-xs text-gray-600 flex gap-2">
                        <span className="text-[#E8670A] mt-0.5">•</span>
                        <span>{item}</span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Comebacks</p>
            {comebackCount > 0 ? (
              <div className="bg-white border border-emerald-200 rounded-xl p-4 flex items-center gap-3">
                <span className="text-3xl">🌱</span>
                <div>
                  <p className="text-2xl font-bold text-emerald-700">{comebackCount}</p>
                  <p className="text-xs text-gray-500">comeback events on record — every restart is progress.</p>
                </div>
              </div>
            ) : (
              <EmptyNote>No comeback events logged yet.</EmptyNote>
            )}
          </div>
        </>
      )}

      <IdentityMomentumSnapshot clientId={clientId} getToken={getToken} />
      <MindsetWatchSection clientId={clientId} getToken={getToken} />
    </div>
  )
}

// ─── Bloodwork Tab ────────────────────────────────────────────────────────────

const BLOODWORK_DISCLAIMER =
  'Educational only · Not medical advice · Not a diagnosis · Do not change any medication or supplement without speaking with your healthcare provider · Review results with a qualified doctor or provider, ideally a hormone specialist or functional medicine provider.'

function BloodworkTab({ clientId, getToken, bloodworkEnabled = false, onClientUpdate, client }) {
  const [uploads, setUploads] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [summarizingId, setSummarizingId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [error, setError] = useState(null)
  const [uploadError, setUploadError] = useState(null)
  const [file, setFile] = useState(null)
  const [labDate, setLabDate] = useState('')
  const [notes, setNotes] = useState('')
  const [togglingAccess, setTogglingAccess] = useState(false)
  const [intakeSaved, setIntakeSaved] = useState(null) // null=unknown, false=missing, true=saved
  const [showIntake, setShowIntake] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/bloodwork/staff/${clientId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`Server ${res.status}`)
        setUploads(await res.json())
      } catch (err) { setError(err.message) }
      finally { setLoading(false) }
    }
    load()
  }, [clientId, getToken])

  async function handleUpload(e) {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      const token = await getToken()
      const fd = new FormData()
      fd.append('file', file)
      if (labDate) fd.append('lab_date', labDate)
      if (notes.trim()) fd.append('notes', notes.trim())
      const res = await fetch(`${API_URL}/api/bloodwork/staff/${clientId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
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

  async function summarize(id) {
    setSummarizingId(id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/bloodwork/${id}/summarize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      let data = {}
      try { data = await res.json() } catch { /* non-JSON body */ }
      if (!res.ok) {
        alert(data.error ?? `Summary failed (${res.status}). Please try again.`)
        return
      }
      setUploads(prev => prev.map(u => u.id === id ? { ...u, ai_summary: data.ai_summary } : u))
    } catch {
      alert('Summary request failed — the server did not respond. This can happen if the AI call timed out. Please try again in a moment.')
    }
    finally { setSummarizingId(null) }
  }

  async function softDelete(id) {
    if (!window.confirm('Remove this bloodwork upload? This cannot be undone.')) return
    setDeletingId(id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/bloodwork/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setUploads(prev => prev.filter(u => u.id !== id))
    } catch { /* silent */ }
    finally { setDeletingId(null) }
  }

  async function toggleAccess() {
    setTogglingAccess(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/bloodwork/staff/${clientId}/access`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !bloodworkEnabled }),
      })
      if (res.ok) {
        const data = await res.json()
        onClientUpdate?.({ bloodwork_enabled: data.bloodwork_enabled })
      }
    } catch { /* silent */ }
    finally { setTogglingAccess(false) }
  }

  function fmtShort(iso) {
    if (!iso) return null
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">Loading bloodwork…</p>
  if (error) return <p className="text-sm text-red-500 py-6">{error}</p>

  return (
    <div className="space-y-5">

      {/* ── Client access toggle ── */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-gray-800">Client Access</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {bloodworkEnabled
              ? 'This client can see their own Bloodwork panel.'
              : 'Client cannot see Bloodwork. Enable below to give them access.'}
          </p>
        </div>
        <button
          onClick={toggleAccess}
          disabled={togglingAccess}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${
            bloodworkEnabled ? 'bg-[#E8670A]' : 'bg-gray-300'
          }`}
          role="switch"
          aria-checked={bloodworkEnabled}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            bloodworkEnabled ? 'translate-x-6' : 'translate-x-1'
          }`} />
        </button>
      </div>

      {/* ── Intake questionnaire (collapsible) ── */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <button
          onClick={() => setShowIntake(s => !s)}
          className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-gray-50 transition-colors">
          <div>
            <p className="text-sm font-semibold text-gray-800">Client Health Context</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {intakeSaved === false ? 'Missing — add context to improve AI summaries' :
               intakeSaved === true  ? 'Saved — AI will use this context' :
               'Age, sex, height, weight context for AI summaries'}
            </p>
          </div>
          <span className="text-gray-400 text-sm ml-3">{showIntake ? '▲' : '▼'}</span>
        </button>
        {showIntake && (
          <div className="border-t border-gray-100 px-5 pb-5 pt-3">
            <BloodworkIntakeForm
              intakeUrl={`${API_URL}/api/bloodwork/staff/${clientId}/intake`}
              getToken={getToken}
              defaults={{
                age:           client?.age,
                sex:           client?.gender,
                height_inches: client?.height_inches,
                weight_lbs:    client?.starting_weight_lbs,
              }}
              onIntakeChange={data => setIntakeSaved(data !== null)}
            />
          </div>
        )}
      </div>

      {/* ── Upload form ── */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-800 mb-4">Upload Lab Results</h3>
        <form onSubmit={handleUpload} className="space-y-3">
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
            className="w-full border-2 border-dashed border-gray-300 hover:border-[#E8670A] rounded-lg py-5 px-4 text-center transition-colors group"
          >
            {file ? (
              <span className="text-sm font-medium text-gray-800">{file.name}</span>
            ) : (
              <>
                <p className="text-sm font-medium text-gray-500 group-hover:text-[#E8670A]">Click to select file</p>
                <p className="text-xs text-gray-400 mt-1">PDF, JPG, PNG, or WEBP · max 20 MB</p>
              </>
            )}
          </button>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Lab Date</label>
              <input
                type="date"
                value={labDate}
                onChange={e => setLabDate(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Notes <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Quest Diagnostics panel"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]"
              />
            </div>
          </div>

          {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}

          <button
            type="submit"
            disabled={!file || uploading}
            className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#1e2a3a] text-white hover:bg-[#243347] transition-colors disabled:opacity-40"
          >
            {uploading ? 'Uploading…' : 'Upload Lab Results'}
          </button>
        </form>
      </div>

      {/* ── Uploads list ── */}
      {uploads.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
          <p className="text-sm text-gray-400">No bloodwork uploaded for this client yet.</p>
          <p className="text-xs text-gray-300 mt-1">Upload the first lab results above.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm font-semibold text-gray-700">Uploaded Labs ({uploads.length})</p>
          {uploads.map(u => (
            <div key={u.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">

              {/* File header */}
              <div className="p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 truncate">{u.original_filename}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {u.lab_date && (
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                          Lab: {fmtShort(u.lab_date)}
                        </span>
                      )}
                      <span className="text-xs text-gray-400">Uploaded {fmtShort(u.created_at)}</span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        u.has_text ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                      }`}>
                        {u.has_text ? 'Text extracted' : 'No text extracted'}
                      </span>
                    </div>
                    {u.notes && <p className="text-xs text-gray-500 mt-1 italic">"{u.notes}"</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => viewFile(u.id)}
                      className="text-xs font-medium text-[#E8670A] hover:text-[#c45e09] px-3 py-1.5 rounded-lg border border-[#E8670A]/30 hover:border-[#E8670A] transition-colors"
                    >
                      View
                    </button>
                    <button
                      onClick={() => softDelete(u.id)}
                      disabled={deletingId === u.id}
                      className="text-xs font-medium text-gray-400 hover:text-red-500 px-3 py-1.5 rounded-lg border border-gray-200 hover:border-red-200 transition-colors disabled:opacity-40"
                    >
                      {deletingId === u.id ? '…' : 'Delete'}
                    </button>
                  </div>
                </div>
              </div>

              {/* AI summary section */}
              <div className="border-t border-gray-100 bg-gray-50 p-4">
                {u.ai_summary ? (
                  <div>
                    <p className="text-[10px] font-semibold text-blue-600 uppercase tracking-wide mb-2">AI Educational Summary</p>
                    <div className="text-xs text-gray-700 leading-relaxed prose prose-xs max-w-none prose-headings:text-gray-800 prose-headings:font-semibold prose-strong:text-gray-800 prose-table:text-xs prose-td:py-1 prose-th:py-1 prose-hr:my-2">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{u.ai_summary}</ReactMarkdown>
                    </div>
                    <div className="mt-3 p-2.5 bg-amber-50 border border-amber-100 rounded-lg">
                      <p className="text-[10px] text-amber-700 leading-snug">{BLOODWORK_DISCLAIMER}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-xs font-medium text-gray-600">AI Educational Summary</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {u.has_text
                          ? 'Ready to generate — uses extracted lab text.'
                          : 'Cannot generate — no readable text was extracted from this file.'}
                      </p>
                    </div>
                    {u.has_text ? (
                      <div className="shrink-0 flex flex-col items-end gap-1">
                        {intakeSaved === false && (
                          <p className="text-[10px] text-amber-600 text-right max-w-[180px] leading-snug">
                            Health context missing — fill in above for better AI results
                          </p>
                        )}
                        <button
                          onClick={() => summarize(u.id)}
                          disabled={summarizingId === u.id}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#1e2a3a] text-white hover:bg-[#243347] transition-colors disabled:opacity-50"
                        >
                          {summarizingId === u.id ? 'Generating…' : 'Generate AI Summary'}
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 border border-amber-100">
                        Ask the client to re-upload a clearer image or a text-based PDF.
                      </p>
                    )}
                  </div>
                )}
              </div>

            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Coach Workouts Tab ───────────────────────────────────────────────────────

// ── Constants for the Katie questionnaire (mirror of Workouts.jsx) ────────────
const WO_GOALS = [
  { id: 'weight_loss',     label: 'Weight Loss'    },
  { id: 'muscle_gain',     label: 'Muscle Gain'    },
  { id: 'endurance',       label: 'Endurance'      },
  { id: 'flexibility',     label: 'Flexibility'    },
  { id: 'general_fitness', label: 'General Fitness'},
]
const WO_SESSION_LENGTHS   = ['30 minutes', '45 minutes', '60 minutes', '90 minutes']
const WO_EQUIPMENT_OPTIONS = ['Kettlebell', 'Dumbbells', 'Body Weight', 'Barbell', 'Benches', 'Cable Machine', 'Full Gym', 'Resistance Bands']
const WO_FITNESS_LEVELS    = ['Beginner', 'Intermediate', 'Advanced']
const WO_SUPERSET_OPTIONS = [
  { id: 'none', icon: '✕', title: 'No Supersets',   subtitle: 'Standard workout' },
  { id: 'some', icon: '⚡', title: 'Some Supersets', subtitle: '1 per workout' },
  { id: 'full', icon: '🔥', title: 'Full Supersets', subtitle: 'Maximum intensity' },
]
const WO_CIRCUIT_OPTIONS = [
  { id: 'none', icon: '✕', title: 'No Circuits',   subtitle: 'Standard format' },
  { id: 'some', icon: '🔄', title: 'Some Circuits', subtitle: '1 per workout' },
  { id: 'full', icon: '🔥', title: 'Full Circuits', subtitle: 'Multiple circuits' },
]
const WO_EMPTY_FORM        = { goals: [], days_per_week: '4', session_length: '45 minutes', equipment: ['Full Gym'], injuries: '', fitness_level: 'Intermediate', supersets: '', circuits: '' }

// Movement patterns for the exercise-library search filter (mirrors the DB CHECK constraint)
const MOVEMENT_PATTERNS = [
  { id: 'squat_bilateral',  label: 'Squat' },
  { id: 'squat_unilateral', label: 'Squat (Unilateral)' },
  { id: 'hinge_bilateral',  label: 'Hinge' },
  { id: 'hinge_unilateral', label: 'Hinge (Unilateral)' },
  { id: 'upper_push',       label: 'Upper Push' },
  { id: 'upper_pull',       label: 'Upper Pull' },
  { id: 'core',             label: 'Core' },
  { id: 'carry',            label: 'Carry' },
  { id: 'conditioning',     label: 'Conditioning' },
  { id: 'mobility',         label: 'Mobility' },
]

// ── Workout-scheduling date helpers (YYYY-MM-DD, local, no TZ shifts) ─────────
function schedIsoToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function schedAddDays(iso, n) {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function schedAddMonths(iso, n) {
  const d = new Date(iso + 'T00:00:00')
  d.setMonth(d.getMonth() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function schedDaysInclusive(startIso, endIso) {
  const a = new Date(startIso + 'T00:00:00')
  const b = new Date(endIso + 'T00:00:00')
  return Math.round((b - a) / 86400000) + 1
}
function schedFmt(iso) {
  if (!iso) return ''
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const WO_DURATION_TYPES = [
  { id: 'weekly',  icon: '📅', title: 'Weekly Duration',     subtitle: 'Repeat for a set number of weeks' },
  { id: 'monthly', icon: '🗓️', title: 'Monthly Duration',    subtitle: 'Repeat for a set number of months' },
  { id: 'range',   icon: '📆', title: 'Specific Date Range',  subtitle: 'Pick exact start and end dates' },
]

// ── Modal: schedule a saved program's days onto the client's calendar ─────────
function ScheduleWorkoutModal({ clientId, workout, dayLabels, getToken, onClose, onScheduled }) {
  const BASE = `${API_URL}/api/coach-admin/clients/${clientId}`

  const [step,          setStep]          = useState(1)
  const [durationType,  setDurationType]  = useState('weekly')
  const [weeks,         setWeeks]         = useState('4')
  const [months,        setMonths]        = useState('1')
  const [startDate,     setStartDate]     = useState(schedIsoToday())
  const [rangeEnd,      setRangeEnd]      = useState(schedAddDays(schedIsoToday(), 27))
  const [dayAssignments, setDayAssignments] = useState({})   // { [dayLabel]: number[] (0=Sun..6=Sat) }
  const [existing,      setExisting]      = useState([])
  const [loadingExisting, setLoadingExisting] = useState(true)
  const [submitting,    setSubmitting]    = useState(false)
  const [error,         setError]         = useState(null)

  // Computed end date + duration from step-1 inputs
  const endDate =
    durationType === 'weekly'
      ? (weeks  && parseInt(weeks, 10)  > 0 ? schedAddDays(startDate, parseInt(weeks, 10) * 7 - 1) : null)
    : durationType === 'monthly'
      ? (months && parseInt(months, 10) > 0 ? schedAddDays(schedAddMonths(startDate, parseInt(months, 10)), -1) : null)
      : (rangeEnd || null)

  const durationValid = !!(startDate && endDate && endDate >= startDate)
  const durationDays  = durationValid ? schedDaysInclusive(startDate, endDate) : null

  // Load existing scheduled programs for this client (deduped by assignment id)
  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoadingExisting(true)
      try {
        const token = await getToken()
        const start = schedAddDays(schedIsoToday(), -30)
        const end   = schedAddDays(schedIsoToday(), 365)
        const res = await fetch(`${BASE}/workout-schedules/calendar?start=${start}&end=${end}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          const map = new Map()
          for (const entries of Object.values(data.calendar ?? {})) {
            for (const { assignment } of entries) {
              if (assignment && !map.has(assignment.id)) map.set(assignment.id, assignment)
            }
          }
          if (alive) setExisting([...map.values()])
        }
      } catch { /* best effort — existing list is informational */ }
      finally { if (alive) setLoadingExisting(false) }
    })()
    return () => { alive = false }
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleDow(dayLabel, dow) {
    setDayAssignments(prev => {
      const cur = prev[dayLabel] ?? []
      const next = cur.includes(dow) ? cur.filter(x => x !== dow) : [...cur, dow]
      return { ...prev, [dayLabel]: next.sort((a, b) => a - b) }
    })
  }

  async function deleteExisting(assignmentId) {
    if (!window.confirm('Cancel this scheduled program? It will be removed from the client’s calendar.')) return
    try {
      const token = await getToken()
      const res = await fetch(`${BASE}/workout-schedules/${assignmentId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setExisting(prev => prev.filter(a => a.id !== assignmentId))
    } catch { /* ignore — coach can retry */ }
  }

  async function submit() {
    setError(null)
    if (!durationValid) { setError('Set a valid program duration first.'); setStep(1); return }
    const assignments = dayLabels
      .filter(dl => (dayAssignments[dl] ?? []).length > 0)
      .map(dl => ({
        day_label:    dl,
        frequency:    'specific_days',
        days_of_week: (dayAssignments[dl] ?? []).slice().sort((a, b) => a - b).join(','),
        start_date:   startDate,
        end_date:     endDate,
      }))
    if (!assignments.length) {
      setError('Pick at least one day of the week for at least one workout day.'); return
    }
    setSubmitting(true)
    try {
      const token = await getToken()
      const res = await fetch(`${BASE}/workouts/${workout.id}/schedule`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || `Server error ${res.status}`)
      }
      onScheduled(assignments.length)
    } catch (err) {
      setError(err.message)
    } finally { setSubmitting(false) }
  }

  const dowBtn = (active) =>
    `px-2.5 py-1.5 rounded-lg text-xs font-semibold border-2 transition-colors min-h-[36px] ${
      active ? 'bg-[#E8670A] border-[#E8670A] text-white'
             : 'border-gray-200 text-gray-600 hover:border-[#E8670A] bg-white'
    }`

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[92vh] flex flex-col overflow-hidden shadow-xl"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div className="min-w-0">
            <p className="text-[11px] text-gray-400 truncate">Schedule Program</p>
            <p className="text-sm font-semibold text-gray-900 truncate">{workout.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1.5 leading-none shrink-0 text-lg">✕</button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 shrink-0">
          {[1, 2].map(s => (
            <div key={s} className="flex items-center gap-2">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
                step === s ? 'bg-[#E8670A] text-white' : step > s ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400'
              }`}>{step > s ? '✓' : s}</span>
              <span className={`text-xs font-medium ${step === s ? 'text-gray-900' : 'text-gray-400'}`}>
                {s === 1 ? 'Set Duration' : 'Schedule Days'}
              </span>
              {s === 1 && <span className="text-gray-300 mx-1">›</span>}
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          {step === 1 && (
            <>
              <div>
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Program Duration Type</p>
                <div className="space-y-2">
                  {WO_DURATION_TYPES.map(dt => {
                    const active = durationType === dt.id
                    return (
                      <button key={dt.id} type="button" onClick={() => setDurationType(dt.id)}
                        className={`w-full text-left flex items-center gap-3 rounded-xl border-2 p-3 transition-all ${
                          active ? 'border-[#E8670A] bg-orange-50' : 'border-gray-200 hover:border-[#E8670A]/50 bg-white'
                        }`}>
                        <span className="text-2xl shrink-0">{dt.icon}</span>
                        <span className="min-w-0">
                          <span className={`block text-sm font-semibold ${active ? 'text-[#E8670A]' : 'text-gray-800'}`}>{dt.title}</span>
                          <span className="block text-xs text-gray-500">{dt.subtitle}</span>
                        </span>
                        <span className={`ml-auto shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                          active ? 'border-[#E8670A] bg-[#E8670A]' : 'border-gray-300'
                        }`}>{active && <span className="w-2 h-2 rounded-full bg-white" />}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {durationType === 'weekly' && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Duration (weeks)</label>
                  <input type="number" min="1" value={weeks} onChange={e => setWeeks(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30" />
                </div>
              )}
              {durationType === 'monthly' && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Duration (months)</label>
                  <input type="number" min="1" value={months} onChange={e => setMonths(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30" />
                </div>
              )}

              <div className={`grid gap-2 ${durationType === 'range' ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Start date</label>
                  <input type="date" value={startDate} min={schedIsoToday()}
                    onChange={e => setStartDate(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                </div>
                {durationType === 'range' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">End date</label>
                    <input type="date" value={rangeEnd} min={startDate}
                      onChange={e => setRangeEnd(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                  </div>
                )}
              </div>

              {durationValid ? (
                <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5">
                  <p className="text-sm font-semibold text-gray-800">Program duration: {durationDays} days</p>
                  <p className="text-xs text-gray-500 mt-0.5">{schedFmt(startDate)} → {schedFmt(endDate)}</p>
                </div>
              ) : (
                <p className="text-xs text-amber-600">Enter a valid duration to continue.</p>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Schedule each workout day</p>
                <p className="text-xs text-gray-500 mb-3">
                  Pick which day(s) of the week each workout repeats on, between{' '}
                  <span className="font-medium text-gray-700">{schedFmt(startDate)}</span> and{' '}
                  <span className="font-medium text-gray-700">{schedFmt(endDate)}</span>.
                </p>
                <div className="space-y-3">
                  {dayLabels.map(dl => (
                    <div key={dl} className="rounded-xl border border-gray-200 p-3">
                      <p className="text-sm font-semibold text-gray-800 mb-2">{formatDayLabel(dl)}</p>
                      <div className="flex gap-1.5 flex-wrap">
                        {DAYS.map((d, i) => {
                          const active = (dayAssignments[dl] ?? []).includes(i)
                          return (
                            <button key={d} type="button" onClick={() => toggleDow(dl, i)}
                              className={dowBtn(active)}>{d}</button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Existing scheduled programs */}
              <div>
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Existing schedules for this client</p>
                {loadingExisting ? (
                  <p className="text-xs text-gray-400">Loading…</p>
                ) : existing.length === 0 ? (
                  <p className="text-xs text-gray-400">No scheduled programs yet.</p>
                ) : (
                  <div className="space-y-2">
                    {existing.map(a => (
                      <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-gray-800 truncate">
                            {a.workout_name} · {formatDayLabel(a.day_label)}
                          </p>
                          <p className="text-[11px] text-gray-500 truncate">
                            {a.days_of_week
                              ? a.days_of_week.split(',').map(n => DAYS[Number(n)]).join(', ')
                              : a.frequency}
                            {' · '}{schedFmt(a.start_date)}{a.end_date ? ` → ${schedFmt(a.end_date)}` : ''}
                          </p>
                        </div>
                        <button onClick={() => deleteExisting(a.id)}
                          title="Cancel this schedule"
                          className="shrink-0 text-gray-300 hover:text-red-500 transition-colors p-1.5 leading-none">🗑</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-gray-100 shrink-0">
          {step === 1 ? (
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          ) : (
            <button onClick={() => { setStep(1); setError(null) }}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
              ‹ Back
            </button>
          )}
          {step === 1 ? (
            <button onClick={() => { setError(null); setStep(2) }} disabled={!durationValid}
              className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
              Next ›
            </button>
          ) : (
            <button onClick={submit} disabled={submitting}
              className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors flex items-center gap-2">
              {submitting
                ? <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Scheduling…</>
                : 'Schedule Workouts'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function WorkoutsTab({ clientId, clientFirstName, getToken }) {
  const BASE = `${API_URL}/api/coach-admin/clients/${clientId}/workouts`

  // ── State ──────────────────────────────────────────────────────────────────
  const [workouts,     setWorkouts]     = useState([])
  const [loading,      setLoading]      = useState(true)
  const [selected,     setSelected]     = useState(null)   // { id, name, description }
  const [exercises,    setExercises]    = useState([])
  const [logs,         setLogs]         = useState([])
  const [detailLoad,   setDetailLoad]   = useState(false)

  // Katie generation flow: null | 'questionnaire' | 'generating' | 'review'
  const [genFlow,        setGenFlow]        = useState(null)
  const [genForm,        setGenForm]        = useState({ ...WO_EMPTY_FORM })
  const [generatedPlan,  setGeneratedPlan]  = useState(null)
  const [generating,     setGenerating]     = useState(false)
  const [genError,       setGenError]       = useState(null)
  const [savingPlan,     setSavingPlan]     = useState(false)
  const [assigningDraft, setAssigningDraft] = useState(false)
  // Inline edit state for the pre-save review table (operates on generatedPlan state)
  const [reviewEdit,     setReviewEdit]     = useState(null)   // { dayIdx, exIdx, field }
  const [reviewEditVal,  setReviewEditVal]  = useState('')

  // Manual create form
  const [showCreate,   setShowCreate]   = useState(false)
  const [createName,   setCreateName]   = useState('')
  const [createDesc,   setCreateDesc]   = useState('')
  const [creating,     setCreating]     = useState(false)

  // Add exercise form
  const [showAddEx,    setShowAddEx]    = useState(false)
  const [exForm,       setExForm]       = useState({ day: 'Day 1', exercise_name: '', exercise_id: null, sets: '', reps: '', weight: '', rest_seconds: '', notes: '' })
  const [addingEx,     setAddingEx]     = useState(false)

  // Exercise library autocomplete (search-as-you-type + movement pattern filter)
  const [exSuggestions,   setExSuggestions]   = useState([])
  const [exSuggestOpen,   setExSuggestOpen]   = useState(false)
  const [exPatternFilter, setExPatternFilter] = useState('')
  const exSearchTimer = useRef(null)

  function searchExercises(term, pattern) {
    clearTimeout(exSearchTimer.current)
    if (!term.trim() && !pattern) { setExSuggestions([]); return }
    exSearchTimer.current = setTimeout(async () => {
      try {
        const token = await getToken()
        const params = new URLSearchParams()
        if (term.trim()) params.set('search', term.trim())
        if (pattern) params.set('movement_pattern', pattern)
        const res = await fetch(`${API_URL}/api/coach-admin/exercises?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setExSuggestions(await res.json())
      } catch { /* silent — autocomplete is best-effort */ }
    }, 250)
  }

  function pickSuggestedExercise(ex) {
    setExForm(f => ({ ...f, exercise_name: ex.name, exercise_id: ex.id }))
    setExSuggestOpen(false)
    setExSuggestions([])
  }

  // Inline edit state
  const [editCell,     setEditCell]     = useState(null)   // { exId, field }
  const [editVal,      setEditVal]      = useState('')
  const [cellSaving,   setCellSaving]   = useState(false)

  const [error, setError] = useState(null)

  // Scheduling modal
  const [scheduling,      setScheduling]      = useState(false)
  const [scheduleSuccess, setScheduleSuccess] = useState(null)

  // ── Load list ──────────────────────────────────────────────────────────────
  async function loadWorkouts() {
    setLoading(true)
    try {
      const token = await getToken()
      const res   = await fetch(BASE, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setWorkouts(await res.json())
    } finally { setLoading(false) }
  }
  useEffect(() => { loadWorkouts() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Open a workout ─────────────────────────────────────────────────────────
  async function openWorkout(w) {
    setSelected(w); setDetailLoad(true); setExercises([]); setLogs([]); setError(null)
    try {
      const token = await getToken()
      const res   = await fetch(`${BASE}/${w.id}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const data  = await res.json()
      setExercises(data.exercises ?? [])
      setLogs(data.logs ?? [])
    } finally { setDetailLoad(false) }
  }

  // ── Katie generation ───────────────────────────────────────────────────────
  function toggleGenGoal(id) {
    setGenForm(f => ({ ...f, goals: f.goals.includes(id) ? f.goals.filter(g => g !== id) : [...f.goals, id] }))
  }
  function toggleGenEquipment(eq) {
    setGenForm(f => ({ ...f, equipment: f.equipment.includes(eq) ? f.equipment.filter(e => e !== eq) : [...f.equipment, eq] }))
  }
  async function generatePlan(e) {
    e.preventDefault()
    if (!genForm.goals.length) { setGenError('Select at least one goal.'); return }
    if (!genForm.supersets) { setGenError('Select a superset preference.'); return }
    if (!genForm.circuits) { setGenError('Select a circuit preference.'); return }
    setGenerating(true); setGenError(null)
    try {
      const token = await getToken()
      const res   = await fetch(`${BASE}/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...genForm, days_per_week: parseInt(genForm.days_per_week, 10) }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || `Server error ${res.status}`)
      }
      setGeneratedPlan(await res.json())
      setGenFlow('review')
    } catch (err) { setGenError(err.message) } finally { setGenerating(false) }
  }
  async function savePlan(status = 'assigned') {
    if (!generatedPlan) return
    setSavingPlan(true); setGenError(null)
    try {
      const token = await getToken()
      const res   = await fetch(BASE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:        generatedPlan.program_name,
          description: generatedPlan.description,
          days:        generatedPlan.days,
          status,
        }),
      })
      if (!res.ok) throw new Error('Failed to save program')
      const w = await res.json()
      const exCount = generatedPlan.days?.reduce((n, d) => n + (d.exercises?.length ?? 0), 0) ?? 0
      setWorkouts(prev => [{ ...w, exercise_count: exCount, day_count: generatedPlan.days?.length ?? 0, log_count: 0 }, ...prev])
      setGenFlow(null); setGeneratedPlan(null); setGenForm({ ...WO_EMPTY_FORM })
      openWorkout(w)
    } catch (err) { setGenError(err.message) } finally { setSavingPlan(false) }
  }

  // ── Assign a saved draft to the client ─────────────────────────────────────
  async function assignDraft() {
    if (!selected) return
    setAssigningDraft(true); setError(null)
    try {
      const token = await getToken()
      const res   = await fetch(`${BASE}/${selected.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'assigned' }),
      })
      if (!res.ok) throw new Error('Failed to assign program')
      const updated = await res.json()
      setSelected(updated)
      setWorkouts(prev => prev.map(w => w.id === updated.id ? { ...w, status: updated.status } : w))
    } catch (err) { setError(err.message) } finally { setAssigningDraft(false) }
  }

  // ── Review-panel edit helpers (operate on generatedPlan state, no API calls) ─
  function startReviewEdit(dayIdx, exIdx, field, val) {
    setReviewEdit({ dayIdx, exIdx, field })
    setReviewEditVal(val != null ? String(val) : '')
  }
  function cancelReviewEdit() { setReviewEdit(null) }
  function commitReviewEdit() {
    if (!reviewEdit) return
    const { dayIdx, exIdx, field } = reviewEdit
    setGeneratedPlan(plan => ({
      ...plan,
      days: plan.days.map((day, di) => di !== dayIdx ? day : {
        ...day,
        exercises: day.exercises.map((ex, ei) => {
          if (ei !== exIdx) return ex
          const val = field === 'sets' || field === 'rest_seconds'
            ? (reviewEditVal !== '' ? Number(reviewEditVal) : null)
            : (reviewEditVal || null)
          return { ...ex, [field]: val }
        }),
      }),
    }))
    setReviewEdit(null)
  }
  function deleteReviewExercise(dayIdx, exIdx) {
    setGeneratedPlan(plan => ({
      ...plan,
      days: plan.days.map((day, di) => di !== dayIdx ? day : {
        ...day,
        exercises: day.exercises.filter((_, ei) => ei !== exIdx),
      }),
    }))
  }
  function moveReviewExercise(dayIdx, exIdx, direction) {
    const targetIdx = direction === 'up' ? exIdx - 1 : exIdx + 1
    setGeneratedPlan(plan => ({
      ...plan,
      days: plan.days.map((day, di) => {
        if (di !== dayIdx) return day
        const exs = [...day.exercises]
        ;[exs[exIdx], exs[targetIdx]] = [exs[targetIdx], exs[exIdx]]
        return { ...day, exercises: exs }
      }),
    }))
  }

  // ── Create workout (manual) ─────────────────────────────────────────────────
  async function createWorkout(e) {
    e.preventDefault()
    if (!createName.trim()) return
    setCreating(true); setError(null)
    try {
      const token = await getToken()
      const res   = await fetch(BASE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName.trim(), description: createDesc.trim() || null }),
      })
      if (!res.ok) throw new Error('Failed to create workout')
      const w = await res.json()
      setWorkouts(prev => [{ ...w, exercise_count: 0, day_count: 0, log_count: 0 }, ...prev])
      setCreateName(''); setCreateDesc(''); setShowCreate(false)
      openWorkout(w)
    } catch (err) { setError(err.message) } finally { setCreating(false) }
  }

  // ── Delete workout ─────────────────────────────────────────────────────────
  async function deleteWorkout() {
    if (!window.confirm(`Delete "${selected.name}"? This cannot be undone.`)) return
    const token = await getToken()
    await fetch(`${BASE}/${selected.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    setWorkouts(prev => prev.filter(w => w.id !== selected.id))
    setSelected(null)
  }

  // ── Add exercise ───────────────────────────────────────────────────────────
  async function addExercise(e) {
    e.preventDefault()
    if (!exForm.exercise_name.trim()) return
    setAddingEx(true); setError(null)
    try {
      const token = await getToken()
      const body  = {
        day:           exForm.day || 'Day 1',
        exercise_name: exForm.exercise_name.trim(),
        exercise_id:   exForm.exercise_id ?? null,
        sets:          exForm.sets !== '' ? Number(exForm.sets) : null,
        reps:          exForm.reps || null,
        weight:        exForm.weight || null,
        rest_seconds:  exForm.rest_seconds !== '' ? Number(exForm.rest_seconds) : null,
        notes:         exForm.notes || null,
        sort_order:    exercises.length,
      }
      const res = await fetch(`${BASE}/${selected.id}/exercises`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Failed to add exercise')
      const ex = await res.json()
      setExercises(prev => [...prev, ex])
      setExForm({ day: exForm.day, exercise_name: '', exercise_id: null, sets: '', reps: '', weight: '', rest_seconds: '', notes: '' })
      setExSuggestions([]); setExSuggestOpen(false)
      setShowAddEx(false)
    } catch (err) { setError(err.message) } finally { setAddingEx(false) }
  }

  // ── Inline edit ────────────────────────────────────────────────────────────
  function startEdit(exId, field, val) {
    setEditCell({ exId, field }); setEditVal(val != null ? String(val) : '')
  }
  function cancelEdit() { setEditCell(null) }
  async function saveEdit(exId, field) {
    setCellSaving(true)
    try {
      const token = await getToken()
      const val   = field === 'sets' || field === 'rest_seconds'
        ? (editVal !== '' ? Number(editVal) : null)
        : (editVal || null)
      const res = await fetch(`${BASE}/exercises/${exId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: val }),
      })
      if (res.ok) {
        const updated = await res.json()
        setExercises(prev => prev.map(e => e.id === exId ? { ...e, ...updated } : e))
      }
    } finally { setCellSaving(false); setEditCell(null) }
  }

  // ── Delete exercise ────────────────────────────────────────────────────────
  async function deleteExercise(exId, name) {
    if (!window.confirm(`Remove "${name}" from this workout?`)) return
    const token = await getToken()
    const res   = await fetch(`${BASE}/exercises/${exId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setExercises(prev => prev.filter(e => e.id !== exId))
  }

  // ── Move exercise up / down within its day ─────────────────────────────────
  async function moveExercise(exId, direction) {
    const ex = exercises.find(e => e.id === exId)
    if (!ex) return
    // Get this day's exercises in current display order
    const dayExs = exercises
      .filter(e => e.day === ex.day)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
    const idx = dayExs.findIndex(e => e.id === exId)
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= dayExs.length) return
    // Swap positions and assign clean sequential sort_orders
    const reordered = [...dayExs]
    ;[reordered[idx], reordered[targetIdx]] = [reordered[targetIdx], reordered[idx]]
    const updates = reordered.map((e, i) => ({ id: e.id, sort_order: i }))
    // Update locally for instant feedback
    setExercises(prev => prev.map(e => {
      const u = updates.find(u => u.id === e.id)
      return u ? { ...e, sort_order: u.sort_order } : e
    }))
    // Persist the two swapped exercises to the server
    const token = await getToken()
    await Promise.all(
      updates
        .filter(u => u.id === exId || u.id === dayExs[targetIdx].id)
        .map(u => fetch(`${BASE}/exercises/${u.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sort_order: u.sort_order }),
        }))
    )
  }

  // ── Group exercises by day, sorted by sort_order then id ──────────────────
  const days = exercises.reduce((acc, ex) => {
    if (!acc[ex.day]) acc[ex.day] = []
    acc[ex.day].push(ex)
    return acc
  }, {})
  Object.values(days).forEach(exs =>
    exs.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
  )

  const inputCls = 'w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30'

  // ── Pill style for questionnaire (matches client Workouts page) ───────────
  const pillCls = (active) =>
    `px-3 py-1.5 rounded-full text-xs font-medium border cursor-pointer transition-colors ${
      active ? 'bg-[#E8670A] text-white border-[#E8670A]'
             : 'text-gray-600 border-gray-200 hover:border-[#E8670A] hover:text-[#E8670A] bg-white'
    }`

  // ── Questionnaire view (generate with Katie) ───────────────────────────────
  if (genFlow === 'questionnaire' || genFlow === 'review') {
    if (genFlow === 'review' && generatedPlan) {
      // Helper: renders an editable cell in the review table
      function rCell(dayIdx, exIdx, field, val, type = 'text', placeholder = '—') {
        const editing = reviewEdit?.dayIdx === dayIdx && reviewEdit?.exIdx === exIdx && reviewEdit?.field === field
        return editing ? (
          <input
            autoFocus type={type} value={reviewEditVal}
            onChange={e => setReviewEditVal(e.target.value)}
            onBlur={commitReviewEdit}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') cancelReviewEdit() }}
            className="w-full border border-[#E8670A] rounded px-1.5 py-0.5 text-xs focus:outline-none bg-orange-50"
            placeholder={placeholder}
          />
        ) : (
          <span onClick={() => startReviewEdit(dayIdx, exIdx, field, val)}
            title="Click to edit" className="cursor-pointer hover:text-[#E8670A] transition-colors">
            {val ?? <span className="text-gray-300">—</span>}
          </span>
        )
      }

      return (
        <div className="space-y-5">
          {/* Header — no description paragraph */}
          <div>
            <button onClick={() => { setGenFlow('questionnaire'); setReviewEdit(null) }}
              className="text-xs text-gray-400 hover:text-gray-600 mb-2 flex items-center gap-1">‹ Back to questionnaire</button>
            <p className="text-lg font-bold text-gray-900">{generatedPlan.program_name}</p>
            <p className="text-xs text-[#E8670A] mt-1">
              ✨ Generated by Katie · Click any cell to edit, then assign to client
            </p>
          </div>

          {/* Editable exercise tables per day */}
          {generatedPlan.days?.map((day, dayIdx) => (
            <div key={dayIdx} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="bg-[#0F1E35] px-4 py-2.5 flex items-center justify-between">
                <p className="text-sm font-semibold text-white">{formatDayLabel(day.day_name)}</p>
                {day.focus && <p className="text-[10px] text-white/50">{day.focus}</p>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[560px]">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-3 py-2 text-gray-500 font-semibold">Exercise</th>
                      <th className="text-center px-2 py-2 text-gray-500 font-semibold w-14">Sets</th>
                      <th className="text-center px-2 py-2 text-gray-500 font-semibold w-20">Reps</th>
                      <th className="text-center px-2 py-2 text-gray-500 font-semibold w-16">Rest</th>
                      <th className="text-left px-3 py-2 text-gray-500 font-semibold">Notes</th>
                      <th className="w-12 text-center px-1 py-2 text-gray-400 font-semibold text-[10px]">Order</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {day.exercises?.map((ex, exIdx) => {
                      const isFirst = exIdx === 0
                      const isLast  = exIdx === (day.exercises?.length ?? 0) - 1
                      return (
                        <tr key={exIdx} className="hover:bg-gray-50/40">
                          <td className="px-3 py-2.5 font-medium text-gray-900">
                            {rCell(dayIdx, exIdx, 'name', ex.name, 'text', 'Exercise name')}
                          </td>
                          <td className="px-2 py-2.5 text-center text-gray-600">
                            {rCell(dayIdx, exIdx, 'sets', ex.sets, 'number', '3')}
                          </td>
                          <td className="px-2 py-2.5 text-center text-gray-600">
                            {rCell(dayIdx, exIdx, 'reps', ex.reps, 'text', '8-10')}
                          </td>
                          <td className="px-2 py-2.5 text-center text-gray-500">
                            {rCell(dayIdx, exIdx, 'rest_seconds', ex.rest_seconds, 'number', '90')}
                          </td>
                          <td className="px-3 py-2.5 text-gray-500 max-w-[200px]">
                            {rCell(dayIdx, exIdx, 'notes', ex.notes, 'text', 'Instructions…')}
                          </td>
                          {/* ▲ / ▼ reorder */}
                          <td className="px-1 py-2.5 text-center w-12">
                            <div className="flex flex-col items-center gap-0.5">
                              <button onClick={() => moveReviewExercise(dayIdx, exIdx, 'up')} disabled={isFirst}
                                title="Move up"
                                className="text-gray-300 hover:text-[#E8670A] disabled:opacity-20 disabled:cursor-not-allowed transition-colors text-xs leading-none px-1 py-0.5 min-h-[20px]">▲</button>
                              <button onClick={() => moveReviewExercise(dayIdx, exIdx, 'down')} disabled={isLast}
                                title="Move down"
                                className="text-gray-300 hover:text-[#E8670A] disabled:opacity-20 disabled:cursor-not-allowed transition-colors text-xs leading-none px-1 py-0.5 min-h-[20px]">▼</button>
                            </div>
                          </td>
                          {/* Delete */}
                          <td className="px-2 py-2.5 text-center">
                            <button onClick={() => deleteReviewExercise(dayIdx, exIdx)}
                              className="text-gray-300 hover:text-red-400 transition-colors font-bold text-sm"
                              title="Remove exercise">✕</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {genError && <p className="text-xs text-red-500">{genError}</p>}
          <div className="flex gap-3 flex-wrap">
            <button onClick={() => savePlan('assigned')} disabled={savingPlan}
              className="bg-[#E8670A] text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors flex items-center gap-2">
              {savingPlan ? <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Saving…</> : 'Assign to Client'}
            </button>
            <button onClick={() => savePlan('draft')} disabled={savingPlan}
              className="px-5 py-2.5 rounded-lg text-sm font-semibold text-[#E8670A] border border-[#E8670A] hover:bg-orange-50 disabled:opacity-60 transition-colors">
              {savingPlan ? 'Saving…' : 'Save as Draft'}
            </button>
            <button onClick={() => { setGenFlow('questionnaire'); setGeneratedPlan(null); setReviewEdit(null) }}
              className="px-5 py-2.5 rounded-lg text-sm font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 transition-colors">
              Regenerate
            </button>
            <button onClick={() => { setGenFlow(null); setGeneratedPlan(null); setGenForm({ ...WO_EMPTY_FORM }); setReviewEdit(null) }}
              className="px-5 py-2.5 rounded-lg text-sm font-medium text-gray-400 hover:text-red-500 transition-colors">
              Discard
            </button>
          </div>
        </div>
      )
    }

    // Questionnaire form
    return (
      <div className="max-w-xl space-y-5">
        <div>
          <button onClick={() => { setGenFlow(null); setGenForm({ ...WO_EMPTY_FORM }) }}
            className="text-xs text-gray-400 hover:text-gray-600 mb-3 flex items-center gap-1">‹ Back</button>
          <div className="bg-[#fff7ed] border border-orange-200 rounded-xl p-4 mb-5">
            <p className="text-sm font-semibold text-[#E8670A] mb-0.5">Generate with Katie</p>
            <p className="text-sm text-gray-700">
              Fill in the client's goals and preferences. Katie will build a custom workout program that you can review and edit before assigning.
            </p>
          </div>
        </div>
        <form onSubmit={generatePlan} className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Fitness goals <span className="text-red-400">*</span></label>
            <div className="flex flex-wrap gap-2">
              {WO_GOALS.map(g => (
                <button key={g.id} type="button" onClick={() => toggleGenGoal(g.id)}
                  className={pillCls(genForm.goals.includes(g.id))}>{g.label}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Training days per week</label>
            <div className="flex gap-2 flex-wrap">
              {[2,3,4,5,6].map(n => (
                <button key={n} type="button" onClick={() => setGenForm(f => ({ ...f, days_per_week: String(n) }))}
                  className={pillCls(genForm.days_per_week === String(n))}>{n} days</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Session length</label>
            <div className="flex gap-2 flex-wrap">
              {WO_SESSION_LENGTHS.map(s => (
                <button key={s} type="button" onClick={() => setGenForm(f => ({ ...f, session_length: s }))}
                  className={pillCls(genForm.session_length === s)}>{s}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Available equipment</label>
            <div className="flex gap-2 flex-wrap">
              {WO_EQUIPMENT_OPTIONS.map(eq => (
                <button key={eq} type="button" onClick={() => toggleGenEquipment(eq)}
                  className={pillCls(genForm.equipment.includes(eq))}>{eq}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Fitness level</label>
            <div className="flex gap-2">
              {WO_FITNESS_LEVELS.map(lvl => (
                <button key={lvl} type="button" onClick={() => setGenForm(f => ({ ...f, fitness_level: lvl }))}
                  className={pillCls(genForm.fitness_level === lvl)}>{lvl}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Would {clientFirstName || 'your client'} like to include supersets for added intensity? <span className="text-red-400">*</span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              {WO_SUPERSET_OPTIONS.map(opt => {
                const active = genForm.supersets === opt.id
                return (
                  <button key={opt.id} type="button" onClick={() => setGenForm(f => ({ ...f, supersets: opt.id }))}
                    className={`flex flex-col items-center text-center gap-1 rounded-xl border-2 p-3 transition-all ${
                      active ? 'border-[#E8670A] bg-orange-50' : 'border-gray-200 hover:border-[#E8670A]/50 bg-white'
                    }`}>
                    <span className="text-xl">{opt.icon}</span>
                    <span className={`text-xs font-semibold ${active ? 'text-[#E8670A]' : 'text-gray-800'}`}>{opt.title}</span>
                    <span className="text-[11px] text-gray-500">{opt.subtitle}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Would {clientFirstName || 'your client'} like to include circuits (3+ exercises in a row)? <span className="text-red-400">*</span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              {WO_CIRCUIT_OPTIONS.map(opt => {
                const active = genForm.circuits === opt.id
                return (
                  <button key={opt.id} type="button" onClick={() => setGenForm(f => ({ ...f, circuits: opt.id }))}
                    className={`flex flex-col items-center text-center gap-1 rounded-xl border-2 p-3 transition-all ${
                      active ? 'border-[#E8670A] bg-orange-50' : 'border-gray-200 hover:border-[#E8670A]/50 bg-white'
                    }`}>
                    <span className="text-xl">{opt.icon}</span>
                    <span className={`text-xs font-semibold ${active ? 'text-[#E8670A]' : 'text-gray-800'}`}>{opt.title}</span>
                    <span className="text-[11px] text-gray-500">{opt.subtitle}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">
              Injuries/limitations &amp; program direction <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <p className="text-[11px] text-gray-400 mb-1">
              Note any injuries or physical limitations, plus how you want this program structured —
              Katie factors both into the plan she builds.
            </p>
            <textarea rows={3} value={genForm.injuries} onChange={e => setGenForm(f => ({ ...f, injuries: e.target.value }))}
              placeholder="e.g. Bad left knee, lower back pain — favor unilateral work over back squats, keep it strength-focused with minimal cardio"
              className={`${inputCls} resize-none`} />
          </div>
          {genError && <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{genError}</div>}
          <button type="submit" disabled={generating || !genForm.goals.length || !genForm.supersets || !genForm.circuits}
            className="w-full bg-[#E8670A] text-white py-3 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2">
            {generating
              ? <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Katie is building the program…</>
              : 'Generate Workout Program'}
          </button>
        </form>
      </div>
    )
  }

  // ── Workout list view ──────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm text-gray-500">
            {loading ? 'Loading…' : `${workouts.length} program${workouts.length !== 1 ? 's' : ''}`}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => { setGenFlow('questionnaire'); setShowCreate(false) }}
              className="bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
            >
              ✨ Generate with Katie
            </button>
            <button
              onClick={() => setShowCreate(c => !c)}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              {showCreate ? 'Cancel' : '+ Manual'}
            </button>
          </div>
        </div>

        {showCreate && (
          <form onSubmit={createWorkout} className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <p className="text-sm font-semibold text-gray-700">New Program (Manual)</p>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Program Name *</label>
              <input value={createName} onChange={e => setCreateName(e.target.value)} required
                placeholder="e.g. Week 1 — Full Body Strength" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Description / Coach Notes</label>
              <textarea rows={2} value={createDesc} onChange={e => setCreateDesc(e.target.value)}
                placeholder="Program overview, focus, client-specific notes…"
                className={`${inputCls} resize-none`} />
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <button type="submit" disabled={creating || !createName.trim()}
              className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
              {creating ? 'Creating…' : 'Create Program'}
            </button>
          </form>
        )}

        {loading ? null : workouts.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
            <p className="text-3xl mb-2">💪</p>
            <p className="text-sm font-semibold text-gray-700 mb-1">No programs yet</p>
            <p className="text-xs text-gray-400 mb-4">Generate a workout program with Katie, or create one manually.</p>
            <button onClick={() => setGenFlow('questionnaire')}
              className="bg-[#E8670A] text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors">
              ✨ Generate with Katie
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {workouts.map(w => (
              <button key={w.id} onClick={() => openWorkout(w)}
                className="w-full text-left bg-white rounded-xl border border-gray-200 p-4 hover:border-[#E8670A] hover:shadow-sm transition-all">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-gray-900">{w.name}</p>
                      {w.status === 'draft' && (
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                          Draft
                        </span>
                      )}
                    </div>
                    {w.description && (
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{w.description}</p>
                    )}
                    <div className="flex gap-3 mt-1.5 text-xs text-gray-400 flex-wrap">
                      <span>{w.day_count ?? 0} days</span>
                      <span>{w.exercise_count ?? 0} exercises</span>
                      {w.log_count > 0 && (
                        <span className="text-green-600 font-medium">{w.log_count} logged</span>
                      )}
                      {w.status === 'draft' && (
                        <span className="text-amber-600">Not visible to client</span>
                      )}
                    </div>
                  </div>
                  <span className="text-gray-300 shrink-0">›</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Workout detail / edit view ─────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <button onClick={() => { setSelected(null); setError(null) }} className="text-xs text-gray-400 hover:text-gray-600 mb-2 flex items-center gap-1">
          ← All Programs
        </button>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-lg font-bold text-gray-900">{selected.name}</p>
              {selected.status === 'draft' && (
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                  Draft — not visible to client
                </span>
              )}
            </div>
            {selected.description && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-3">{selected.description}</p>
            )}
          </div>
          <div className="flex gap-2 flex-wrap shrink-0">
            {selected.status === 'draft' && (
              <button
                onClick={assignDraft}
                disabled={assigningDraft}
                className="bg-[#E8670A] text-white px-3 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors min-h-[36px]"
              >
                {assigningDraft ? 'Assigning…' : 'Assign to Client'}
              </button>
            )}
            {Object.keys(days).length > 0 && (
              <button
                onClick={() => setScheduling(true)}
                className="bg-[#0F1E35] text-white px-3 py-2 rounded-lg text-xs font-semibold hover:bg-[#1b2f52] transition-colors min-h-[36px] flex items-center gap-1"
              >
                📅 Schedule
              </button>
            )}
            <button
              onClick={() => setShowAddEx(a => !a)}
              className="bg-[#E8670A] text-white px-3 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09] transition-colors min-h-[36px]"
            >
              {showAddEx ? 'Cancel' : '+ Add Exercise'}
            </button>
            <button
              onClick={deleteWorkout}
              className="px-3 py-2 rounded-lg text-xs font-medium text-red-400 border border-red-100 hover:bg-red-50 transition-colors min-h-[36px]"
            >
              {selected.status === 'draft' ? 'Discard Draft' : 'Delete Program'}
            </button>
          </div>
        </div>
      </div>
      {error && (
        <p className="text-xs text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
      )}
      {scheduleSuccess && (
        <div className="flex items-start justify-between gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          <span className="flex items-center gap-1.5"><span>✓</span>{scheduleSuccess}</span>
          <button onClick={() => setScheduleSuccess(null)} className="text-green-500 hover:text-green-700 leading-none shrink-0">✕</button>
        </div>
      )}

      {/* Schedule modal */}
      {scheduling && (
        <ScheduleWorkoutModal
          clientId={clientId}
          workout={selected}
          dayLabels={Object.keys(days)}
          getToken={getToken}
          onClose={() => setScheduling(false)}
          onScheduled={(count) => {
            setScheduling(false)
            setScheduleSuccess(`Scheduled ${count} workout day${count !== 1 ? 's' : ''} onto the client's calendar.`)
            setTimeout(() => setScheduleSuccess(null), 6000)
          }}
        />
      )}

      {/* Add exercise form */}
      {showAddEx && (
        <form onSubmit={addExercise} className="bg-orange-50 border border-orange-200 rounded-xl p-4 space-y-3">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Add Exercise</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Day / Session</label>
              {(() => {
                const dayKeys = Object.keys(days)
                const nextDay = `Day ${dayKeys.length + 1}`
                const dayOptions = dayKeys.includes(nextDay) ? dayKeys : [...dayKeys, nextDay]
                return (
                  <select value={exForm.day || nextDay} onChange={e => setExForm(f => ({ ...f, day: e.target.value }))}
                    className={inputCls}>
                    {dayOptions.map(d => (
                      <option key={d} value={d}>{formatDayLabel(d)}{!dayKeys.includes(d) ? ' (new)' : ''}</option>
                    ))}
                  </select>
                )
              })()}
            </div>
            <div className="col-span-2 sm:col-span-1 relative">
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">
                Exercise Name * <span className="text-gray-400 font-normal normal-case">(search library or type custom)</span>
              </label>
              <input
                value={exForm.exercise_name}
                onChange={e => {
                  const val = e.target.value
                  setExForm(f => ({ ...f, exercise_name: val, exercise_id: null }))
                  setExSuggestOpen(true)
                  searchExercises(val, exPatternFilter)
                }}
                onFocus={() => { if (exSuggestions.length) setExSuggestOpen(true) }}
                onBlur={() => setTimeout(() => setExSuggestOpen(false), 150)}
                required placeholder="e.g. Barbell Back Squat" className={inputCls} autoComplete="off"
              />
              {exForm.exercise_id && (
                <span className="text-[10px] text-green-600 font-medium">✓ Linked to exercise library</span>
              )}
              {exSuggestOpen && exSuggestions.length > 0 && (
                <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                  {exSuggestions.map(sug => (
                    <button key={sug.id} type="button" onMouseDown={() => pickSuggestedExercise(sug)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-orange-50 transition-colors flex items-center justify-between gap-2 border-b border-gray-50 last:border-0">
                      <span className="font-medium text-gray-800">{sug.name}</span>
                      <span className="shrink-0 text-[10px] text-gray-400">
                        {MOVEMENT_PATTERNS.find(p => p.id === sug.movement_pattern)?.label ?? sug.movement_pattern}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Filter by Pattern</label>
              <select value={exPatternFilter}
                onChange={e => { setExPatternFilter(e.target.value); searchExercises(exForm.exercise_name, e.target.value); setExSuggestOpen(true) }}
                className={inputCls}>
                <option value="">All patterns</option>
                {MOVEMENT_PATTERNS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Sets</label>
              <input type="number" min="0" value={exForm.sets} onChange={e => setExForm(f => ({ ...f, sets: e.target.value }))}
                placeholder="3" className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Reps</label>
              <input value={exForm.reps} onChange={e => setExForm(f => ({ ...f, reps: e.target.value }))}
                placeholder="8-10" className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Weight / Load</label>
              <input value={exForm.weight} onChange={e => setExForm(f => ({ ...f, weight: e.target.value }))}
                placeholder="135 lbs" className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Rest (seconds)</label>
              <input type="number" min="0" value={exForm.rest_seconds} onChange={e => setExForm(f => ({ ...f, rest_seconds: e.target.value }))}
                placeholder="90" className={inputCls} />
            </div>
            <div className="col-span-2 sm:col-span-3">
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Exercise Instructions / Notes</label>
              <input value={exForm.notes} onChange={e => setExForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Focus on chest-to-bar, pause 1s at bottom…" className={inputCls} />
            </div>
          </div>
          <button type="submit" disabled={addingEx || !exForm.exercise_name.trim()}
            className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {addingEx ? 'Adding…' : 'Add Exercise'}
          </button>
        </form>
      )}

      {detailLoad && <p className="text-sm text-gray-400 text-center py-6">Loading…</p>}

      {/* Exercise table grouped by day */}
      {!detailLoad && Object.entries(days).map(([dayName, exs]) => (
        <div key={dayName} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-[#0F1E35] px-4 py-2.5 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">{formatDayLabel(dayName)}</p>
            <span className="text-[10px] text-white/50">{exs.length} exercise{exs.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[580px]">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-gray-500">Exercise</th>
                  <th className="text-center px-2 py-2 font-semibold text-gray-500 w-14">Sets</th>
                  <th className="text-center px-2 py-2 font-semibold text-gray-500 w-20">Reps</th>
                  <th className="text-center px-2 py-2 font-semibold text-gray-500 w-24">Weight</th>
                  <th className="text-center px-2 py-2 font-semibold text-gray-500 w-16">Rest</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-500">Instructions</th>
                  <th className="w-12 text-center px-1 py-2 font-semibold text-gray-400 text-[10px]">Order</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {exs.map((ex, exIdx) => {
                  const isFirst = exIdx === 0
                  const isLast  = exIdx === exs.length - 1
                  function cell(field, val, type = 'text', placeholder = '—') {
                    const isEditing = editCell?.exId === ex.id && editCell?.field === field
                    return isEditing ? (
                      <input
                        autoFocus
                        type={type}
                        value={editVal}
                        onChange={e => setEditVal(e.target.value)}
                        onBlur={() => saveEdit(ex.id, field)}
                        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') cancelEdit() }}
                        className="w-full border border-[#E8670A] rounded px-1.5 py-0.5 text-xs focus:outline-none bg-orange-50"
                        placeholder={placeholder}
                      />
                    ) : (
                      <span
                        onClick={() => startEdit(ex.id, field, val)}
                        title="Click to edit"
                        className="cursor-pointer hover:text-[#E8670A] transition-colors"
                      >
                        {val ?? <span className="text-gray-300">—</span>}
                      </span>
                    )
                  }
                  return (
                    <tr key={ex.id} className="hover:bg-gray-50/40">
                      <td className="px-3 py-2.5 font-medium text-gray-900">
                        <div className="flex items-center gap-2">
                          <ExerciseThumb src={ex.image_url} alt={ex.exercise_name} />
                          {cell('exercise_name', ex.exercise_name)}
                        </div>
                      </td>
                      <td className="px-2 py-2.5 text-center text-gray-600">
                        {cell('sets', ex.sets, 'number', '3')}
                      </td>
                      <td className="px-2 py-2.5 text-center text-gray-600">
                        {cell('reps', ex.reps, 'text', '8-10')}
                      </td>
                      <td className="px-2 py-2.5 text-center text-gray-600">
                        {cell('weight', ex.weight, 'text', '135 lbs')}
                      </td>
                      <td className="px-2 py-2.5 text-center text-gray-500">
                        {cell('rest_seconds', ex.rest_seconds, 'number', '90')}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 max-w-[200px]">
                        {cell('notes', ex.notes, 'text', 'Instructions…')}
                      </td>
                      {/* ↑ / ↓ reorder buttons */}
                      <td className="px-1 py-2.5 text-center w-12">
                        <div className="flex flex-col items-center gap-0.5">
                          <button
                            onClick={() => moveExercise(ex.id, 'up')}
                            disabled={isFirst}
                            title="Move up"
                            className="text-gray-300 hover:text-[#E8670A] disabled:opacity-20 disabled:cursor-not-allowed transition-colors text-xs leading-none px-1 py-0.5 min-h-[20px]"
                          >▲</button>
                          <button
                            onClick={() => moveExercise(ex.id, 'down')}
                            disabled={isLast}
                            title="Move down"
                            className="text-gray-300 hover:text-[#E8670A] disabled:opacity-20 disabled:cursor-not-allowed transition-colors text-xs leading-none px-1 py-0.5 min-h-[20px]"
                          >▼</button>
                        </div>
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        <button
                          onClick={() => deleteExercise(ex.id, ex.exercise_name)}
                          className="text-gray-300 hover:text-red-400 transition-colors font-bold text-sm"
                          title="Remove exercise"
                        >✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {cellSaving && <p className="text-[10px] text-gray-400 px-3 py-1">Saving…</p>}
        </div>
      ))}

      {!detailLoad && exercises.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-6 bg-white rounded-xl border border-gray-200">
          No exercises yet. Click "+ Add Exercise" to build this program.
        </p>
      )}

      {/* Recent logs */}
      {logs.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Client Workout Log</p>
          <div className="space-y-1.5">
            {logs.map((log, i) => (
              <div key={i} className="flex items-center gap-2 bg-white rounded-lg border border-gray-100 px-3 py-2">
                <span className="text-green-500 text-sm">✓</span>
                <p className="text-xs text-gray-500">
                  {new Date(log.completed_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </p>
                {log.notes && <p className="text-xs text-gray-600 ml-1 truncate">{log.notes}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main ClientProfile shell ─────────────────────────────────────────────────

export default function ClientProfile() {
  const { getToken } = useAuth()
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [client, setClient] = useState(null)
  const [meRole, setMeRole] = useState(null)
  const [meId, setMeId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('overview')
  const [moreOpen, setMoreOpen] = useState(false)
  const [unreadMsg, setUnreadMsg] = useState(0)

  useEffect(() => {
    const requestedTab = searchParams.get('tab')
    if (requestedTab && TABS.some(t => t.id === requestedTab)) setTab(requestedTab)
  }, [searchParams])

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const [meRes, cRes] = await Promise.all([
          fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_URL}/api/coach-admin/clients/${id}`, { headers: { Authorization: `Bearer ${token}` } }),
        ])
        if (meRes.ok) {
          const me = await meRes.json()
          setMeRole(me.role)
          setMeId(me.id ?? null)
        }
        if (cRes.status === 403) { navigate('/dashboard', { replace: true }); return }
        if (!cRes.ok) throw new Error(`Server ${cRes.status}`)
        setClient(await cRes.json())
      } catch (err) { setError(err.message) } finally { setLoading(false) }
    }
    load()
  }, [id, getToken, navigate])

  useEffect(() => {
    if (!id) return
    async function fetchUnread() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}/messages/unread`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) { const d = await res.json(); setUnreadMsg(d.unread ?? 0) }
      } catch { /* silent */ }
    }
    fetchUnread()
  }, [id, getToken])

  if (loading) return <p className="text-center text-gray-400 py-12 text-sm">Loading client…</p>
  if (error)   return <p className="text-center text-red-500 py-8 text-sm">{error}</p>
  if (!client) return null

  return (
    <div className="max-w-5xl">
      {/* Back link */}
      <button onClick={() => navigate('/admin/clients')} className="text-sm text-[#E8670A] hover:text-[#c45e09] font-medium mb-3 inline-flex items-center gap-1">
        ← Back to clients
      </button>

      {/* Header */}
      <div className="mb-3">
        <h1 className="text-2xl font-bold text-gray-900">
          {[client.display_first_name || client.first_name, client.display_last_name || client.last_name].filter(Boolean).join(' ') || client.email?.split('@')[0] || 'Client'}
        </h1>
        <p className="text-sm text-gray-500">{client.email}</p>
      </div>

      {/* ── Client snapshot bar ── */}
      {(() => {
        const statusTag  = computeClientStatusTag(client)
        const tagStyle   = statusTagStyle(statusTag)
        const coachLabel = client.assigned_coach_name || client.assigned_coach_email || '—'
        const typeLabel  = client.coaching_type === 'vip' ? 'VIP'
          : client.coaching_type === 'ai' ? 'AI'
          : client.coaching_type
            ? client.coaching_type.charAt(0).toUpperCase() + client.coaching_type.slice(1)
            : '—'
        const effStart   = client.effective_start_date || client.start_date
        const startLabel = effStart ? fmtDate(effStart) : '—'
        const rawDays    = effStart ? daysSince(effStart) : null
        const daysLabel  = rawDays != null ? `${Math.max(0, rawDays)} days` : '—'

        function Chip({ label, value }) {
          return (
            <div className="flex flex-col gap-0.5 rounded-lg border px-3 py-2 bg-gray-50 border-gray-200">
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide leading-none">{label}</span>
              <span className="text-sm font-semibold leading-snug text-gray-900">{value}</span>
            </div>
          )
        }

        return (
          <div className="flex flex-wrap gap-2 mb-5">
            <div className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2 ${tagStyle}`}>
              <span className="text-[10px] font-semibold uppercase tracking-wide leading-none opacity-60">Status</span>
              <span className="text-sm font-semibold leading-snug">{statusTag}</span>
            </div>
            <Chip label="Coach"   value={coachLabel} />
            <Chip label="Type"    value={typeLabel} />
            <Chip label="Started" value={startLabel} />
            <Chip label="Active"  value={daysLabel} />
          </div>
        )
      })()}

      {/* Tabs — primary tabs scroll on mobile; More button sits outside overflow so its dropdown isn't clipped */}
      <div className="border-b border-gray-200 mb-5 flex items-stretch">
        <div className="flex-1 overflow-x-auto min-w-0">
          <div className="flex gap-1">
            {PRIMARY_TABS.map(t => (
              <button key={t.id} onClick={() => {
                setTab(t.id)
                if (t.id === 'messaging') setUnreadMsg(0)
                setMoreOpen(false)
                const next = new URLSearchParams(searchParams)
                if (t.id === 'overview') next.delete('tab')
                else next.set('tab', t.id)
                setSearchParams(next, { replace: true })
              }}
                className={`relative px-3 sm:px-4 py-2.5 text-xs sm:text-sm font-semibold transition-colors border-b-2 whitespace-nowrap ${
                  tab === t.id
                    ? 'border-[#E8670A] text-[#E8670A]'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}>
                <span className="mr-1">{t.icon}</span>{t.label}
                {t.id === 'messaging' && unreadMsg > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
                    {unreadMsg > 9 ? '9+' : unreadMsg}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
        {/* More button is a flex sibling — NOT inside overflow-x-auto — so dropdown escapes clipping */}
        <div className="relative shrink-0">
          <button
            onClick={() => setMoreOpen(o => !o)}
            className={`px-3 sm:px-4 py-2.5 text-xs sm:text-sm font-semibold transition-colors border-b-2 whitespace-nowrap ${
              MORE_TABS.some(t => t.id === tab)
                ? 'border-[#E8670A] text-[#E8670A]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {MORE_TABS.some(t => t.id === tab)
              ? <><span className="mr-1">{MORE_TABS.find(t2 => t2.id === tab)?.icon}</span>{MORE_TABS.find(t2 => t2.id === tab)?.label} ▾</>
              : 'More ▾'}
          </button>
          {moreOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
              <div className="absolute right-0 top-full mt-0.5 bg-white border border-gray-200 rounded-lg shadow-lg z-20 min-w-[160px]">
                {MORE_TABS.map(t => (
                  <button key={t.id} onClick={() => {
                    setTab(t.id)
                    setMoreOpen(false)
                    const next = new URLSearchParams(searchParams)
                    next.set('tab', t.id)
                    setSearchParams(next, { replace: true })
                  }}
                    className={`flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-left transition-colors first:rounded-t-lg last:rounded-b-lg ${
                      tab === t.id ? 'text-[#E8670A] bg-orange-50' : 'text-gray-700 hover:bg-gray-50'
                    }`}>
                    <span>{t.icon}</span>{t.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'overview'   && <OverviewTab    client={client} role={meRole} getToken={getToken} onUpdate={u => setClient(c => ({ ...c, ...u }))} />}
      {tab === 'nutrition'  && <NutritionTab   client={client} clientId={client.id} getToken={getToken} onUpdate={u => setClient(c => ({ ...c, ...u }))} />}
      {tab === 'habits'     && <CalendarTab    clientId={client.id} getToken={getToken} />}
      {tab === 'progress'   && <ProgressTab    clientId={client.id} getToken={getToken} role={meRole} clientName={[client.display_first_name || client.first_name, client.display_last_name || client.last_name].filter(Boolean).join(' ') || client.email?.split('@')[0] || null} />}
      {tab === 'assessment' && <AssessmentTab  clientId={client.id} getToken={getToken} />}
      {tab === 'notes'      && <NotesTab       clientId={client.id} role={meRole} getToken={getToken} />}
      {tab === 'messaging'  && <MessagingTab   client={client} role={meRole} meId={meId} getToken={getToken} />}
      {tab === 'engagement' && <EngagementTab  clientId={client.id} getToken={getToken} />}
      {tab === 'bloodwork'  && <BloodworkTab   clientId={client.id} getToken={getToken} bloodworkEnabled={client.bloodwork_enabled ?? false} onClientUpdate={u => setClient(c => ({ ...c, ...u }))} client={client} />}
      {tab === 'workouts'   && <WorkoutsTab    clientId={client.id} clientFirstName={client.display_first_name || client.first_name} getToken={getToken} />}
    </div>
  )
}
