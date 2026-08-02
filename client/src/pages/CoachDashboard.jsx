// CoachDashboard.jsx — unified staff dashboard
// Rendered at /dashboard for admin/coach roles.
// /admin/clients and /admin both redirect here.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { API_URL } from '../config.js'
import { useOrgBranding } from '../context/OrgBrandingContext.jsx'
import FoodSourceBadge from '../components/FoodSourceBadge.jsx'
import StaffInbox from '../components/StaffInbox.jsx'

// ── Constants ─────────────────────────────────────────────────────────────────

const SERVING_UNITS = ['g', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'ml', 'fl oz']

const COACHING_TYPE_BADGE = {
  vip:    'bg-orange-50 text-[#E8670A] border-orange-200',
  basic:  'bg-gray-50 text-gray-600 border-gray-200',
  hybrid: 'bg-purple-50 text-purple-700 border-purple-200',
}

// 'ai' was consolidated into 'hybrid'. Nothing writes 'ai' anymore, but any
// legacy row still needs to read back as the tier it now behaves as — so every
// display and filter path funnels through here rather than comparing raw values.
function normalizeCoachingType(type) {
  if (type === 'ai') return 'hybrid'
  return type || 'vip'
}

const STATUS_STYLES = {
  'Consistent':          'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Building Momentum':   'bg-blue-50 text-blue-700 border-blue-200',
  'Rebuilding Momentum': 'bg-amber-50 text-amber-700 border-amber-200',
  'Needs Attention':     'bg-orange-50 text-[#E8670A] border-orange-200',
  'New Client':          'bg-gray-50 text-gray-600 border-gray-200',
  'Invited':             'bg-purple-50 text-purple-700 border-purple-200',
}

// Sort order for the Momentum column — best momentum first when sorted ascending.
const MOMENTUM_RANK = {
  'Consistent':          0,
  'Building Momentum':   1,
  'Rebuilding Momentum': 2,
  'Needs Attention':     3,
  'New Client':          4,
  'Invited':             5,
}

const EMPTY_INVITE = {
  first_name: '', last_name: '', email: '',
  coaching_type: 'vip', assigned_coach_id: '', notes: '',
}

const EMPTY_FOOD_FORM = {
  food_name: '', calories: '', protein: '', carbs: '', fat: '', fiber: '',
  sugar: '', sodium_mg: '',
  serving_size: '100', serving_unit: 'g', notes: '',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysSince(iso) {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso)) / 86400_000)
}

// Returns the ISO date string (YYYY-MM-DD) of the Monday for a given date.
// Weeks always start on Monday (ISO week convention).
function getMondayISO(d = new Date()) {
  const dt = new Date(d); dt.setHours(0, 0, 0, 0)
  const dow = dt.getDay() // 0 = Sunday
  dt.setDate(dt.getDate() - (dow === 0 ? 6 : dow - 1))
  return dt.toISOString().slice(0, 10)
}

function fmtShortDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// MM/DD/YYYY — used for client-facing date fields (last login, date of birth, etc.)
function fmtMDY(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
}

// Formats a DATE-only value (YYYY-MM-DD, no time component) as MM/DD/YYYY without
// going through `new Date()`, which parses bare dates as UTC midnight and can shift
// the displayed day by one depending on the browser's local timezone.
function fmtDateOnlyMDY(iso) {
  if (!iso) return null
  const s = String(iso).slice(0, 10)
  const [y, m, d] = s.split('-')
  if (!y || !m || !d) return s
  return `${m}/${d}/${y}`
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function clientName(c) {
  return [c.first_name, c.display_last_name].filter(Boolean).join(' ') || c.email || 'Unknown'
}

function coachingLabel(type) {
  const t = normalizeCoachingType(type)
  if (t === 'basic')  return 'Basic'
  if (t === 'hybrid') return 'Hybrid'
  return 'VIP'
}

function coachingBadge(type) {
  return COACHING_TYPE_BADGE[normalizeCoachingType(type)] ?? COACHING_TYPE_BADGE.vip
}

function lastActivityAt(c) {
  const dates = [c.last_checkin_at, c.last_meal_at, c.last_login_at]
    .filter(Boolean).map(d => new Date(d))
  if (!dates.length) return null
  return new Date(Math.max(...dates.map(d => d.getTime())))
}

function accountStatus(c) {
  if (c.client_status === 'pending_access') return 'pending_access'
  if (c.client_status === 'invited')     return 'invited'
  if (c.client_status === 'deactivated') return 'inactive'
  if (c.paid) return 'active'
  const last = lastActivityAt(c)
  if (!last) return 'inactive'
  return daysSince(last.toISOString()) > 14 ? 'inactive' : 'active'
}

function accountStatusLabel(c) {
  const s = accountStatus(c)
  if (s === 'pending_access') return 'Pending Access'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function accountStatusBadgeClass(c) {
  const s = accountStatus(c)
  if (s === 'active')  return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (s === 'invited') return 'bg-purple-50 text-purple-700 border-purple-200'
  if (s === 'pending_access') return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-gray-100 text-gray-600 border-gray-300'
}

function formatActivity(c) {
  const last = lastActivityAt(c)
  if (!last) return 'No activity yet'
  const d = daysSince(last.toISOString())
  const prefix = c.last_checkin_at &&
    new Date(c.last_checkin_at).getTime() === last.getTime() ? 'Check-in' : 'Activity'
  if (d === 0) return `${prefix} today`
  if (d === 1) return `${prefix} yesterday`
  return `${prefix} ${d}d ago`
}

// ── StatusBadge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES['New Client']
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${style}`}>
      {status}
    </span>
  )
}

// ── TagChip ──────────────────────────────────────────────────────────────────
// Single tag chip with optional delete button for inline display on client list.

function TagChip({ tag, onDelete, isEditingId, setEditingId }) {
  const displayName = tag.tag_name.charAt(0).toUpperCase() + tag.tag_name.slice(1)
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold bg-[#f97316] text-white whitespace-nowrap">
      {displayName}
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete(tag.tag_name); setEditingId(null) }}
          className="ml-0.5 text-white hover:opacity-75 transition-opacity focus:outline-none min-w-[20px] h-full flex items-center justify-center"
          aria-label={`Remove ${displayName} tag`}
          title="Remove tag"
        >
          ✕
        </button>
      )}
    </span>
  )
}

// ── RecentActivityRail ────────────────────────────────────────────────────────
// Compact activity feed used in both the right rail (desktop) and below tabs (mobile).

function RecentActivityRail({ loading, activity }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Recent Activity</p>
      </div>

      {loading && (
        <p className="text-xs text-gray-400 text-center py-6">Loading…</p>
      )}

      {!loading && activity.length === 0 && (
        <p className="text-xs text-gray-400 text-center py-6">No recent activity yet.</p>
      )}

      {!loading && activity.length > 0 && (
        <div className="divide-y divide-gray-100 overflow-y-auto max-h-[48vh]">
          {activity.map((event, idx) => (
            <Link
              key={`${event.type}-${event.client_id}-${event.occurred_at}-${idx}`}
              to={`/admin/clients/${event.client_id}`}
              className="flex items-start justify-between gap-2 px-3 py-1.5 hover:bg-orange-50/50 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-900 truncate leading-tight">{event.client_name}</p>
                <p className="text-[11px] text-gray-400 truncate leading-tight mt-0.5">{event.label}</p>
              </div>
              <p className="text-[10px] text-gray-400 shrink-0 mt-0.5 whitespace-nowrap">{fmtShortDate(event.occurred_at)}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Food & Macros tab ─────────────────────────────────────────────────────────

function MacroForm({ client, getToken, onSaved }) {
  const [form, setForm] = useState({
    goal_calories: client.goal_calories ?? '',
    goal_protein:  client.goal_protein  ?? '',
    goal_carbs:    client.goal_carbs    ?? '',
    goal_fat:      client.goal_fat      ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  function set(field, val) { setForm(f => ({ ...f, [field]: val })) }

  async function save() {
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/users/${client.id}/macros`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          goal_calories: form.goal_calories !== '' ? Number(form.goal_calories) : null,
          goal_protein:  form.goal_protein  !== '' ? Number(form.goal_protein)  : null,
          goal_carbs:    form.goal_carbs    !== '' ? Number(form.goal_carbs)    : null,
          goal_fat:      form.goal_fat      !== '' ? Number(form.goal_fat)      : null,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      onSaved(await res.json())
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="grid grid-cols-4 gap-2 mb-2">
        {[
          { field: 'goal_calories', label: 'Cal',     placeholder: '2000' },
          { field: 'goal_protein',  label: 'Protein', placeholder: '150'  },
          { field: 'goal_carbs',    label: 'Carbs',   placeholder: '150'  },
          { field: 'goal_fat',      label: 'Fat',     placeholder: '65'   },
        ].map(({ field, label, placeholder }) => (
          <div key={field}>
            <label className="block text-xs text-gray-500 mb-1">{label}</label>
            <input
              type="number" value={form[field]} onChange={e => set(field, e.target.value)}
              placeholder={placeholder}
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving}
          className="bg-[#E8670A] text-white px-4 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-40 transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => onSaved(null)} className="text-xs text-gray-500 hover:text-gray-700 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}

function AssessmentPanel({ clientId, getToken }) {
  const [data,    setData]    = useState(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/admin/assessments/${clientId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        setData(res.ok ? await res.json() : null)
      } catch { setData(null) } finally { setLoading(false) }
    }
    load()
  }, [clientId, getToken])

  if (loading) return <p className="text-xs text-gray-400 mt-3 pt-3 border-t border-gray-100">Loading assessment…</p>
  if (!data)   return <p className="text-xs text-gray-400 mt-3 pt-3 border-t border-gray-100">No assessment submitted yet.</p>

  function Rating({ value }) {
    if (!value) return <span className="text-gray-400">—</span>
    return (
      <span className="inline-flex gap-0.5">
        {[1,2,3,4,5].map(n => (
          <span key={n} className={`w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center ${
            n <= value ? 'bg-[#E8670A] text-white' : 'bg-gray-100 text-gray-300'
          }`}>{n}</span>
        ))}
      </span>
    )
  }

  function Row({ label, value }) {
    if (!value && value !== 0) return null
    return (
      <div className="flex gap-2">
        <span className="text-xs text-gray-400 shrink-0 w-32">{label}</span>
        <span className="text-xs text-gray-800 font-medium">{value}</span>
      </div>
    )
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 space-y-3">
      <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider">Contact &amp; Info</p>
      <div className="space-y-1">
        <Row label="Full name"    value={[data.first_name, data.last_name].filter(Boolean).join(' ') || null} />
        <Row label="Phone"        value={data.phone} />
        {(data.street_address || data.city || data.state) ? (
          <div className="flex gap-2">
            <span className="text-xs text-gray-400 shrink-0 w-32">Address</span>
            <div className="text-xs text-gray-800 font-medium">
              {data.street_address && <div>{data.street_address}</div>}
              <div>{[data.city, data.state].filter(Boolean).join(', ')}{data.zip_code ? ` ${data.zip_code}` : ''}</div>
              {data.country && data.country !== 'United States' && <div>{data.country}</div>}
            </div>
          </div>
        ) : <Row label="Address" value={data.address} />}
        <Row label="Date of birth" value={data.date_of_birth ? fmtDateOnlyMDY(data.date_of_birth) : null} />
        <Row label="Shirt size"    value={data.shirt_size} />
      </div>
      <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider">About You</p>
      <div className="space-y-1">
        <Row label="Occupation" value={data.occupation} />
        <Row label="Kids"       value={data.num_kids != null ? String(data.num_kids) : null} />
        <Row label="6-mo goals" value={data.goals_6_months} />
        <Row label="Supplements" value={data.supplements} />
        <Row label="Injuries"   value={data.injuries_limitations} />
      </div>
      <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider">Energy &amp; Lifestyle</p>
      <div className="space-y-1.5">
        {[
          ['Energy',       data.energy_level],
          ['Sleep quality', data.sleep_quality],
          ['Stress mgmt',  data.stress_management],
          ['Happiness',    data.happiness_level],
          ['Confidence',   data.confidence_level],
        ].map(([label, val]) => (
          <div key={label} className="flex gap-2 items-center">
            <span className="text-xs text-gray-400 shrink-0 w-32">{label}</span>
            <Rating value={val} />
          </div>
        ))}
        <Row label="Sleep hours"    value={data.sleep_hours} />
        <Row label="Daily water"    value={data.daily_water} />
        <Row label="Drinks weekday" value={data.alcohol_weekdays != null ? `${data.alcohol_weekdays}/day` : null} />
        <Row label="Drinks weekend" value={data.alcohol_weekends != null ? `${data.alcohol_weekends}/day` : null} />
        <Row label="Activity level" value={data.activity_level} />
      </div>
      {data.completed_at && (
        <p className="text-[10px] text-gray-400 pt-1">
          Completed {new Date(data.completed_at).toLocaleDateString()}
        </p>
      )}
    </div>
  )
}

function MacroClientRow({ client, getToken, onUpdate }) {
  const [editing,        setEditing]        = useState(false)
  const [assessmentOpen, setAssessmentOpen] = useState(false)
  const inactive = daysSince(client.last_meal_at)

  function handleSaved(updated) { if (updated) onUpdate(updated); setEditing(false) }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">
            {[client.first_name, client.display_last_name].filter(Boolean).join(' ') || client.email || 'Unknown'}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {inactive === null ? 'No meals logged' : inactive === 0 ? 'Logged today' : `Last log: ${inactive}d ago`}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500 shrink-0 flex-wrap justify-end">
          <span title="Calories">{client.goal_calories ? `${client.goal_calories} cal` : '—'}</span>
          <span title="Protein">{client.goal_protein  ? `${client.goal_protein}g P`   : '—'}</span>
          <span title="Carbs">{client.goal_carbs      ? `${client.goal_carbs}g C`     : '—'}</span>
          <span title="Fat">{client.goal_fat          ? `${client.goal_fat}g F`       : '—'}</span>
          <button onClick={() => { setEditing(e => !e); setAssessmentOpen(false) }}
            className="text-[#E8670A] hover:text-[#c45e09] font-medium transition-colors">
            {editing ? 'Close' : 'Set Macros'}
          </button>
          <button onClick={() => { setAssessmentOpen(o => !o); setEditing(false) }}
            className="text-[#E8670A] hover:text-[#c45e09] font-medium transition-colors">
            {assessmentOpen ? 'Close' : 'Assessment'}
          </button>
        </div>
      </div>
      {editing        && <MacroForm client={client} getToken={getToken} onSaved={handleSaved} />}
      {assessmentOpen && <AssessmentPanel clientId={client.id} getToken={getToken} />}
    </div>
  )
}

