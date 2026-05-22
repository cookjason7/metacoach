// CoachDashboard.jsx — unified staff dashboard
// Rendered at /dashboard for admin/coach roles.
// /admin/clients and /admin both redirect here.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { API_URL } from '../config.js'
import FoodSourceBadge from '../components/FoodSourceBadge.jsx'
import StaffInbox from '../components/StaffInbox.jsx'

// ── Constants ─────────────────────────────────────────────────────────────────

const SERVING_UNITS = ['g', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'ml', 'fl oz']

const COACHING_TYPE_BADGE = {
  vip:    'bg-orange-50 text-[#E8670A] border-orange-200',
  ai:     'bg-blue-50 text-blue-700 border-blue-200',
  hybrid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

const STATUS_STYLES = {
  'Consistent':          'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Building Momentum':   'bg-blue-50 text-blue-700 border-blue-200',
  'Rebuilding Momentum': 'bg-amber-50 text-amber-700 border-amber-200',
  'Needs Attention':     'bg-orange-50 text-[#E8670A] border-orange-200',
  'New Client':          'bg-gray-50 text-gray-600 border-gray-200',
  'Invited':             'bg-purple-50 text-purple-700 border-purple-200',
}

const EMPTY_INVITE = {
  first_name: '', last_name: '', email: '',
  coaching_type: 'vip', assigned_coach_id: '', notes: '',
}

const EMPTY_FOOD_FORM = {
  food_name: '', calories: '', protein: '', carbs: '', fat: '', fiber: '',
  serving_size: '100', serving_unit: 'g', notes: '',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysSince(iso) {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso)) / 86400_000)
}

function fmtShortDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
  if (type === 'ai') return 'AI'
  if (type === 'hybrid') return 'Hybrid'
  return 'VIP'
}

function coachingBadge(type) {
  return COACHING_TYPE_BADGE[type] ?? COACHING_TYPE_BADGE.vip
}

function lastActivityAt(c) {
  const dates = [c.last_checkin_at, c.last_meal_at, c.last_login_at]
    .filter(Boolean).map(d => new Date(d))
  if (!dates.length) return null
  return new Date(Math.max(...dates.map(d => d.getTime())))
}

function accountStatus(c) {
  if (c.client_status === 'invited')  return 'invited'
  if (c.client_status === 'archived') return 'inactive'
  const last = lastActivityAt(c)
  if (!last) return 'inactive'
  return daysSince(last.toISOString()) > 14 ? 'inactive' : 'active'
}