function FoodMacrosTab({ getToken }) {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        setClients(await res.json())
      } catch (err) { setError(err.message) } finally { setLoading(false) }
    }
    load()
  }, [getToken])

  function handleUpdate(updated) {
    setClients(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c))
  }

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">Loading clients…</p>
  if (error)   return <p className="text-sm text-red-500 py-4">{error}</p>
  if (!clients.length) return <p className="text-sm text-gray-400 py-8 text-center">No clients yet.</p>

  return (
    <div className="space-y-3">
      {clients.map(client => (
        <MacroClientRow key={client.id} client={client} getToken={getToken} onUpdate={handleUpdate} />
      ))}
    </div>
  )
}

// ── Coach Foods tab ───────────────────────────────────────────────────────────

function CoachFoodForm({ initialValues, onSave, onCancel, saving, saveErr }) {
  const [form, setForm] = useState(initialValues)
  function setF(e) { setForm(f => ({ ...f, [e.target.name]: e.target.value })) }

  function handleSubmit(e) {
    e.preventDefault()
    if (!form.food_name.trim()) return
    onSave({
      food_name:    form.food_name.trim(),
      calories:     form.calories     !== '' ? Number(form.calories)     : null,
      protein:      form.protein      !== '' ? Number(form.protein)      : null,
      carbs:        form.carbs        !== '' ? Number(form.carbs)        : null,
      fat:          form.fat          !== '' ? Number(form.fat)          : null,
      fiber:        form.fiber        !== '' ? Number(form.fiber)        : null,
      sugar:        form.sugar        !== '' ? Number(form.sugar)        : null,
      sodium_mg:    form.sodium_mg    !== '' ? Number(form.sodium_mg)    : null,
      serving_size: form.serving_size !== '' ? Number(form.serving_size) : 100,
      serving_unit: form.serving_unit || 'g',
      notes:        form.notes.trim() || null,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Food name *</label>
        <input name="food_name" value={form.food_name} onChange={setF} required
          placeholder="e.g. Grilled Chicken Breast"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {[
          ['Calories (per serving)', 'calories',  '120'],
          ['Protein g',             'protein',   '22' ],
          ['Carbs g',               'carbs',     '0'  ],
          ['Fat g',                 'fat',       '2.6'],
          ['Fiber g',               'fiber',     '0'  ],
          ['Sugar g',               'sugar',     '0'  ],
          ['Sodium mg',             'sodium_mg', '0'  ],
        ].map(([lbl, nm, ph]) => (
          <div key={nm}>
            <label className="block text-xs font-medium text-gray-600 mb-1">{lbl}</label>
            <input type="number" name={nm} value={form[nm]} onChange={setF} min="0" step="any" placeholder={ph}
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
        ))}
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Serving size &amp; unit</label>
        <div className="flex gap-2">
          <input type="number" name="serving_size" value={form.serving_size} onChange={setF}
            min="0.01" step="any" placeholder="100"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          <select name="serving_unit" value={form.serving_unit} onChange={setF}
            className="border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
            {SERVING_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <p className="text-[10px] text-gray-400 mt-0.5">Enter macros for the serving size above</p>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          Coach notes <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input name="notes" value={form.notes ?? ''} onChange={setF}
          placeholder="e.g. Great post-workout option"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
      </div>
      {saveErr && <p className="text-xs text-red-500">{saveErr}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving}
          className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel}
          className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">Cancel</button>
      </div>
    </form>
  )
}

function coachFoodMacroLine(food) {
  const ss   = food.serving_size ?? 100
  const cal  = ss > 0 ? Math.round((food.calories_per_serving ?? 0) / ss * 100) : Math.round(food.calories_per_serving ?? 0)
  const pro  = ss > 0 ? +((food.protein ?? 0) / ss * 100).toFixed(1) : +(food.protein ?? 0)
  const carb = ss > 0 ? +((food.carbs   ?? 0) / ss * 100).toFixed(1) : +(food.carbs   ?? 0)
  const fat  = ss > 0 ? +((food.fat     ?? 0) / ss * 100).toFixed(1) : +(food.fat     ?? 0)
  const unit = food.serving_unit === 'ml' ? 'ml' : 'g'
  return `${cal} cal · ${pro}g P · ${carb}g C · ${fat}g F per 100${unit}`
}

function coachFoodEditInitial(food) {
  return {
    food_name:    food.food_name,
    calories:     food.calories_per_serving != null ? String(food.calories_per_serving) : '',
    protein:      food.protein   != null ? String(food.protein)   : '',
    carbs:        food.carbs     != null ? String(food.carbs)     : '',
    fat:          food.fat       != null ? String(food.fat)       : '',
    fiber:        food.fiber     != null ? String(food.fiber)     : '',
    sugar:        food.sugar     != null ? String(food.sugar)     : '',
    sodium_mg:    food.sodium_mg != null ? String(food.sodium_mg) : '',
    serving_size: String(food.serving_size ?? 100),
    serving_unit: food.serving_unit || 'g',
    notes:        food.notes || '',
  }
}

function CoachFoodArchiveModal({ food, archiving, onConfirm, onCancel }) {
  if (!food) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-4 py-5">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-gray-200 p-4">
        <p className="text-sm font-semibold text-gray-900">Archive coach food?</p>
        <p className="text-sm text-gray-600 mt-2">
          "{food.food_name}" will be hidden from client food search, but preserved for existing logs.
        </p>
        <div className="mt-4 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={archiving}
            className="min-h-11 rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-60">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={archiving}
            className="min-h-11 rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-60">
            {archiving ? 'Archiving...' : 'Archive food'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CoachFoodCard({ food, editingId, editSaving, editErr, togglingId, archivingId,
                         onEditOpen, onSaveEdit, onCancelEdit, onToggle, onArchive }) {
  const isEditing   = editingId === food.id
  const borderClass = food.is_active !== false ? 'border-orange-200' : 'border-gray-200 opacity-60'
  const updatedAt   = food.updated_at
    ? new Date(food.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null

  return (
    <div className={`bg-white border rounded-xl px-4 py-3 ${borderClass}`}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900">{food.food_name}</p>
            {food.is_active !== false ? (
              <>
                <span className="inline-flex items-center rounded-full border border-orange-300 bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-[#E8670A]">
                  ⭐ LWC-Approved
                </span>
                <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                  Appears to clients as Coach Food
                </span>
              </>
            ) : (
              <span className="inline-flex items-center rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-500">
                Inactive
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{coachFoodMacroLine(food)}</p>
          {food.serving_size && food.serving_unit && (
            <p className="text-[11px] text-gray-400 mt-0.5">Serving: {food.serving_size}{food.serving_unit}</p>
          )}
          {food.notes && <p className="text-xs text-[#E8670A] mt-0.5 italic">"{food.notes}"</p>}
          <p className="text-[10px] text-gray-400 mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
            <span>Created by {food.created_by_name || 'Unknown'}</span>
            {updatedAt && <span>Last updated {updatedAt}</span>}
          </p>
        </div>
        <div className="flex flex-wrap sm:flex-col sm:items-end gap-2 shrink-0">
          <button onClick={() => onEditOpen(food.id, isEditing)}
            className="min-h-9 rounded-lg border border-orange-200 px-3 text-xs text-[#E8670A] hover:bg-orange-50 font-semibold transition-colors">
            {isEditing ? 'Cancel' : 'Edit'}
          </button>
          <button onClick={() => onToggle(food)} disabled={togglingId === food.id}
            className={`${food.is_active !== false ? 'hidden' : 'inline-flex items-center'} min-h-9 rounded-lg border border-gray-200 px-3 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors font-semibold`}>
            {togglingId === food.id ? '…' : 'Reactivate'}
          </button>
          <button onClick={() => onArchive(food)} disabled={archivingId === food.id}
            className={`${food.is_active === false ? 'hidden' : 'inline-flex items-center'} min-h-9 rounded-lg border border-red-200 px-3 text-xs text-red-500 hover:bg-red-50 disabled:opacity-40 transition-colors font-semibold`}>
            {archivingId === food.id ? 'Archiving...' : 'Archive'}
          </button>
        </div>
      </div>
      {isEditing && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <CoachFoodForm
            key={food.id}
            initialValues={coachFoodEditInitial(food)}
            onSave={data => onSaveEdit(food.id, data)}
            onCancel={onCancelEdit}
            saving={editSaving}
            saveErr={editErr}
          />
        </div>
      )}
    </div>
  )
}

// Sanity-checks a pending client-submitted food's stated calories against
// calories implied by its macros (protein*4 + carbs*4 + fat*9). Returns null
// when the food looks fine, or a short warning label to surface on its row.
function pendingFoodMacroWarning(food) {
  const cal  = food.calories_per_serving
  const pro  = food.protein
  const carb = food.carbs
  const fat  = food.fat

  const hasCal      = cal != null
  const calNonZero  = hasCal && Number(cal) !== 0
  const hasAnyMacro = (pro  != null && Number(pro)  !== 0)
                    || (carb != null && Number(carb) !== 0)
                    || (fat  != null && Number(fat)  !== 0)

  // Nothing entered at all — e.g. only a serving size with no calories/macros
  if (!hasCal && !hasAnyMacro) return 'Incomplete data'

  // One side has data, the other is entirely missing/zero
  if (calNonZero && !hasAnyMacro) return "Macros don't match calories"
  if (!calNonZero && hasAnyMacro) return "Macros don't match calories"

  if (calNonZero && hasAnyMacro) {
    const expected = (Number(pro) || 0) * 4 + (Number(carb) || 0) * 4 + (Number(fat) || 0) * 9
    const stated   = Number(cal)
    const variance = Math.abs(expected - stated) / stated
    if (variance > 0.15) return "Macros don't match calories"
  }

  return null
}

function CoachFoodsTab({ getToken, onCountChange }) {
  const [coachFoods,    setCoachFoods]    = useState([])
  const [loading,       setLoading]       = useState(true)
  const [showCreate,    setShowCreate]    = useState(false)
  const [createKey,     setCreateKey]     = useState(0)
  const [prefilledForm, setPrefilledForm] = useState(EMPTY_FOOD_FORM)
  const [saving,        setSaving]        = useState(false)
  const [saveErr,       setSaveErr]       = useState(null)
  const [searchQ,       setSearchQ]       = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching,     setSearching]     = useState(false)
  const [listQ,         setListQ]         = useState('')
  const [editingId,     setEditingId]     = useState(null)
  const [editSaving,    setEditSaving]    = useState(false)
  const [editErr,       setEditErr]       = useState(null)
  const [togglingId,    setTogglingId]    = useState(null)
  const [archivingId,   setArchivingId]   = useState(null)
  const [archiveFood,   setArchiveFood]   = useState(null)
  // ── Pending client foods ──────────────────────────────────────────────────
  const [pendingFoods,   setPendingFoods]   = useState([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const [reviewing,      setReviewing]      = useState(null) // { id, action }
  const debounceRef = useRef(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const headers = { Authorization: `Bearer ${token}` }
        const [r1, r2] = await Promise.all([
          fetch(`${API_URL}/api/admin/coach-foods`,                   { headers }),
          fetch(`${API_URL}/api/admin/client-foods?status=pending`,   { headers }),
        ])
        if (r1.ok) setCoachFoods(await r1.json())
        if (r2.ok) {
          const pending = await r2.json()
          setPendingFoods(pending)
          onCountChange?.(pending.length)
        }
      } finally { setLoading(false); setPendingLoading(false) }
    }
    load()
  }, [getToken])

  function handleSearch(e) {
    const val = e.target.value
    setSearchQ(val)
    clearTimeout(debounceRef.current)
    if (!val.trim()) { setSearchResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/foods/search?q=${encodeURIComponent(val.trim())}&limit=10`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (res.ok) setSearchResults(await res.json())
      } finally { setSearching(false) }
    }, 350)
  }

  function prefillFromFood(food) {
    setPrefilledForm({
      food_name:    food.name,
      calories:     food.calories  != null ? String(Math.round(food.calories))  : '',
      protein:      food.protein_g != null ? String(Number(food.protein_g))     : '',
      carbs:        food.carbs_g   != null ? String(Number(food.carbs_g))       : '',
      fat:          food.fat_g     != null ? String(Number(food.fat_g))         : '',
      fiber:        food.fiber_g   != null ? String(Number(food.fiber_g))       : '',
      serving_size: '100', serving_unit: 'g', notes: '',
    })
    setCreateKey(k => k + 1)
    setSearchQ(''); setSearchResults([]); setShowCreate(true)
  }

  async function createCoachFood(data) {
    setSaving(true); setSaveErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/coach-foods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed')
      const created = await res.json()
      setCoachFoods(prev =>
        [...prev, { ...created, is_active: true }].sort((a, b) => {
          if (Boolean(a.is_active) !== Boolean(b.is_active)) return a.is_active ? -1 : 1
          return a.food_name.localeCompare(b.food_name)
        })
      )
      setPrefilledForm(EMPTY_FOOD_FORM); setCreateKey(k => k + 1); setShowCreate(false)
    } catch (err) { setSaveErr(err.message) } finally { setSaving(false) }
  }

  async function saveEdit(id, data) {
    setEditSaving(true); setEditErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/coach-foods/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Save failed')
      setCoachFoods(prev => prev.map(f => f.id === id ? { ...f, ...body } : f))
      setEditingId(null)
    } catch (err) { setEditErr(err.message) } finally { setEditSaving(false) }
  }

  async function toggleActive(food) {
    setTogglingId(food.id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/coach-foods/${food.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_active: !food.is_active }),
      })
      if (res.ok) { const updated = await res.json(); setCoachFoods(prev => prev.map(f => f.id === food.id ? { ...f, ...updated } : f)) }
    } finally { setTogglingId(null) }
  }

  async function archiveCoachFood() {
    if (!archiveFood) return
    setArchivingId(archiveFood.id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/coach-foods/${archiveFood.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const updated = await res.json()
        setCoachFoods(prev => prev.map(f => f.id === archiveFood.id ? { ...f, ...updated } : f))
        setArchiveFood(null)
      }
    } finally { setArchivingId(null) }
  }

  async function approveFood(id) {
    setReviewing({ id, action: 'approve' })
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/client-foods/${id}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'approve' }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Approve failed')
      const { food } = await res.json()
      // Remove from pending queue
      setPendingFoods(prev => {
        const remaining = prev.filter(f => f.id !== id)
        onCountChange?.(remaining.length)
        return remaining
      })
      // Add the promoted food to the coach foods list
      setCoachFoods(prev =>
        [...prev, {
          id: food.id, food_name: food.food_name,
          calories_per_serving: food.calories_per_serving,
          protein: food.protein, carbs: food.carbs, fat: food.fat, fiber: food.fiber,
          serving_size: food.serving_size, serving_unit: food.serving_unit,
          notes: food.notes, is_active: food.is_active,
          created_at: food.created_at, updated_at: food.updated_at,
        }].sort((a, b) => {
          if (Boolean(a.is_active) !== Boolean(b.is_active)) return a.is_active ? -1 : 1
          return a.food_name.localeCompare(b.food_name)
        }),
      )
    } catch (err) { alert(err.message) } finally { setReviewing(null) }
  }

  async function dismissFood(id) {
    setReviewing({ id, action: 'dismiss' })
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/client-foods/${id}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'dismiss' }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Dismiss failed')
      setPendingFoods(prev => {
        const remaining = prev.filter(f => f.id !== id)
        onCountChange?.(remaining.length)
        return remaining
      })
    } catch (err) { alert(err.message) } finally { setReviewing(null) }
  }

  const activeFoods    = coachFoods.filter(f => f.is_active !== false)
  const inactiveFoods  = coachFoods.filter(f => f.is_active === false)
  const lq             = listQ.toLowerCase()
  const filteredActive   = listQ.trim() ? activeFoods.filter(f => f.food_name.toLowerCase().includes(lq))   : activeFoods
  const filteredInactive = listQ.trim() ? inactiveFoods.filter(f => f.food_name.toLowerCase().includes(lq)) : inactiveFoods

  const cardProps = {
    editingId, editSaving, editErr, togglingId, archivingId,
    onEditOpen:   (id, isOpen) => { setEditingId(isOpen ? null : id); setEditErr(null) },
    onSaveEdit:   saveEdit,
    onCancelEdit: () => { setEditingId(null); setEditErr(null) },
    onToggle:     toggleActive,
    onArchive:    food => setArchiveFood(food),
  }

  return (
    <div>
      <CoachFoodArchiveModal
        food={archiveFood} archiving={Boolean(archivingId)}
        onConfirm={archiveCoachFood} onCancel={() => setArchiveFood(null)}
      />

      {/* ── Pending Client Foods ── */}
      {(pendingLoading || pendingFoods.length > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl overflow-hidden mb-5">
          <div className="px-4 py-3 border-b border-amber-200 flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-amber-900">Pending Client Foods</span>
            {!pendingLoading && pendingFoods.length > 0 && (
              <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {pendingFoods.length}
              </span>
            )}
            <span className="text-xs text-amber-700">· Client-created foods waiting for admin review</span>
          </div>
          {pendingLoading ? (
            <p className="text-xs text-amber-500 px-4 py-3">Loading…</p>
          ) : (
            <div className="divide-y divide-amber-100">
              {pendingFoods.map(food => {
                const macroWarning = pendingFoodMacroWarning(food)
                return (
                <div key={food.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap sm:flex-nowrap">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{food.food_name}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {food.client_first_name ?? 'Client'}
                        {food.client_email ? ` · ${food.client_email}` : ''}
                        {' · '}
                        {new Date(food.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {[
                          food.calories_per_serving != null ? `${Math.round(food.calories_per_serving)} cal` : null,
                          food.protein != null ? `${Number(food.protein).toFixed(1)}g P` : null,
                          food.carbs   != null ? `${Number(food.carbs).toFixed(1)}g C`   : null,
                          food.fat     != null ? `${Number(food.fat).toFixed(1)}g F`     : null,
                          food.serving_size != null ? `per ${food.serving_size}${food.serving_unit ?? 'g'}` : null,
                        ].filter(Boolean).join(' · ')}
                      </p>
                      {macroWarning && (
                        <span
                          className={`inline-flex items-center gap-1 mt-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                            macroWarning === 'Incomplete data'
                              ? 'border-orange-300 bg-orange-50 text-orange-700'
                              : 'border-red-300 bg-red-50 text-red-700'
                          }`}
                        >
                          ⚠ {macroWarning}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0 mt-1 sm:mt-0">
                      <button
                        onClick={() => dismissFood(food.id)}
                        disabled={reviewing?.id === food.id}
                        className="min-h-[36px] px-3 rounded-lg text-xs font-semibold text-gray-600 border border-gray-200 hover:bg-gray-100 disabled:opacity-40 transition-colors"
                      >
                        {reviewing?.id === food.id && reviewing?.action === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
                      </button>
                      <button
                        onClick={() => approveFood(food.id)}
                        disabled={reviewing?.id === food.id}
                        className="min-h-[36px] px-3 rounded-lg text-xs font-semibold text-white bg-[#E8670A] hover:bg-[#c45e09] disabled:opacity-40 transition-colors"
                      >
                        {reviewing?.id === food.id && reviewing?.action === 'approve' ? 'Approving…' : 'Approve ⭐'}
                      </button>
                    </div>
                  </div>
                </div>
              )})}
            </div>
          )}
        </div>
      )}

      <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 mb-5 flex gap-2 items-start">
        <span className="text-lg shrink-0">⭐</span>
        <div>
          <p className="text-sm font-semibold text-[#E8670A]">LWC-Approved Coach Foods</p>
          <p className="text-xs text-orange-700 mt-0.5">
            Active Coach Foods appear at the top of every client's food search with an
            <strong> ⭐ LWC-Approved</strong> badge. Inactive foods are hidden but preserved.
          </p>
        </div>
      </div>
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Find &amp; promote an existing food</h3>
        <div className="relative">
          <input type="text" value={searchQ} onChange={handleSearch}
            placeholder="Search foods to promote as coach food…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          {searching && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">Searching…</span>}
        </div>
        {searchResults.length > 0 && (
          <div className="mt-2 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-52 overflow-y-auto">
            {searchResults.map((food, i) => (
              <button key={food.id ?? i} onClick={() => prefillFromFood(food)}
                className="w-full text-left px-3 py-2.5 hover:bg-orange-50 transition-colors">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-gray-900 truncate">{food.name}</p>
                  <FoodSourceBadge food={food} />
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {food.calories != null ? `${Math.round(food.calories)} cal` : ''}
                  {food.protein_g != null ? ` · ${Number(food.protein_g).toFixed(1)}g P` : ''} per 100g
                </p>
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-400 mt-2">Click a food to pre-fill the form below.</p>
      </div>
      <div className="bg-white border border-gray-200 rounded-xl mb-5 overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-50 transition-colors"
          onClick={() => setShowCreate(v => !v)}
        >
          <span>+ Create / add coach food</span>
          <span className="text-gray-400 text-lg">{showCreate ? '−' : '+'}</span>
        </button>
        {showCreate && (
          <div className="px-4 pb-4 border-t border-gray-100 pt-3">
            <CoachFoodForm
              key={createKey}
              initialValues={prefilledForm}
              onSave={createCoachFood}
              onCancel={() => { setShowCreate(false); setPrefilledForm(EMPTY_FOOD_FORM) }}
              saving={saving}
              saveErr={saveErr}
            />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-700">
          Coach Foods ({activeFoods.length} active{inactiveFoods.length > 0 ? `, ${inactiveFoods.length} inactive` : ''})
        </h3>
        <input type="text" value={listQ} onChange={e => setListQ(e.target.value)}
          placeholder="Filter by name…"
          className="w-full sm:w-64 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
      </div>
      {loading && <p className="text-sm text-gray-400 text-center py-6">Loading…</p>}
      {!loading && !coachFoods.length && (
        <div className="text-center py-8 text-sm text-gray-400">
          <p className="text-2xl mb-2">⭐</p>
          <p>No coach foods yet. Search above or create one to get started.</p>
        </div>
      )}
      <div className="space-y-2">
        {filteredActive.map(food => <CoachFoodCard key={food.id} food={food} {...cardProps} />)}
        {filteredInactive.length > 0 && (
          <>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider pt-2">Inactive</p>
            {filteredInactive.map(food => <CoachFoodCard key={food.id} food={food} {...cardProps} />)}
          </>
        )}
        {!loading && !(filteredActive.length + filteredInactive.length) && listQ && (
          <p className="text-sm text-gray-400 text-center py-4">No coach foods match "{listQ}"</p>
        )}
      </div>
    </div>
  )
}

// ── Admin Tools panel (admin only) ──────────────────────────────────────────

function StatusPill({ label, value }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold border ${
      value ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-500'
    }`}>
      {value ? '✓' : '✗'} {label}
    </span>
  )
}

// AdminToolsPanel: compact onboarding/assessment status checker + reset tool.
// Uses the already-loaded `clients` list so no extra fetch is needed.
// Admin-only: only rendered when isAdmin === true.
function AdminToolsPanel({ clients, getToken }) {
  const [resetting,   setResetting]   = useState({})  // { [id]: 'loading' | 'done' | null }
  const [overrides,   setOverrides]   = useState({})  // { [id]: { onboarding_complete, assessment_complete } }
  const [adminSearch, setAdminSearch] = useState('')

  async function resetFlags(clientId, opts) {
    setResetting(r => ({ ...r, [clientId]: 'loading' }))
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/users/${clientId}/dev-reset`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(opts),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Reset failed')
      const data = await res.json()
      setOverrides(o => ({ ...o, [clientId]: data.user }))
      setResetting(r => ({ ...r, [clientId]: 'done' }))
    } catch (err) {
      alert(`Reset failed: ${err.message}`)
      setResetting(r => ({ ...r, [clientId]: null }))
    }
  }

  const q = adminSearch.trim().toLowerCase()
  const rows = [...clients]
    .filter(c => !q || `${clientName(c)} ${c.email ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const aC = overrides[a.id] ?? a
      const bC = overrides[b.id] ?? b
      const aOk = Boolean(aC.onboarding_complete) && Boolean(aC.assessment_complete)
      const bOk = Boolean(bC.onboarding_complete) && Boolean(bC.assessment_complete)
      if (aOk !== bOk) return aOk ? 1 : -1       // incomplete first
      return clientName(a).localeCompare(clientName(b))
    })

  const incompleteCount = clients.filter(c => {
    const cur = overrides[c.id] ?? c
    return !cur.assessment_complete || !cur.onboarding_complete
  }).length

  return (
    <div className="space-y-4">

      {/* Warning banner */}
      <div className="flex gap-2.5 items-start bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
        <span className="text-base shrink-0 mt-0.5">⚠️</span>
        <div>
          <p className="text-xs font-bold text-amber-800">Admin Tools — Use with care</p>
          <p className="text-xs text-amber-700 mt-0.5">
            Resets <code className="bg-amber-100 rounded px-0.5">onboarding_complete</code> /
            {' '}<code className="bg-amber-100 rounded px-0.5">assessment_complete</code> flags only.
            No meals, logs, or data are deleted.
          </p>
        </div>
      </div>

      {/* How-to — collapsed by default */}
      <details className="bg-white border border-gray-200 rounded-xl overflow-hidden text-xs">
        <summary className="px-4 py-2.5 cursor-pointer font-semibold text-gray-600 hover:bg-gray-50
                            select-none list-none flex items-center justify-between">
          <span>How to test the assessment flow</span>
          <span className="text-gray-400 text-sm">▸</span>
        </summary>
        <ol className="px-4 pb-3 pt-1 text-gray-600 space-y-1 list-decimal list-inside leading-relaxed">
          <li>Find your own account and click <strong>Reset Assess</strong>.</li>
          <li>Click <strong>Test →</strong> — reloads the page and redirects you to health assessment.</li>
          <li>Complete the flow normally, then return here to reset again.</li>
        </ol>
      </details>

      {/* Client status table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-gray-900">Client Onboarding Status</p>
            <p className="text-xs mt-0.5">
              {incompleteCount > 0
                ? <span className="text-amber-600 font-medium">{incompleteCount} client{incompleteCount !== 1 ? 's' : ''} with incomplete setup</span>
                : <span className="text-emerald-600 font-medium">All clients fully onboarded ✓</span>
              }
            </p>
          </div>
          <input
            type="text"
            value={adminSearch}
            onChange={e => setAdminSearch(e.target.value)}
            placeholder="Filter by name or email…"
            className="w-full sm:w-52 border border-gray-200 rounded-lg px-3 py-1.5 text-xs
                       focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
        </div>

        {rows.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8">
            {adminSearch ? 'No clients match your search.' : 'No clients yet.'}
          </p>
        )}

        <div className="divide-y divide-gray-100">
          {rows.map(client => {
            const busy  = resetting[client.id] === 'loading'
            const done  = resetting[client.id] === 'done'
            const cur   = overrides[client.id] ?? client
            const allOk = Boolean(cur.onboarding_complete) && Boolean(cur.assessment_complete)

            return (
              <div key={client.id}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 ${allOk ? '' : 'bg-amber-50/40'}`}
              >
                {/* Name + email */}
                <div className="flex-1 min-w-[140px]">
                  <Link
                    to={`/admin/clients/${client.id}`}
                    onClick={e => e.stopPropagation()}
                    className="text-sm font-medium text-gray-900 hover:text-[#E8670A] truncate block leading-tight"
                  >
                    {clientName(client)}
                  </Link>
                  <p className="text-[11px] text-gray-400 truncate">{client.email}</p>
                </div>

                {/* Status pills */}
                <div className="flex gap-1 shrink-0">
                  <StatusPill label="Onboard" value={Boolean(cur.onboarding_complete)} />
                  <StatusPill label="Assess"  value={Boolean(cur.assessment_complete)} />
                </div>

                {/* Action buttons */}
                <div className="flex gap-1.5 shrink-0 flex-wrap">
                  {/* Assess-only reset: show when assessment is incomplete */}
                  {!cur.assessment_complete && (
                    <button
                      onClick={() => resetFlags(client.id, { reset_assessment: true })}
                      disabled={busy}
                      title="Reset assessment_complete — client will be redirected to health assessment on next login"
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md border border-yellow-300
                                 bg-yellow-50 text-yellow-700 hover:bg-yellow-100 disabled:opacity-40
                                 transition-colors min-h-[28px]"
                    >
                      {busy ? '…' : '↺ Assess'}
                    </button>
                  )}
                  {/* Both reset: show when onboarding or assessment is incomplete */}
                  {(!cur.onboarding_complete || !cur.assessment_complete) && (
                    <button
                      onClick={() => resetFlags(client.id, { reset_onboarding: true, reset_assessment: true })}
                      disabled={busy}
                      title="Reset both onboarding_complete and assessment_complete"
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md border border-red-200
                                 bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-40
                                 transition-colors min-h-[28px]"
                    >
                      {busy ? '…' : '↺ Both'}
                    </button>
                  )}
                  {/* Fully complete clients: offer assessment reset for testing */}
                  {allOk && !done && (
                    <button
                      onClick={() => resetFlags(client.id, { reset_assessment: true })}
                      disabled={busy}
                      title="Reset assessment to re-test the onboarding flow"
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md border border-gray-200
                                 text-gray-500 hover:bg-gray-50 disabled:opacity-40
                                 transition-colors min-h-[28px]"
                    >
                      {busy ? '…' : 'Reset Assess'}
                    </button>
                  )}
                  {/* Post-reset test button */}
                  {done && (
                    <button
                      onClick={() => window.location.replace('/dashboard')}
                      className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-[#E8670A] text-white
                                 hover:bg-[#c45e09] transition-colors min-h-[28px]"
                    >
                      Test →
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
// ── Pending Invite Row ────────────────────────────────────────────────────────

function PendingInviteRow({ invite, onResend, onCancel }) {
  const [copied,     setCopied]     = useState(false)
  const [resending,  setResending]  = useState(false)
  const [resentMsg,  setResentMsg]  = useState(null)
  const [cancelling, setCancelling] = useState(false)

  const name        = [invite.first_name, invite.last_name].filter(Boolean).join(' ') || invite.email
  const sentDaysAgo = Math.floor((Date.now() - new Date(invite.created_at)) / 86400_000)
  const daysLeft    = invite.expires_at
    ? Math.max(0, Math.ceil((new Date(invite.expires_at) - Date.now()) / 86400_000))
    : null
  const coachBadge  = coachingBadge(invite.coaching_type)
  const typeLabel   = coachingLabel(invite.coaching_type)

  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.invite_url)
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  async function resend() {
    setResending(true); setResentMsg(null)
    try {
      const result = await onResend()
      setResentMsg(result?.email_sent ? 'sent' : result?.email_note ?? 'Email not configured — copy link instead.')
    } catch { setResentMsg('Resend failed.') }
    finally { setResending(false) }
    setTimeout(() => setResentMsg(null), 5000)
  }

  async function cancel() {
    if (!confirm(`Cancel the invite for ${name}? The invite link will stop working.`)) return
    setCancelling(true)
    try { await onCancel() } catch { /* parent handles */ }
    finally { setCancelling(false) }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900">{name}</p>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${coachBadge}`}>
              {typeLabel}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{invite.email}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Sent {sentDaysAgo === 0 ? 'today' : `${sentDaysAgo}d ago`}
            {daysLeft !== null && (
              <span className={daysLeft <= 3 ? ' text-amber-600 font-medium' : ''}>
                {' '}· {daysLeft}d remaining
              </span>
            )}
            {invite.assigned_coach_name && ` · Coach: ${invite.assigned_coach_name}`}
          </p>
          {resentMsg && (
            <p className={`text-[11px] mt-1 font-medium ${resentMsg === 'sent' ? 'text-emerald-600' : 'text-amber-600'}`}>
              {resentMsg === 'sent' ? '✓ Email resent!' : `⚠ ${resentMsg}`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          <button onClick={copy}
            className="text-xs font-semibold text-purple-700 border border-purple-200 rounded-lg px-2.5 py-1.5 hover:bg-purple-50 transition-colors min-h-[36px]">
            {copied ? '✓ Copied' : 'Copy Link'}
          </button>
          <button onClick={resend} disabled={resending}
            className="text-xs font-semibold text-gray-600 border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 transition-colors disabled:opacity-40 min-h-[36px]">
            {resending ? '…' : 'Resend'}
          </button>
          <button onClick={cancel} disabled={cancelling}
            className="text-xs font-semibold text-red-400 border border-red-100 rounded-lg px-2.5 py-1.5 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-40 min-h-[36px]">
            {cancelling ? '…' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Invite Modal ──────────────────────────────────────────────────────────────

function InviteModal({ getToken, coaches = [], isVa = false, onClose, onSuccess }) {
  const { coachTitle } = useOrgBranding()
  const [form,       setForm]       = useState(EMPTY_INVITE)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState(null)
  const [isDeactivated, setIsDeactivated] = useState(false)
  const [result,     setResult]     = useState(null)
  const [copied,     setCopied]     = useState(false)

  // Only VIP clients get a human coach assignment — every other tier
  // (basic, hybrid, plus legacy 'ai') has assigned_coach_id forced to null
  // server-side, so the picker is disabled and cleared for them here.
  const isAI = form.coaching_type !== 'vip'

  function setF(e) {
    const { name, value } = e.target
    setForm(f => {
      const next = { ...f, [name]: value }
      if (name === 'coaching_type' && value !== 'vip') next.assigned_coach_id = ''
      return next
    })
  }

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError(null); setIsDeactivated(false)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/invite`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          first_name:        form.first_name.trim(),
          last_name:         form.last_name.trim()  || undefined,
          email:             form.email.trim(),
          coaching_type:     form.coaching_type || 'vip',
          assigned_coach_id: isAI ? null : (form.assigned_coach_id || undefined),
          notes:             form.notes.trim()   || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Invite failed.'); setIsDeactivated(!!data.is_deactivated); return }
      setResult(data)
    } catch { setError('Network error. Please try again.') }
    finally { setSaving(false) }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(result.invite_url)
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white'

  return (
    <div className="mobile-modal-backdrop" onClick={onClose}>
      <div className="mobile-modal-panel max-w-md p-6 overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#fff7ed] flex items-center justify-center text-[#E8670A] text-lg shrink-0">👤</div>
            <div>
              <p className="text-base font-bold text-gray-900">Add Client</p>
              <p className="text-xs text-gray-400">Send a secure sign-up link by email</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0 p-1">×</button>
        </div>

        {result ? (
          <div>
            <div className={`rounded-xl p-4 mb-4 border ${result.email_sent ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
              <p className={`text-sm font-semibold mb-1 ${result.email_sent ? 'text-emerald-800' : 'text-amber-800'}`}>
                {result.email_sent ? `✓ Invite sent to ${result.first_name}!` : `✓ Invite created for ${result.first_name}`}
              </p>
              {result.email_sent
                ? <p className="text-xs text-emerald-700">Email delivered to <strong>{form.email}</strong>.</p>
                : <p className="text-xs text-amber-700">Email not sent{result.email_note ? ` — ${result.email_note}` : '.'} Share the link below manually.</p>
              }
            </div>
            <div className="mb-5">
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Invite link</label>
              <div className="flex gap-2">
                <input readOnly value={result.invite_url}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-xs text-gray-700 bg-gray-50"
                  onClick={e => e.target.select()} />
                <button onClick={copyLink}
                  className="shrink-0 bg-[#E8670A] text-white px-3 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09] transition-colors min-w-[70px]">
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setResult(null); setForm(EMPTY_INVITE); setCopied(false) }}
                className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors">
                Add Another
              </button>
              <button onClick={onSuccess}
                className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors">
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">First name *</label>
                <input name="first_name" value={form.first_name} onChange={setF} required placeholder="Jane" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Last name</label>
                <input name="last_name" value={form.last_name} onChange={setF} placeholder="Smith" className={inputCls} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
              <input type="email" name="email" value={form.email} onChange={setF} required
                placeholder="jane@example.com" className={inputCls} />
              <p className="text-[10px] text-gray-400 mt-0.5">Client must sign up with this exact email.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Coaching type</label>
                <select name="coaching_type" value={form.coaching_type} onChange={setF} className={inputCls}>
                  <option value="vip">VIP</option>
                  <option value="basic">Basic</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </div>
              {!isVa && (
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isAI ? 'text-gray-400' : 'text-gray-600'}`}>Assign coach</label>
                  <select
                    name="assigned_coach_id"
                    value={form.assigned_coach_id}
                    onChange={setF}
                    disabled={isAI}
                    className={`${inputCls} ${isAI ? 'opacity-50 cursor-not-allowed bg-gray-100' : ''}`}
                  >
                    <option value="">Unassigned</option>
                    {coaches.map(c => (
                      <option key={c.id} value={String(c.id)}>{c.first_name || c.email}</option>
                    ))}
                  </select>
                  {isAI && (
                    <p className="text-[10px] text-gray-400 mt-0.5">AI clients work with {coachTitle} — no human coach assignment needed.</p>
                  )}
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Notes <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <textarea name="notes" value={form.notes} onChange={setF} rows={2}
                placeholder="e.g. Referred by John, interested in weight loss"
                className={`${inputCls} resize-none`} />
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
                <p className="text-xs text-red-700">{error}</p>
                {isDeactivated && (
                  <button type="button" onClick={onClose}
                    className="text-xs text-[#E8670A] underline mt-1 block">
                    View Deactivated Clients → Reactivate, then reinvite
                  </button>
                )}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose}
                className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors min-h-[44px]">
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-50 transition-colors min-h-[44px]">
                {saving ? 'Creating…' : 'Send Invite'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Client table sorting ──────────────────────────────────────────────────────

// Ascending comparator for a given column key. Callers negate for descending.
function compareClients(a, b, col) {
  switch (col) {
    case 'client':   return clientName(a).localeCompare(clientName(b))
    case 'type':     return coachingLabel(a.coaching_type).localeCompare(coachingLabel(b.coaching_type))
    case 'coach':    return (a.assigned_coach_name || '').localeCompare(b.assigned_coach_name || '')
    case 'activity': return (lastActivityAt(a)?.getTime() ?? 0) - (lastActivityAt(b)?.getTime() ?? 0)
    case 'login':    return (new Date(a.last_login_at   ?? 0).getTime()) - (new Date(b.last_login_at   ?? 0).getTime())
    case 'checkin':  return (new Date(a.last_checkin_at ?? 0).getTime()) - (new Date(b.last_checkin_at ?? 0).getTime())
    case 'momentum': return (MOMENTUM_RANK[a.status_tag] ?? 6) - (MOMENTUM_RANK[b.status_tag] ?? 6)
    case 'status':   return accountStatus(a).localeCompare(accountStatus(b))
    default:         return 0
  }
}

// Clickable <th> that toggles ascending/descending sort on the given column.
function SortHeader({ col, sortCol, sortDir, onSort, className = '', title, children }) {
  const active = sortCol === col
  return (
    <th
      onClick={() => onSort(col)}
      title={title}
      className={`text-left px-3 py-2 font-semibold cursor-pointer select-none hover:text-gray-700 transition-colors ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className={`text-[9px] ${active ? 'text-[#E8670A]' : 'text-gray-300'}`}>
          {active && sortDir === 'desc' ? '▼' : '▲'}
        </span>
      </span>
    </th>
  )
}

// ── Quick-message modal ───────────────────────────────────────────────────────
// Opens a client's conversation directly (via StaffInbox) without leaving the dashboard.

function MessageIconButton({ onClick, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Message client"
      aria-label="Message client"
      className={`inline-flex items-center justify-center min-w-[36px] min-h-[36px] rounded-lg text-gray-400 hover:text-[#E8670A] hover:bg-orange-50 transition-colors ${className}`}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    </button>
  )
}

function MessageClientModal({ client, getToken, role, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-0 sm:px-4 py-0 sm:py-6">
      <div className="w-full sm:max-w-4xl h-full sm:h-[80vh] sm:max-h-[720px] bg-white sm:rounded-xl shadow-xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <p className="text-sm font-semibold text-gray-900 truncate">Message {client.name}</p>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <StaffInbox getToken={getToken} role={role} focusClientId={client.id} focusClientName={client.name} />
        </div>
      </div>
    </div>
  )
}

// ── Bulk message modal ────────────────────────────────────────────────────────
// Sends one message to every selected client via POST /api/coach-admin/messages/bulk.

function BulkMessageModal({ clients, getToken, onClose, onSent }) {
  const [body,    setBody]    = useState('')
  const [sending, setSending] = useState(false)
  const [error,   setError]   = useState(null)

  async function handleSend() {
    if (!body.trim() || sending) return
    setSending(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/messages/bulk`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ client_ids: clients.map(c => c.id), message_body: body }),
      })
      if (res.ok) {
        const data = await res.json()
        onSent(data)
      } else {
        const err = await res.json().catch(() => ({}))
        setError(err.error ?? 'Could not send message')
      }
    } catch {
      setError('Could not send message')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-0 sm:px-4 py-0 sm:py-6">
      <div className="w-full sm:max-w-md bg-white sm:rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[92vh] sm:max-h-[80vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <p className="text-sm font-semibold text-gray-900 truncate">
            Send message to {clients.length} client{clients.length === 1 ? '' : 's'}
          </p>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
          <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-40 overflow-y-auto">
            {clients.map(c => (
              <p key={c.id} className="px-3 py-2 text-xs font-medium text-gray-700 truncate">{clientName(c)}</p>
            ))}
          </div>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Write your message..."
            rows={5}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm leading-5 focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
          />
        </div>
        <div className="border-t border-gray-100 px-4 py-3 flex justify-end shrink-0">
          <button
            onClick={handleSend}
            disabled={sending || !body.trim()}
            className="min-h-[44px] px-4 rounded-lg bg-[#E8670A] text-white text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 transition-colors"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main CoachDashboard ───────────────────────────────────────────────────────

export default function CoachDashboard({ getToken, userRole }) {
  const navigate                         = useNavigate()
  const [searchParams, setSearchParams]  = useSearchParams()

  // ── Data ────────────────────────────────────────────────────────────────────
  const [clients,            setClients]            = useState([])
  const [pendingFoodsCount,  setPendingFoodsCount]  = useState(0)
  const [checkins,       setCheckins]       = useState([])
  const [activity,       setActivity]       = useState([])
  const [dataLoading,    setDataLoading]    = useState(true)

  // ── Invites / coaches ───────────────────────────────────────────────────────
  const [coaches,        setCoaches]        = useState([])
  const [pendingInvites, setPendingInvites] = useState([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const [inviteOpen,     setInviteOpen]     = useState(false)
  const [isAdmin,        setIsAdmin]        = useState(userRole === 'admin' || userRole === 'account_owner')
  // 'va' — client onboarding/transition role. Can invite clients and view basic
  // info; cannot deactivate/reactivate, message, or reassign coaches. The
  // server enforces this independently (requireStaffOrVa) — these UI checks
  // just keep out-of-scope controls from being offered in the first place.
  const isVa = userRole === 'va'
  const [myUserId,       setMyUserId]       = useState(null) // this staff member's own db id
  const [messageClient,  setMessageClient]  = useState(null) // { id, name } — quick-message modal target

  // ── Bulk messaging ───────────────────────────────────────────────────────────
  const [selectedClientIds, setSelectedClientIds] = useState(() => new Set())
  const [bulkMessageOpen,   setBulkMessageOpen]    = useState(false)
  const [bulkToast,         setBulkToast]          = useState(null)

  // ── Tags ─────────────────────────────────────────────────────────────────────
  const [editingClientId,   setEditingClientId]    = useState(null) // which client's tags are being edited
  const [newTagInput,       setNewTagInput]        = useState('') // text being typed into new tag input
  const [tagError,          setTagError]           = useState(null)
  const [tagLoading,        setTagLoading]         = useState(false)

  // ── Filters ─────────────────────────────────────────────────────────────────
  const [clientSearch,   setClientSearch]   = useState('')
  const [coachFilter,    setCoachFilter]    = useState('all')
  const [typeFilter,     setTypeFilter]     = useState('all')
  const [statusFilter,   setStatusFilter]   = useState('active')
  const [checkinFilter,  setCheckinFilter]  = useState('all')
  const [weekFilter,     setWeekFilter]     = useState(() => getMondayISO())
  const [sortCol,        setSortCol]        = useState('activity')
  const [sortDir,        setSortDir]        = useState('desc')

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }
  const [repliedIds,     setRepliedIds]     = useState(() => new Set()) // optimistic checkin-replied toggles

  // ── Tag handlers ─────────────────────────────────────────────────────────────
  async function addTag(clientId) {
    const input = newTagInput.trim()
    if (!input) { setTagError('Tag cannot be empty'); return }
    if (input.length > 50) { setTagError('Tag must be 50 characters or less'); return }

    setTagLoading(true); setTagError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tag_name: input }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Failed to add tag')
      }
      // Update client's tags in state
      const newTag = await res.json()
      setClients(prev => prev.map(c => {
        if (c.id === clientId) {
          return { ...c, tags: [...(c.tags ?? []), newTag] }
        }
        return c
      }))
      setNewTagInput('')
      setEditingClientId(null)
    } catch (err) { setTagError(err.message) } finally { setTagLoading(false) }
  }

  async function removeTag(clientId, tagName) {
    setTagLoading(true); setTagError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/tags/${encodeURIComponent(tagName)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to remove tag')
      // Update client's tags in state
      setClients(prev => prev.map(c => {
        if (c.id === clientId) {
          return { ...c, tags: (c.tags ?? []).filter(t => t.tag_name !== tagName) }
        }
        return c
      }))
    } catch (err) { setTagError(err.message) } finally { setTagLoading(false) }
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('clients')

  // ── Auto-open invite on ?invite=1 ───────────────────────────────────────────
  useEffect(() => {
    if (searchParams.get('invite') === '1') {
      setInviteOpen(true)
      const p = new URLSearchParams(searchParams)
      p.delete('invite')
      setSearchParams(p, { replace: true })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load dashboard data ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }
        const [r1, r3, r4] = await Promise.all([
          fetch(`${API_URL}/api/coach-admin/clients?status=all`, { headers }),
          fetch(`${API_URL}/api/coach-admin/dashboard-summary`,  { headers }),
          fetch(`${API_URL}/api/users/me`,                       { headers }),
        ])
        if (!cancelled) {
          if (r1.ok) {
            const clientData = await r1.json()
            setClients(clientData)
            // Seed optimistic replied state from server's checkin_reviewed flag
            setRepliedIds(new Set(
              clientData
                .filter(c => c.checkin_reviewed && c.latest_checkin_submission_id)
                .map(c => c.latest_checkin_submission_id)
            ))
          }
          if (r3.ok) { const d = await r3.json(); setCheckins(d.checkins ?? []); setActivity(d.activity ?? []) }
          if (r4.ok) {
            const d = await r4.json()
            const admin = d.role === 'admin' || d.role === 'account_owner'
            setIsAdmin(admin)
            setMyUserId(d.id ?? null)
            // Non-admin coaches default to seeing only their own clients
            if (!admin) setCoachFilter(String(d.id))
          }
        }
      } catch {} finally {
        if (!cancelled) setDataLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [getToken])

  // ── Load coaches list ────────────────────────────────────────────────────────
  useEffect(() => {
    async function loadCoaches() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/coaches`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setCoaches(await res.json())
      } catch {}
    }
    loadCoaches()
  }, [getToken])

  // ── Load pending invites ─────────────────────────────────────────────────────
  const loadPendingInvites = useCallback(async () => {
    setPendingLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/pending-invites`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setPendingInvites(await res.json())
    } catch {} finally { setPendingLoading(false) }
  }, [getToken])

  useEffect(() => { loadPendingInvites() }, [loadPendingInvites])

  // ── Reload clients ───────────────────────────────────────────────────────────
  const reloadClients = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients?status=all`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setClients(await res.json())
    } catch {}
  }, [getToken])

  // ── Invite handlers ──────────────────────────────────────────────────────────
  async function handleResendInvite(id) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/pending-invites/${id}/resend`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    })
    return res.ok ? res.json() : { email_sent: false, email_note: 'Server error.' }
  }

  async function handleCancelInvite(id) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/pending-invites/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) loadPendingInvites()
    else { const d = await res.json().catch(() => ({})); alert(d.error ?? 'Could not cancel invite.') }
  }

  // ── Check-in replied toggle (Part B Polish 2) ────────────────────────────────
  async function toggleCheckinReplied(submissionId) {
    const alreadyReplied = repliedIds.has(submissionId)
    // Optimistic update
    setRepliedIds(prev => {
      const next = new Set(prev)
      alreadyReplied ? next.delete(submissionId) : next.add(submissionId)
      return next
    })
    try {
      const token = await getToken()
      const route = alreadyReplied ? 'unmark-reviewed' : 'mark-reviewed'
      const res = await fetch(`${API_URL}/api/coach-admin/form-submissions/${submissionId}/${route}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed')
    } catch {
      // Revert on error
      setRepliedIds(prev => {
        const next = new Set(prev)
        alreadyReplied ? next.add(submissionId) : next.delete(submissionId)
        return next
      })
    }
  }

  // ── Client actions ───────────────────────────────────────────────────────────
  async function deactivateClient(e, id) {
    e.stopPropagation()
    if (!confirm('Deactivate this client? They will be logged out and blocked from the app. All their data is preserved.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}/deactivate`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) reloadClients()
    else { const err = await res.json().catch(() => ({})); alert(err.error ?? 'Could not deactivate client') }
  }

  async function reactivateClient(e, id) {
    e.stopPropagation()
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}/reactivate`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) reloadClients()
  }

  async function deleteClient(e, id, name) {
    e.stopPropagation()
    if (!confirm(`Soft-delete ${name}? Type DELETE in the next prompt to confirm.`)) return
    if (prompt('Type DELETE to confirm:') !== 'DELETE') return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) reloadClients()
    else { const err = await res.json().catch(() => ({})); alert(err.error ?? 'Could not delete') }
  }

  // ── Computed ─────────────────────────────────────────────────────────────────
  const activeClients  = clients.filter(c => accountStatus(c) === 'active')

  const coachOptions = useMemo(() => {
    return coaches
      .filter(c => c.id)
      .map(c => [String(c.id), c.first_name || c.email || 'Coach'])
      .sort((a, b) => a[1].localeCompare(b[1]))
  }, [coaches])

  // Generate Monday-anchored week options for the check-in week selector.
  // Produces the last 8 weeks (current week first) as { value: 'YYYY-MM-DD', label: 'Week of Apr 27, 2026' }.
  const weekOptions = useMemo(() => {
    const opts = []
    const now  = new Date()
    const thisMondayISO = getMondayISO(now)
    for (let i = 0; i < 8; i++) {
      const d = new Date(thisMondayISO + 'T00:00:00')
      d.setDate(d.getDate() - i * 7)
      const iso   = d.toISOString().slice(0, 10)
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      opts.push({ value: iso, label: `Week of ${label}` })
    }
    return opts
  }, []) // computed once on mount

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase()
    // Derive week bounds from the selected Monday ISO date (weekFilter = 'YYYY-MM-DD')
    const weekStart = new Date(weekFilter + 'T00:00:00')
    const weekEnd   = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000)

    function hadCheckinInWeek(c) {
      if (!c.last_checkin_at) return false
      const at = new Date(c.last_checkin_at)
      return at >= weekStart && at < weekEnd
    }

    return clients
      .filter(c => {
        if (isAdmin && coachFilter !== 'all' && String(c.assigned_coach_id ?? '') !== coachFilter) return false
        if (typeFilter   !== 'all' && normalizeCoachingType(c.coaching_type) !== typeFilter) return false
        if (statusFilter !== 'all' && accountStatus(c) !== statusFilter) return false
        if (checkinFilter === 'received' && !hadCheckinInWeek(c)) return false
        if (checkinFilter === 'none'     &&  hadCheckinInWeek(c)) return false
        if (q && !`${clientName(c)} ${c.email ?? ''}`.toLowerCase().includes(q)) return false
        return true
      })
      .sort((a, b) => {
        const cmp = compareClients(a, b, sortCol) || clientName(a).localeCompare(clientName(b))
        return sortDir === 'desc' ? -cmp : cmp
      })
  }, [clients, clientSearch, coachFilter, typeFilter, statusFilter, checkinFilter, weekFilter, sortCol, sortDir, isAdmin])

  // ── Bulk messaging selection ─────────────────────────────────────────────────
  // Coaches may only select/message their own assigned clients — in practice the
  // server already scopes /coach-admin/clients to a coach's own roster, but this
  // is a defensive client-side check as well.
  function isClientSelectable(c) {
    if (isAdmin) return true
    return myUserId != null && c.assigned_coach_id === myUserId
  }

  function toggleClientSelected(c) {
    if (!isClientSelectable(c)) return
    setSelectedClientIds(prev => {
      const next = new Set(prev)
      if (next.has(c.id)) next.delete(c.id); else next.add(c.id)
      return next
    })
  }

  const selectableFilteredClients = useMemo(
    () => filteredClients.filter(isClientSelectable),
    [filteredClients, isAdmin, myUserId],
  )

  const allSelected = selectableFilteredClients.length > 0
    && selectableFilteredClients.every(c => selectedClientIds.has(c.id))

  function toggleSelectAll() {
    setSelectedClientIds(prev => {
      const next = new Set(prev)
      if (allSelected) selectableFilteredClients.forEach(c => next.delete(c.id))
      else selectableFilteredClients.forEach(c => next.add(c.id))
      return next
    })
  }

  function clearSelection() { setSelectedClientIds(new Set()) }

  const selectedClients = useMemo(
    () => clients.filter(c => selectedClientIds.has(c.id)),
    [clients, selectedClientIds],
  )

  const tabs = [
    { id: 'clients',     label: 'Clients' },
    { id: 'coach-foods', label: 'Coach Foods' },
    ...(isAdmin ? [{ id: 'admin-tools', label: '🛠 Admin Tools' }] : []),
  ]

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl">

      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Coaching Dashboard</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {dataLoading ? 'Loading clients...' : `${filteredClients.length} shown · ${activeClients.length} active`}
          </p>
        </div>
        <button
          onClick={() => setInviteOpen(true)}
          className="shrink-0 bg-[#E8670A] text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors min-h-[40px]"
        >
          + Add Client
        </button>
      </div>

      {/* Invite modal */}
      {inviteOpen && (
        <InviteModal
          getToken={getToken}
          coaches={coaches}
          isVa={isVa}
          onClose={() => setInviteOpen(false)}
          onSuccess={() => { setInviteOpen(false); reloadClients(); loadPendingInvites() }}
        />
      )}

      {/* Quick-message modal */}
      {messageClient && (
        <MessageClientModal
          client={messageClient}
          getToken={getToken}
          role={userRole}
          onClose={() => setMessageClient(null)}
        />
      )}

      {/* Bulk message modal */}
      {bulkMessageOpen && (
        <BulkMessageModal
          clients={selectedClients}
          getToken={getToken}
          onClose={() => setBulkMessageOpen(false)}
          onSent={data => {
            setBulkMessageOpen(false)
            clearSelection()
            setBulkToast(`Message sent to ${data.sent} client${data.sent === 1 ? '' : 's'}`)
            setTimeout(() => setBulkToast(null), 4000)
          }}
        />
      )}

      {/* Bulk send toast */}
      {bulkToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] bg-[#1e2a3a] text-white text-sm font-semibold px-4 py-2 rounded-lg shadow-lg">
          {bulkToast}
        </div>
      )}

      {/* ── Two-column body: main content + right rail ── */}
      <div className="flex gap-5 items-start">

      {/* ── Main column ── */}
      <div className="flex-1 min-w-0 space-y-3">

      {/* Pending Invites */}
      {(pendingLoading || pendingInvites.length > 0) && (
        <div className="bg-purple-50 border border-purple-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-purple-100 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-purple-900">
                Pending Invites{!pendingLoading && pendingInvites.length > 0 ? ` (${pendingInvites.length})` : ''}
              </p>
              <p className="text-[11px] text-purple-600 mt-0.5">Invited but not yet signed up</p>
            </div>
            <button
              onClick={() => setInviteOpen(true)}
              className="text-xs font-semibold text-purple-700 hover:text-purple-900 border border-purple-200 rounded-lg px-3 py-1.5 hover:bg-purple-100 transition-colors"
            >
              + New Invite
            </button>
          </div>
          {pendingLoading ? (
            <p className="text-xs text-purple-400 px-4 py-3">Loading…</p>
          ) : (
            <div className="divide-y divide-purple-100">
              {pendingInvites.map(inv => (
                <PendingInviteRow
                  key={inv.id} invite={inv}
                  onResend={() => handleResendInvite(inv.id)}
                  onCancel={() => handleCancelInvite(inv.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab bar */}
      <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit min-w-full sm:min-w-0">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
              {tab.id === 'coach-foods' && pendingFoodsCount > 0 && (
                <span className="ml-1.5 bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {pendingFoodsCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Clients tab ── */}
      {activeTab === 'clients' && (
        <div className="space-y-3">
          {/* Filters */}
          <div className="bg-white rounded-lg border border-gray-200 p-3">
            <div className={`grid grid-cols-1 sm:grid-cols-2 gap-2 ${isAdmin ? 'lg:grid-cols-7' : 'lg:grid-cols-6'}`}>
              <input type="text" value={clientSearch} onChange={e => setClientSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="lg:col-span-2 border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
              {isAdmin && (
                <select value={coachFilter} onChange={e => setCoachFilter(e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                  <option value="all">All coaches</option>
                  {coachOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              )}
              <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="all">All coaching</option>
                <option value="vip">VIP</option>
                <option value="basic">Basic</option>
                <option value="hybrid">Hybrid</option>
              </select>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="invited">Awaiting Setup</option>
                <option value="pending_access">Pending Access</option>
                <option value="inactive">Inactive</option>
              </select>
              <select value={weekFilter} onChange={e => setWeekFilter(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                {weekOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <select value={checkinFilter} onChange={e => setCheckinFilter(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="all">All check-ins</option>
                <option value="received">Check-in received</option>
                <option value="none">No check-in</option>
              </select>
              <div className="flex gap-2">
                <select value={sortCol} onChange={e => setSortCol(e.target.value)}
                  className="flex-1 border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                  <option value="client">Sort by name</option>
                  <option value="type">Sort by type</option>
                  <option value="coach">Sort by coach</option>
                  <option value="activity">Sort by activity</option>
                  <option value="login">Sort by last login</option>
                  <option value="checkin">Sort by check-in</option>
                  <option value="momentum">Sort by momentum</option>
                  <option value="status">Sort by status</option>
                </select>
                <button
                  type="button"
                  onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
                  title={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
                  className="shrink-0 border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white hover:bg-gray-50 transition-colors min-w-[44px] min-h-[36px]"
                >
                  {sortDir === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-xs text-gray-400">{filteredClients.length} of {clients.length} clients</p>
              {(clientSearch || (isAdmin && coachFilter !== 'all') || typeFilter !== 'all' || statusFilter !== 'all' || checkinFilter !== 'all' || weekFilter !== weekOptions[0]?.value) && (
                <button
                  type="button"
                  onClick={() => { setClientSearch(''); if (isAdmin) setCoachFilter('all'); setTypeFilter('all'); setStatusFilter('all'); setCheckinFilter('all'); setWeekFilter(weekOptions[0]?.value ?? getMondayISO()) }}
                  className="rounded-full bg-orange-50 px-2.5 py-1 text-xs font-semibold text-[#E8670A] hover:bg-orange-100 transition-colors"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>

          {/* Bulk action bar — appears once one or more clients are checked. VA can't
              message clients, so the whole bar (and its only action) stays hidden. */}
          {!isVa && (
            <div className={`overflow-hidden transition-all duration-200 ease-out ${
              selectedClientIds.size > 0 ? 'max-h-16 opacity-100' : 'max-h-0 opacity-0'
            }`}>
              <div className="flex items-center justify-between gap-3 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                <p className="text-sm font-semibold text-[#E8670A]">
                  {selectedClientIds.size} client{selectedClientIds.size === 1 ? '' : 's'} selected
                </p>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={clearSelection} className="text-xs font-medium text-gray-500 hover:text-gray-700">
                    Clear selection
                  </button>
                  <button
                    type="button"
                    onClick={() => setBulkMessageOpen(true)}
                    className="bg-[#E8670A] text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#c45e09] transition-colors min-h-[36px]"
                  >
                    Send Message
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Check-ins */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-700">Check-ins Needing Review</p>
                {!dataLoading && checkins.length > 0 && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                    {checkins.length}
                  </span>
                )}
              </div>
              <Link to="/admin/forms" className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">Forms</Link>
            </div>
            {dataLoading ? (
              <p className="text-xs text-gray-400 px-3 py-3">Loading check-ins...</p>
            ) : checkins.length === 0 ? (
              <p className="text-xs text-gray-400 px-3 py-3">No check-ins need review right now.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {checkins.slice(0, 4).map(item => (
                  <Link key={item.submission_id} to={`/admin/clients/${item.client_id}?tab=assessment`}
                    className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-orange-50/50 transition-colors">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{item.client_name}</p>
                      <p className="text-[11px] text-gray-400 truncate">
                        {item.form_title} · Submitted {fmtDateTime(item.submitted_at)}
                        {item.due_at ? ` · Due ${fmtShortDate(item.due_at)}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {item.is_late && (
                        <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">
                          Late
                        </span>
                      )}
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                        {item.status}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {dataLoading && <p className="text-center text-gray-400 py-12 text-sm">Loading clients…</p>}

          {!dataLoading && filteredClients.length === 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
              <p className="text-2xl mb-2">👥</p>
              <p className="text-sm text-gray-700 font-medium mb-1">No clients match your filters.</p>
              {statusFilter === 'invited' && pendingInvites.length > 0 ? (
                <p className="text-xs text-gray-500 max-w-xs mx-auto">
                  <strong>Awaiting Setup</strong> shows clients who signed up but haven't completed health assessment yet.
                  Clients who haven't signed up yet appear above in <strong>Pending Invites</strong>.
                </p>
              ) : (
                <p className="text-xs text-gray-400">Try changing your filters or adding a new client.</p>
              )}
            </div>
          )}

          {/* Desktop table */}
          {!dataLoading && filteredClients.length > 0 && (
            <>
              <div className="hidden lg:block bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200 text-xs text-gray-500 uppercase tracking-wider">
                    <tr>
                      <th className="px-3 py-2 w-8">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleSelectAll}
                          className="w-4 h-4 accent-[#E8670A]"
                          aria-label="Select all clients"
                        />
                      </th>
                      <SortHeader col="client"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Client</SortHeader>
                      <SortHeader col="type"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Type</SortHeader>
                      <SortHeader col="coach"    sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Coach</SortHeader>
                      <SortHeader col="activity" sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Last Activity</SortHeader>
                      <SortHeader col="login"    sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Last Login</SortHeader>
                      <SortHeader col="checkin"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort}
                          title="Shows the client's current/latest check-in and reply status — independent of the historical week chosen in the filter above.">
                        Check-In (current)
                      </SortHeader>
                      <SortHeader col="momentum" sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Momentum</SortHeader>
                      <SortHeader col="status"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Status</SortHeader>
                      <th className="px-3 py-2 font-semibold">Tags</th>
                      <th className="text-right px-3 py-2 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredClients.map(c => (
                      <tr key={c.id}
                        onClick={() => navigate(`/admin/clients/${c.id}`)}
                        className={`hover:bg-orange-50/50 cursor-pointer transition-colors ${selectedClientIds.has(c.id) ? 'bg-orange-50' : ''}`}>
                        <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedClientIds.has(c.id)}
                            onChange={() => toggleClientSelected(c)}
                            disabled={!isClientSelectable(c)}
                            className="w-4 h-4 accent-[#E8670A] disabled:opacity-30"
                            aria-label={`Select ${clientName(c)}`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-semibold text-gray-900">{clientName(c)}</p>
                          <p className="text-xs text-gray-400 truncate max-w-[180px]">{c.email}</p>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold border ${coachingBadge(c.coaching_type)}`}>
                            {coachingLabel(c.coaching_type)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-600">{c.assigned_coach_name ?? '—'}</td>
                        <td className="px-3 py-2 text-xs text-gray-500">
                          <span className="block font-medium text-gray-700">{formatActivity(c)}</span>
                          {c.last_checkin_at && (
                            <span className="block text-[11px] text-gray-400">
                              Last check-in {daysSince(c.last_checkin_at) === 0 ? 'today' : `${daysSince(c.last_checkin_at)}d ago`}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500">
                          {c.last_login_at ? (
                            <>
                              <span className="block font-medium text-gray-700">{fmtMDY(c.last_login_at)}</span>
                              <span className="block text-[11px] text-gray-400">
                                {daysSince(c.last_login_at) === 0 ? 'today' : `${daysSince(c.last_login_at)}d ago`}
                              </span>
                            </>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-2">
                          {c.check_in_this_week && c.latest_checkin_submission_id ? (
                            <button
                              onClick={e => { e.stopPropagation(); toggleCheckinReplied(c.latest_checkin_submission_id) }}
                              title={repliedIds.has(c.latest_checkin_submission_id) ? 'Mark as not replied' : 'Mark as replied'}
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-[#E8670A] ${repliedIds.has(c.latest_checkin_submission_id) ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100' : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
                            >
                              {repliedIds.has(c.latest_checkin_submission_id) ? '🙂 Replied' : '✓ Check-in'}
                            </button>
                          ) : c.check_in_this_week ? (
                            <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">✓ Check-in</span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-bold text-gray-400">No check-in</span>
                          )}
                        </td>
                        <td className="px-3 py-2"><StatusBadge status={c.status_tag} /></td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${accountStatusBadgeClass(c)}`}>
                            {accountStatusLabel(c)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            {!c.tags?.length ? (
                              <span className="text-xs text-gray-400">No tags</span>
                            ) : (
                              c.tags.map(tag => (
                                <TagChip key={tag.id} tag={tag} onDelete={isAdmin ? () => removeTag(c.id, tag.tag_name) : null} isEditingId={editingClientId} setEditingId={setEditingClientId} />
                              ))
                            )}
                            {isAdmin && editingClientId === c.id && (
                              <div className="flex items-center gap-1 mt-1" onClick={e => e.stopPropagation()}>
                                <input
                                  type="text"
                                  value={newTagInput}
                                  onChange={e => { setNewTagInput(e.target.value); setTagError(null) }}
                                  onKeyPress={e => e.key === 'Enter' && addTag(c.id)}
                                  placeholder="Add tag..."
                                  maxLength={50}
                                  className="px-2 py-1 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                                  disabled={tagLoading}
                                  autoFocus
                                />
                                <button
                                  onClick={e => { e.stopPropagation(); addTag(c.id) }}
                                  disabled={tagLoading || !newTagInput.trim()}
                                  className="px-2 py-1 text-xs bg-[#E8670A] text-white rounded-lg hover:bg-[#c45e09] disabled:opacity-40 transition-colors"
                                >
                                  {tagLoading ? '…' : 'Add'}
                                </button>
                              </div>
                            )}
                            {isAdmin && editingClientId !== c.id && (
                              <button
                                onClick={e => { e.stopPropagation(); setEditingClientId(c.id); setNewTagInput(''); setTagError(null) }}
                                className="text-[10px] text-[#E8670A] hover:text-[#c45e09] font-semibold"
                              >
                                + Add
                              </button>
                            )}
                            {tagError && editingClientId === c.id && (
                              <p className="text-[10px] text-red-500 w-full">{tagError}</p>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {!isVa && (
                            <>
                              <MessageIconButton
                                className="mr-1 align-middle"
                                onClick={e => { e.stopPropagation(); setMessageClient({ id: c.id, name: clientName(c) }) }}
                              />
                              {c.client_status === 'deactivated' ? (
                                <button onClick={e => reactivateClient(e, c.id)}
                                  className="text-xs text-emerald-600 hover:text-emerald-700 font-semibold mr-2">Reactivate</button>
                              ) : (
                                <button onClick={e => deactivateClient(e, c.id)}
                                  className="text-xs text-gray-500 hover:text-gray-700 font-medium mr-2">Deactivate</button>
                              )}
                              <button onClick={e => deleteClient(e, c.id, c.first_name ?? 'this client')}
                                className="text-xs text-red-400 hover:text-red-600 font-medium">Delete</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="lg:hidden space-y-3">
                <div className="flex items-center justify-between px-1">
                  <button type="button" onClick={toggleSelectAll} className="text-xs font-semibold text-[#E8670A]">
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                  {selectedClientIds.size > 0 && (
                    <span className="text-xs text-gray-400">{selectedClientIds.size} selected</span>
                  )}
                </div>
                {filteredClients.map(c => (
                  <button key={c.id} onClick={() => navigate(`/admin/clients/${c.id}`)}
                    className={`w-full text-left bg-white border border-gray-200 rounded-lg p-3 hover:border-[#E8670A] active:scale-[0.99] transition-all ${selectedClientIds.has(c.id) ? 'bg-orange-50 border-orange-300' : ''}`}>
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900">{clientName(c)}</p>
                        <p className="text-xs text-gray-400 truncate">{c.email}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={c.status_tag} />
                        <input
                          type="checkbox"
                          checked={selectedClientIds.has(c.id)}
                          onChange={() => toggleClientSelected(c)}
                          onClick={e => e.stopPropagation()}
                          disabled={!isClientSelectable(c)}
                          className="w-4 h-4 accent-[#E8670A] disabled:opacity-30"
                          aria-label={`Select ${clientName(c)}`}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] mb-2 flex-wrap">
                      <span className={`rounded-full px-2 py-0.5 font-bold border ${coachingBadge(c.coaching_type)}`}>
                        {coachingLabel(c.coaching_type)}
                      </span>
                      {c.assigned_coach_name && <span className="text-gray-500">Coach: {c.assigned_coach_name}</span>}
                      <span className="text-gray-400">{formatActivity(c)}</span>
                      {c.check_in_this_week && c.latest_checkin_submission_id ? (
                        <button
                          onClick={e => { e.stopPropagation(); toggleCheckinReplied(c.latest_checkin_submission_id) }}
                          className={`rounded-full border px-2 py-0.5 font-bold transition-colors ${repliedIds.has(c.latest_checkin_submission_id) ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}
                        >
                          {repliedIds.has(c.latest_checkin_submission_id) ? '🙂 Replied' : '✓ Check-in'}
                        </button>
                      ) : c.check_in_this_week ? (
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700">✓ Check-in</span>
                      ) : (
                        <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 font-bold text-gray-400">No check-in</span>
                      )}
                      {c.last_login_at && (
                        <span className="text-gray-400">Login {daysSince(c.last_login_at) === 0 ? 'today' : `${daysSince(c.last_login_at)}d ago`}</span>
                      )}
                    </div>
                    <div className="mt-2 pt-2 border-t border-gray-100">
                      <div className="mb-2">
                        <p className="text-[10px] font-semibold text-gray-600 mb-1">Tags</p>
                        <div className="flex flex-wrap items-center gap-1">
                          {!c.tags?.length ? (
                            <span className="text-[10px] text-gray-400">No tags</span>
                          ) : (
                            c.tags.map(tag => (
                              <TagChip key={tag.id} tag={tag} onDelete={isAdmin ? () => removeTag(c.id, tag.tag_name) : null} isEditingId={editingClientId} setEditingId={setEditingClientId} />
                            ))
                          )}
                        </div>
                        {isAdmin && editingClientId === c.id && (
                          <div className="flex items-center gap-1 mt-2" onClick={e => e.stopPropagation()}>
                            <input
                              type="text"
                              value={newTagInput}
                              onChange={e => { setNewTagInput(e.target.value); setTagError(null) }}
                              onKeyPress={e => e.key === 'Enter' && addTag(c.id)}
                              placeholder="Add tag..."
                              maxLength={50}
                              className="px-2 py-1 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#E8670A] flex-1"
                              disabled={tagLoading}
                              autoFocus
                            />
                            <button
                              onClick={e => { e.stopPropagation(); addTag(c.id) }}
                              disabled={tagLoading || !newTagInput.trim()}
                              className="px-3 py-1 text-xs bg-[#E8670A] text-white rounded-lg hover:bg-[#c45e09] disabled:opacity-40 transition-colors"
                            >
                              {tagLoading ? '…' : 'Add'}
                            </button>
                          </div>
                        )}
                        {isAdmin && editingClientId !== c.id && (
                          <button
                            onClick={e => { e.stopPropagation(); setEditingClientId(c.id); setNewTagInput(''); setTagError(null) }}
                            className="text-[10px] text-[#E8670A] hover:text-[#c45e09] font-semibold mt-2"
                          >
                            + Add Tag
                          </button>
                        )}
                        {tagError && editingClientId === c.id && (
                          <p className="text-[10px] text-red-500 mt-1">{tagError}</p>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-100">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${accountStatusBadgeClass(c)}`}>
                          {accountStatusLabel(c)}
                        </span>
                        {!isVa && (
                          <div className="flex items-center gap-3">
                            <MessageIconButton
                              className="min-w-[44px] min-h-[44px]"
                              onClick={e => { e.stopPropagation(); setMessageClient({ id: c.id, name: clientName(c) }) }}
                            />
                            {c.client_status === 'deactivated'
                              ? <button type="button" onClick={e => reactivateClient(e, c.id)} className="text-[11px] text-emerald-600 hover:text-emerald-700 font-semibold min-h-[44px] px-1">Reactivate</button>
                              : <button type="button" onClick={e => deactivateClient(e, c.id)} className="text-[11px] text-gray-500 hover:text-gray-700 font-medium min-h-[44px] px-1">Deactivate</button>
                            }
                            <button type="button" onClick={e => deleteClient(e, c.id, c.first_name ?? 'this client')}
                              className="text-[11px] text-red-400 hover:text-red-600 font-medium min-h-[44px] px-1">Delete</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}



      {/* Coach Foods tab */}
      {activeTab === 'coach-foods' && <CoachFoodsTab getToken={getToken} onCountChange={setPendingFoodsCount} />}

      {/* Admin Tools tab (admin only) */}
      {activeTab === 'admin-tools' && isAdmin && (
        <AdminToolsPanel clients={clients} getToken={getToken} />
      )}

      {/* Recent Activity — stacks below tabs on screens narrower than 2xl */}
      <div className="2xl:hidden pt-2">
        <RecentActivityRail loading={dataLoading} activity={activity} />
      </div>

      </div>{/* ── end main column ── */}

      {/* ── Right rail: Recent Activity (2xl+ only) ── */}
      <aside className="hidden 2xl:flex flex-col w-64 flex-shrink-0 self-start sticky top-4 gap-0">
        <RecentActivityRail loading={dataLoading} activity={activity} />
      </aside>

      </div>{/* ── end flex body ── */}

    </div>
  )
}