function accountStatusLabel(c) {
  const s = accountStatus(c)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function accountStatusBadgeClass(c) {
  const s = accountStatus(c)
  if (s === 'active')  return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (s === 'invited') return 'bg-purple-50 text-purple-700 border-purple-200'
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

function adherenceColor(v) {
  const n = Number(v) || 0
  if (n >= 80) return 'text-emerald-600'
  if (n >= 50) return 'text-blue-600'
  if (n >= 30) return 'text-amber-600'
  return 'text-gray-400'
}

// ── CoachStatCard ─────────────────────────────────────────────────────────────

function CoachStatCard({ label, value, sub, accent = false, href }) {
  const inner = (
    <div className={`bg-white rounded-xl border p-4 h-full ${accent ? 'border-[#E8670A]' : 'border-gray-200'}`}>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ? 'text-[#E8670A]' : 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
  return href
    ? <Link to={href} className="block hover:opacity-90 transition-opacity">{inner}</Link>
    : inner
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
        <Row label="Date of birth" value={data.date_of_birth ? data.date_of_birth.slice(0,10) : null} />
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
          ['Calories (per serving)', 'calories', '120'],
          ['Protein g',             'protein',  '22' ],
          ['Carbs g',               'carbs',    '0'  ],
          ['Fat g',                 'fat',      '2.6'],
          ['Fiber g',               'fiber',    '0'  ],
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
    protein:      food.protein != null ? String(food.protein) : '',
    carbs:        food.carbs   != null ? String(food.carbs)   : '',
    fat:          food.fat     != null ? String(food.fat)     : '',
    fiber:        food.fiber   != null ? String(food.fiber)   : '',
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

function CoachFoodsTab({ getToken }) {
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
  const debounceRef = useRef(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/admin/coach-foods`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setCoachFoods(await res.json())
      } finally { setLoading(false) }
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

// ── Dev Tools tab (admin only) ────────────────────────────────────────────────

function StatusPill({ label, value }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold border ${
      value ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-500'
    }`}>
      {value ? '✓' : '✗'} {label}
    </span>
  )
}

function DevToolsTab({ getToken }) {
  const [clients,   setClients]   = useState([])
  const [loading,   setLoading]   = useState(true)
  const [resetting, setResetting] = useState({})
  const [overrides, setOverrides] = useState({})

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/admin/users`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setClients(await res.json())
      } finally { setLoading(false) }
    }
    load()
  }, [getToken])

  async function reset(clientId, opts) {
    setResetting(r => ({ ...r, [clientId]: 'loading' }))
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/users/${clientId}/dev-reset`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(opts),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed')
      const data = await res.json()
      setOverrides(o => ({ ...o, [clientId]: data.user }))
      setResetting(r => ({ ...r, [clientId]: 'done' }))
    } catch (err) {
      alert(`Reset failed: ${err.message}`)
      setResetting(r => ({ ...r, [clientId]: null }))
    }
  }

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>

  return (
    <div>
      <div className="bg-yellow-50 border-2 border-yellow-300 rounded-xl p-4 mb-5 flex gap-3">
        <span className="text-xl shrink-0">⚠️</span>
        <div>
          <p className="text-sm font-bold text-yellow-800">DEV TOOLS — Testing Only</p>
          <p className="text-xs text-yellow-700 mt-1">
            Resets <code className="bg-yellow-100 px-0.5 rounded">assessment_complete</code> flags.
            No meals, workouts, or data are affected.
          </p>
        </div>
      </div>
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-5">
        <p className="text-xs font-bold text-gray-700 mb-2">How to test the assessment flow:</p>
        <ol className="text-xs text-gray-600 space-y-1.5 list-decimal list-inside">
          <li>Find your own account below and click <strong>Reset Assessment</strong>.</li>
          <li>Click <strong>Reload &amp; Test →</strong> — redirects to health assessment.</li>
          <li>Complete the flow normally. Return here to reset again.</li>
        </ol>
      </div>
      {!clients.length && <p className="text-sm text-gray-400 text-center py-8">No users yet.</p>}
      <div className="space-y-2">
        {clients.map(client => {
          const busy    = resetting[client.id] === 'loading'
          const done    = resetting[client.id] === 'done'
          const current = overrides[client.id] ?? client
          return (
            <div key={client.id} className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {[client.first_name, client.display_last_name].filter(Boolean).join(' ') || client.email || 'Unknown'}
                    {client.email && <span className="text-xs text-gray-400 font-normal ml-2">{client.email}</span>}
                  </p>
                  <div className="flex gap-2 mt-1.5 flex-wrap">
                    <StatusPill label="Onboarding" value={current.onboarding_complete} />
                    <StatusPill label="Assessment"  value={current.assessment_complete} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <button onClick={() => reset(client.id, { reset_assessment: true })} disabled={busy}
                    className="px-3 py-2 text-xs font-semibold rounded-lg border-2 border-yellow-400 text-yellow-700 hover:bg-yellow-50 disabled:opacity-40 transition-colors min-h-[36px]">
                    {busy ? '…' : 'Reset Assessment'}
                  </button>
                  <button onClick={() => reset(client.id, { reset_onboarding: true, reset_assessment: true })} disabled={busy}
                    className="px-3 py-2 text-xs font-semibold rounded-lg border-2 border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 transition-colors min-h-[36px]">
                    {busy ? '…' : 'Reset Both'}
                  </button>
                  {done && (
                    <button onClick={() => { window.location.href = '/dashboard' }}
                      className="px-3 py-2 text-xs font-semibold rounded-lg bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors min-h-[36px]">
                      Reload &amp; Test →
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Messaging tab ─────────────────────────────────────────────────────────────

function AdminMessagingTab({ getToken }) {
  return <StaffInbox getToken={getToken} />
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
  const coachBadge  = COACHING_TYPE_BADGE[invite.coaching_type] ?? COACHING_TYPE_BADGE.vip
  const typeLabel   = invite.coaching_type === 'ai' ? 'AI' : invite.coaching_type === 'hybrid' ? 'Hybrid' : 'VIP'

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

function InviteModal({ getToken, coaches = [], onClose, onSuccess }) {
  const [form,       setForm]       = useState(EMPTY_INVITE)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState(null)
  const [isArchived, setIsArchived] = useState(false)
  const [result,     setResult]     = useState(null)
  const [copied,     setCopied]     = useState(false)

  function setF(e) { setForm(f => ({ ...f, [e.target.name]: e.target.value })) }

  async function submit(e) {
    e.preventDefault()
    setSaving(true); setError(null); setIsArchived(false)
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
          assigned_coach_id: form.assigned_coach_id || undefined,
          notes:             form.notes.trim()   || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Invite failed.'); setIsArchived(!!data.is_archived); return }
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
                  <option value="ai">AI</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Assign coach</label>
                <select name="assigned_coach_id" value={form.assigned_coach_id} onChange={setF} className={inputCls}>
                  <option value="">Unassigned</option>
                  {coaches.map(c => (
                    <option key={c.id} value={String(c.id)}>{c.first_name || c.email}</option>
                  ))}
                </select>
              </div>
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
                {isArchived && (
                  <button type="button" onClick={onClose}
                    className="text-xs text-[#E8670A] underline mt-1 block">
                    View Archived Clients → Reactivate, then reinvite
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

// ── Main CoachDashboard ───────────────────────────────────────────────────────

export default function CoachDashboard({ getToken, userRole }) {
  const navigate                         = useNavigate()
  const [searchParams, setSearchParams]  = useSearchParams()

  // ── Data ────────────────────────────────────────────────────────────────────
  const [clients,        setClients]        = useState([])
  const [msgUnread,      setMsgUnread]      = useState(0)
  const [checkins,       setCheckins]       = useState([])
  const [activity,       setActivity]       = useState([])
  const [dataLoading,    setDataLoading]    = useState(true)

  // ── Invites / coaches ───────────────────────────────────────────────────────
  const [coaches,        setCoaches]        = useState([])
  const [pendingInvites, setPendingInvites] = useState([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const [inviteOpen,     setInviteOpen]     = useState(false)
  const [isAdmin,        setIsAdmin]        = useState(userRole === 'admin')

  // ── Filters ─────────────────────────────────────────────────────────────────
  const [clientSearch, setClientSearch] = useState('')
  const [coachFilter,  setCoachFilter]  = useState('all')
  const [typeFilter,   setTypeFilter]   = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortBy,       setSortBy]       = useState('activity')

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
        const [r1, r2, r3, r4] = await Promise.all([
          fetch(`${API_URL}/api/coach-admin/clients?status=all`, { headers }),
          fetch(`${API_URL}/api/messages/unread-count`,          { headers }),
          fetch(`${API_URL}/api/coach-admin/dashboard-summary`,  { headers }),
          fetch(`${API_URL}/api/users/me`,                       { headers }),
        ])
        if (!cancelled) {
          if (r1.ok) setClients(await r1.json())
          if (r2.ok) { const d = await r2.json(); setMsgUnread(d.unread ?? 0) }
          if (r3.ok) { const d = await r3.json(); setCheckins(d.checkins ?? []); setActivity(d.activity ?? []) }
          if (r4.ok) { const d = await r4.json(); setIsAdmin(d.role === 'admin') }
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

  // ── Client actions ───────────────────────────────────────────────────────────
  async function archiveClient(e, id) {
    e.stopPropagation()
    if (!confirm('Archive this client? All their data is preserved.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}/archive`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) reloadClients()
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
  const needsAttention = activeClients.filter(c => c.status_tag === 'Needs Attention')
  const noRecentLogs   = activeClients.filter(c => { const d = daysSince(c.last_meal_at); return d === null || d > 3 })

  const coachOptions = useMemo(() => {
    const seen = new Map()
    clients.forEach(c => {
      if (c.assigned_coach_id)
        seen.set(String(c.assigned_coach_id), c.assigned_coach_name || c.assigned_coach_email || 'Assigned coach')
    })
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [clients])

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase()
    return clients
      .filter(c => {
        if (coachFilter  !== 'all' && String(c.assigned_coach_id ?? '') !== coachFilter) return false
        if (typeFilter   !== 'all' && (c.coaching_type || 'vip') !== typeFilter) return false
        if (statusFilter !== 'all' && accountStatus(c) !== statusFilter) return false
        if (q && !`${clientName(c)} ${c.email ?? ''}`.toLowerCase().includes(q)) return false
        return true
      })
      .sort((a, b) => {
        if (sortBy === 'activity') return (lastActivityAt(b)?.getTime() ?? 0) - (lastActivityAt(a)?.getTime() ?? 0)
        if (sortBy === 'coach')  return (a.assigned_coach_name || '').localeCompare(b.assigned_coach_name || '')
        if (sortBy === 'status') return accountStatus(a).localeCompare(accountStatus(b)) || clientName(a).localeCompare(clientName(b))
        return clientName(a).localeCompare(clientName(b))
      })
  }, [clients, clientSearch, coachFilter, typeFilter, statusFilter, sortBy])

  const tabs = [
    { id: 'clients',     label: 'Clients' },
    { id: 'food-macros', label: 'Food & Macros' },
    { id: 'messaging',   label: 'Messaging' },
    { id: 'coach-foods', label: 'Coach Foods' },
    ...(isAdmin ? [{ id: 'dev-tools', label: '🛠 Dev Tools' }] : []),
  ]

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Coaching Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">What needs your attention today.</p>
        </div>
        <button
          onClick={() => setInviteOpen(true)}
          className="shrink-0 bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors min-h-[44px]"
        >
          + Add Client
        </button>
      </div>

      {/* Invite modal */}
      {inviteOpen && (
        <InviteModal
          getToken={getToken}
          coaches={coaches}
          onClose={() => setInviteOpen(false)}
          onSuccess={() => { setInviteOpen(false); reloadClients(); loadPendingInvites() }}
        />
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <CoachStatCard label="Active Clients"   value={dataLoading ? '…' : activeClients.length}  sub="in your roster" />
        <CoachStatCard label="Needs Attention"  value={dataLoading ? '…' : needsAttention.length}  sub="by status tag"
          accent={!dataLoading && needsAttention.length > 0} />
        <CoachStatCard label="Unread Messages"  value={dataLoading ? '…' : msgUnread}              sub="from clients"
          accent={!dataLoading && msgUnread > 0} href="/messages" />
        <CoachStatCard label="No Recent Logs"   value={dataLoading ? '…' : noRecentLogs.length}    sub="3+ days inactive"
          accent={!dataLoading && noRecentLogs.length > 0} />
      </div>

      {/* Pending Invites */}
      {(pendingLoading || pendingInvites.length > 0) && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-purple-100 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-purple-900">
                Pending Invites{!pendingLoading && pendingInvites.length > 0 ? ` (${pendingInvites.length})` : ''}
              </p>
              <p className="text-xs text-purple-600 mt-0.5">Invited but not yet signed up</p>
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

      {/* Alert sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Status-Flagged */}
        <div>
          <p className="text-sm font-semibold text-gray-700 mb-2">Status-Flagged Clients</p>
          {dataLoading ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-gray-400">Loading…</p>
            </div>
          ) : needsAttention.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-4 text-center">
              <p className="text-sm text-gray-500">No status flags right now.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
              {needsAttention.slice(0, 5).map(c => (
                <Link key={c.id} to={`/admin/clients/${c.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-orange-50/50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{clientName(c)}</p>
                    <p className="text-xs text-gray-400">
                      {c.last_meal_at ? `Last log: ${fmtShortDate(c.last_meal_at)}` : 'No meals logged'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-xs font-bold ${adherenceColor(c.adherence_7d)}`}>
                      {Math.round(Number(c.adherence_7d) || 0)}% 7d
                    </span>
                    <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </Link>
              ))}
              {needsAttention.length > 5 && (
                <div className="px-4 py-2 text-xs text-gray-400 text-center">
                  +{needsAttention.length - 5} more — see Clients tab
                </div>
              )}
            </div>
          )}
        </div>

        {/* No Recent Logs */}
        <div>
          <p className="text-sm font-semibold text-gray-700 mb-2">No Recent Logs (3+ days)</p>
          {dataLoading ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-gray-400">Loading…</p>
            </div>
          ) : noRecentLogs.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-4 text-center">
              <p className="text-sm text-gray-500">Everyone has logged recently.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
              {noRecentLogs.slice(0, 4).map(c => (
                <Link key={c.id} to={`/admin/clients/${c.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-orange-50/50 transition-colors">
                  <p className="text-sm font-medium text-gray-900 min-w-0 truncate">{clientName(c)}</p>
                  <p className="text-xs text-gray-400 shrink-0">
                    {c.last_meal_at ? `Last logged ${fmtShortDate(c.last_meal_at)}` : 'Never logged'}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Check-ins */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-700">Check-ins Needing Review</p>
            <Link to="/admin/forms" className="text-xs text-[#E8670A] hover:text-[#c45e09] font-medium">Forms →</Link>
          </div>
          {dataLoading ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-gray-400">Loading…</p>
            </div>
          ) : checkins.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-4 text-center">
              <p className="text-sm text-gray-500">No check-ins need review right now.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100 overflow-hidden">
              {checkins.map(item => (
                <Link key={item.submission_id} to={`/admin/clients/${item.client_id}?tab=assessment`}
                  className="block px-4 py-3 hover:bg-orange-50/50 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{item.client_name}</p>
                      <p className="text-xs text-gray-500 truncate">{item.form_title}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        Submitted {fmtDateTime(item.submitted_at)}
                        {item.due_at ? ` · Due ${fmtShortDate(item.due_at)}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                      {item.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div>
          <p className="text-sm font-semibold text-gray-700 mb-2">Recent Client Activity</p>
          {dataLoading ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-gray-400">Loading…</p>
            </div>
          ) : activity.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-4 text-center">
              <p className="text-sm text-gray-500">No recent client activity yet.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100 overflow-hidden">
              {activity.map((event, idx) => (
                <Link key={`${event.type}-${event.client_id}-${event.occurred_at}-${idx}`}
                  to={`/admin/clients/${event.client_id}`}
                  className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-orange-50/50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{event.client_name}</p>
                    <p className="text-xs text-gray-500 truncate">{event.label}</p>
                  </div>
                  <p className="text-[11px] text-gray-400 shrink-0">{fmtShortDate(event.occurred_at)}</p>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit min-w-full sm:min-w-0">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
              {tab.id === 'messaging' && msgUnread > 0 && (
                <span className="ml-1.5 bg-[#E8670A] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {msgUnread}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Clients tab ── */}
      {activeTab === 'clients' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
              <input type="text" value={clientSearch} onChange={e => setClientSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="lg:col-span-2 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
              <select value={coachFilter} onChange={e => setCoachFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="all">All coaches</option>
                {coachOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="all">All coaching</option>
                <option value="vip">VIP</option>
                <option value="ai">AI</option>
                <option value="hybrid">Hybrid</option>
              </select>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="invited">Awaiting Setup</option>
                <option value="inactive">Inactive</option>
              </select>
              <select value={sortBy} onChange={e => setSortBy(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="activity">Sort by activity</option>
                <option value="name">Sort by name</option>
                <option value="coach">Sort by coach</option>
                <option value="status">Sort by status</option>
              </select>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-xs text-gray-400">{filteredClients.length} of {clients.length} clients</p>
              {(clientSearch || coachFilter !== 'all' || typeFilter !== 'all' || statusFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => { setClientSearch(''); setCoachFilter('all'); setTypeFilter('all'); setStatusFilter('all') }}
                  className="rounded-full bg-orange-50 px-2.5 py-1 text-xs font-semibold text-[#E8670A] hover:bg-orange-100 transition-colors"
                >
                  Clear filters
                </button>
              )}
            </div>
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
                      <th className="text-left px-4 py-3 font-semibold">Client</th>
                      <th className="text-left px-4 py-3 font-semibold">Type</th>
                      <th className="text-left px-4 py-3 font-semibold">Coach</th>
                      <th className="text-left px-3 py-3 font-semibold">Last Activity</th>
                      <th className="text-center px-3 py-3 font-semibold">7d</th>
                      <th className="text-center px-3 py-3 font-semibold">30d</th>
                      <th className="text-left px-3 py-3 font-semibold">Momentum</th>
                      <th className="text-left px-3 py-3 font-semibold">Status</th>
                      <th className="text-right px-3 py-3 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredClients.map(c => (
                      <tr key={c.id}
                        onClick={() => navigate(`/admin/clients/${c.id}`)}
                        className="hover:bg-orange-50/50 cursor-pointer transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-gray-900">{clientName(c)}</p>
                          <p className="text-xs text-gray-400 truncate max-w-[180px]">{c.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold border ${coachingBadge(c.coaching_type)}`}>
                            {coachingLabel(c.coaching_type)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">{c.assigned_coach_name ?? '—'}</td>
                        <td className="px-3 py-3 text-xs text-gray-500">
                          <span className="block font-medium text-gray-700">{formatActivity(c)}</span>
                          {c.last_checkin_at && (
                            <span className="block text-[11px] text-gray-400">
                              Last check-in {daysSince(c.last_checkin_at) === 0 ? 'today' : `${daysSince(c.last_checkin_at)}d ago`}
                            </span>
                          )}
                        </td>
                        <td className={`px-3 py-3 text-center font-bold ${adherenceColor(c.adherence_7d)}`}>
                          {Math.round(Number(c.adherence_7d) || 0)}%
                        </td>
                        <td className={`px-3 py-3 text-center font-bold ${adherenceColor(c.adherence_30d)}`}>
                          {Math.round(Number(c.adherence_30d) || 0)}%
                        </td>
                        <td className="px-3 py-3"><StatusBadge status={c.status_tag} /></td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${accountStatusBadgeClass(c)}`}>
                            {accountStatusLabel(c)}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap">
                          {c.client_status === 'archived' ? (
                            <button onClick={e => reactivateClient(e, c.id)}
                              className="text-xs text-emerald-600 hover:text-emerald-700 font-semibold mr-2">Reactivate</button>
                          ) : (
                            <button onClick={e => archiveClient(e, c.id)}
                              className="text-xs text-gray-500 hover:text-gray-700 font-medium mr-2">Archive</button>
                          )}
                          <button onClick={e => deleteClient(e, c.id, c.first_name ?? 'this client')}
                            className="text-xs text-red-400 hover:text-red-600 font-medium">Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="lg:hidden space-y-3">
                {filteredClients.map(c => (
                  <button key={c.id} onClick={() => navigate(`/admin/clients/${c.id}`)}
                    className="w-full text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-[#E8670A] active:scale-[0.99] transition-all">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900">{clientName(c)}</p>
                        <p className="text-xs text-gray-400 truncate">{c.email}</p>
                      </div>
                      <StatusBadge status={c.status_tag} />
                    </div>
                    <div className="flex items-center gap-2 text-[10px] mb-2 flex-wrap">
                      <span className={`rounded-full px-2 py-0.5 font-bold border ${coachingBadge(c.coaching_type)}`}>
                        {coachingLabel(c.coaching_type)}
                      </span>
                      {c.assigned_coach_name && <span className="text-gray-500">Coach: {c.assigned_coach_name}</span>}
                      <span className="text-gray-400">{formatActivity(c)}</span>
                    </div>
                    <div className="flex gap-4 text-xs">
                      <div><span className="text-gray-400">7d </span><span className={`font-bold ${adherenceColor(c.adherence_7d)}`}>{Math.round(Number(c.adherence_7d) || 0)}%</span></div>
                      <div><span className="text-gray-400">30d </span><span className={`font-bold ${adherenceColor(c.adherence_30d)}`}>{Math.round(Number(c.adherence_30d) || 0)}%</span></div>
                    </div>
                    <div className="mt-3 pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${accountStatusBadgeClass(c)}`}>
                        {accountStatusLabel(c)}
                      </span>
                      <div className="flex gap-3">
                        {c.client_status === 'archived'
                          ? <span onClick={e => reactivateClient(e, c.id)} className="text-[11px] text-emerald-600 hover:text-emerald-700 font-semibold cursor-pointer">Reactivate</span>
                          : <span onClick={e => archiveClient(e, c.id)} className="text-[11px] text-gray-500 hover:text-gray-700 font-medium cursor-pointer">Archive</span>
                        }
                        <span onClick={e => deleteClient(e, c.id, c.first_name ?? 'this client')}
                          className="text-[11px] text-red-400 hover:text-red-600 font-medium cursor-pointer">Delete</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Food & Macros tab */}
      {activeTab === 'food-macros' && (
        <div>
          <p className="text-sm text-gray-500 mb-4">Set and manage macro targets for each client.</p>
          <FoodMacrosTab getToken={getToken} />
        </div>
      )}

      {/* Messaging tab */}
      {activeTab === 'messaging' && <AdminMessagingTab getToken={getToken} />}

      {/* Coach Foods tab */}
      {activeTab === 'coach-foods' && <CoachFoodsTab getToken={getToken} />}

      {/* Dev Tools tab (admin only) */}
      {activeTab === 'dev-tools' && isAdmin && <DevToolsTab getToken={getToken} />}

    </div>
  )
}
