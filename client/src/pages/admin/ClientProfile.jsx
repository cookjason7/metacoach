import { useState, useEffect, useCallback, Fragment, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { API_URL } from '../../config.js'
import BloodworkIntakeForm from '../../components/BloodworkIntakeForm.jsx'

const TABS = [
  { id: 'overview',    label: 'Overview',   icon: '◉' },
  { id: 'nutrition',   label: 'Nutrition',  icon: '🥗' },
  { id: 'habits',      label: 'Habits',     icon: '✓' },
  { id: 'progress',    label: 'Progress',   icon: '↗' },
  { id: 'assessment',  label: 'Forms',      icon: '★' },
  { id: 'notes',       label: 'Notes',      icon: '✎' },
  { id: 'messaging',   label: 'Messages',   icon: '✉' },
  { id: 'engagement',  label: 'Engagement', icon: '⚡' },
  { id: 'bloodwork',   label: 'Bloodwork',  icon: '🩸' },
]
// First 7 always visible; last 2 tucked behind "More ▾" so the row fits desktop without scrolling.
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

function fmtDob(iso) {
  if (!iso) return null
  const s = String(iso).slice(0, 10)
  const [y, m, d] = s.split('-')
  if (!y || !m || !d) return s
  return `${m}/${d}/${y}`
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
    first_name:        client.first_name ?? '',
    last_name:         client.last_name  ?? '',
    coaching_type:     client.coaching_type ?? 'vip',
    assigned_coach_id: client.assigned_coach_id ?? '',
    role:              client.role ?? 'client',
    start_date:        startDateInitial,
    program_end_date:  client.program_end_date ? String(client.program_end_date).slice(0, 10) : '',
    phone_number:      client.phone_number ?? '',
    paid:              client.paid ?? false,
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
          first_name:        form.first_name.trim()  || null,
          last_name:         form.last_name.trim()   || null,
          coaching_type:     form.coaching_type,
          assigned_coach_id: form.assigned_coach_id === '' ? null : Number(form.assigned_coach_id),
          role:              form.role,
          start_date:        form.start_date || null,
          program_end_date:  form.program_end_date || null,
          phone_number:      form.phone_number || null,
          paid:              form.paid,
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
    client.start_date ? String(client.start_date).slice(0, 10) :
    client.effective_start_date ? `${String(client.effective_start_date).slice(0, 10)} (auto)` :
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
                <InfoRow label="Coaching type"   value={client.coaching_type === 'ai' ? 'AI / Hybrid Coaching' : 'VIP / Human Coaching'} />
                <InfoRow label="Assigned coach"      value={client.assigned_coach_name} emptyText="Not assigned yet" />
                <InfoRow label="Program start date" value={displayStartDate} />
                <InfoRow label="Program end date"   value={client.program_end_date ? String(client.program_end_date).slice(0, 10) : null} emptyText="Not set" />
                <InfoRow label="Payment"         value={client.paid ? `✓ Active${client.paid_at ? ` (since ${String(client.paid_at).slice(0,10)})` : ''}` : '○ Not activated'} />
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
                <select value={form.coaching_type} onChange={e => setForm(f => ({ ...f, coaching_type: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                  <option value="vip">VIP / Human Coaching</option>
                  <option value="ai">AI / Hybrid Coaching</option>
                </select>
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
              <label className="block text-xs font-medium text-gray-600 mb-1">Assigned coach</label>
              <select value={form.assigned_coach_id} onChange={e => setForm(f => ({ ...f, assigned_coach_id: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                <option value="">Unassigned</option>
                {coaches.map(c => (
                  <option key={c.id} value={c.id}>{c.first_name ?? c.email} {c.email && c.first_name ? `· ${c.email}` : ''}</option>
                ))}
              </select>
              <p className="text-[10px] text-gray-400 mt-1">Only this coach (or admins) will see this client.</p>
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
            </div>
            <div className="flex items-center gap-2 bg-gray-50 rounded-lg p-3">
              <input type="checkbox" id="paid-check" checked={form.paid}
                onChange={e => setForm(f => ({ ...f, paid: e.target.checked }))}
                className="w-4 h-4 accent-[#E8670A]" />
              <label htmlFor="paid-check" className="text-sm text-gray-800">Account activated / paid</label>
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
  { key: 'goal_calories', label: 'Calories',     unit: 'kcal' },
  { key: 'goal_protein',  label: 'Protein',      unit: 'g' },
  { key: 'goal_carbs',    label: 'Carbs',        unit: 'g' },
  { key: 'goal_fat',      label: 'Fat',          unit: 'g' },
  { key: 'goal_fiber',    label: 'Fiber',        unit: 'g' },
  { key: 'goal_water',    label: 'Water',        unit: 'oz' },
]

function NutritionTargetsCard({ client, getToken, onUpdate }) {
  const [editing,    setEditing]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState(null)
  const [goalType,   setGoalType]   = useState('calories_protein') // 'calories_only' | 'calories_protein' | 'full_macros'
  const [fullMode,   setFullMode]   = useState('calculator')       // 'calculator' | 'percentage'
  const [autoTarget, setAutoTarget] = useState('fat')
  const [form, setForm] = useState({
    goal_calories: client.goal_calories ?? '',
    goal_protein:  client.goal_protein  ?? '',
    goal_carbs:    client.goal_carbs    ?? '',
    goal_fat:      client.goal_fat      ?? '',
    goal_fiber:    client.goal_fiber    ?? '',
    goal_water:    client.goal_water    ?? '',
  })
  const [pct, setPct] = useState({ protein: 30, carbs: 40, fat: 30 })

  // ── Derived values ───────────────────────────────────────────────────────────
  const cal   = Math.max(0, Number(form.goal_calories) || 0)
  const prot  = Math.max(0, Number(form.goal_protein)  || 0)
  const carbs = Math.max(0, Number(form.goal_carbs)    || 0)
  const fat   = Math.max(0, Number(form.goal_fat)      || 0)

  // Full Macros — calculator sub-mode
  const acRemain =
    autoTarget === 'fat'   ? cal - (prot  * 4 + carbs * 4) :
    autoTarget === 'carbs' ? cal - (prot  * 4 + fat   * 9) :
    /* protein */             cal - (carbs * 4 + fat   * 9)
  const acValue = acRemain > 0 ? Math.round(acRemain / (autoTarget === 'fat' ? 9 : 4)) : 0
  const acError = cal > 0 && acRemain < -50

  // Full Macros — percentage sub-mode
  const pctTotal   = pct.protein + pct.carbs + pct.fat
  const pctProtein = Math.max(0, Math.round(cal * pct.protein / 100 / 4))
  const pctCarbs   = Math.max(0, Math.round(cal * pct.carbs   / 100 / 4))
  const pctFat     = Math.max(0, Math.round(cal * pct.fat     / 100 / 9))

  const canSave = !saving &&
    !(goalType === 'full_macros' && fullMode === 'calculator' && acError)

  async function save() {
    if (goalType === 'full_macros' && fullMode === 'percentage' && pctTotal !== 100) {
      setError('Macro percentages must total 100% before saving.')
      return
    }
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const toInt = v => v !== '' ? Math.max(0, Math.round(Number(v))) : null
      const body = {
        goal_calories: toInt(form.goal_calories),
        goal_fiber:    toInt(form.goal_fiber),
        goal_water:    toInt(form.goal_water),
        goal_protein:  null,
        goal_carbs:    null,
        goal_fat:      null,
      }
      if (goalType === 'calories_protein') {
        body.goal_protein = toInt(form.goal_protein)
      } else if (goalType === 'full_macros') {
        if (fullMode === 'percentage') {
          body.goal_protein = pctProtein
          body.goal_carbs   = pctCarbs
          body.goal_fat     = pctFat
        } else {
          body.goal_protein = autoTarget === 'protein' ? acValue : Math.round(prot)
          body.goal_carbs   = autoTarget === 'carbs'   ? acValue : Math.round(carbs)
          body.goal_fat     = autoTarget === 'fat'     ? acValue : Math.round(fat)
        }
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
    { id: 'calories_only',    label: 'Calories Only',       desc: 'Track calories, fiber, and water.' },
    { id: 'calories_protein', label: 'Calories + Protein',  desc: 'Most common. Add a protein target.' },
    { id: 'full_macros',      label: 'Full Macros',         desc: 'Set all macros with auto-calculation.' },
  ]

  const fiberWater = (
    <div className="grid grid-cols-2 gap-3 pt-1">
      {[['goal_fiber','Fiber','g'],['goal_water','Water','oz']].map(([fkey, label, unit]) => (
        <div key={fkey}>
          <label className="block text-xs font-medium text-gray-600 mb-1">{label} <span className="text-gray-400">({unit})</span></label>
          <input type="number" min="0" value={form[fkey]}
            onChange={e => setForm(f => ({ ...f, [fkey]: e.target.value }))}
            placeholder="—" className={inputCls} />
        </div>
      ))}
    </div>
  )

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
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Calories <span className="text-gray-400">(kcal)</span></label>
                <input type="number" min="0" value={form.goal_calories}
                  onChange={e => setForm(f => ({ ...f, goal_calories: e.target.value }))}
                  placeholder="—" className={inputCls} />
              </div>
              {fiberWater}
            </div>
          )}

          {/* ── Calories + Protein ── */}
          {goalType === 'calories_protein' && (
            <div className="space-y-3">
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
              {fiberWater}
            </div>
          )}

          {/* ── Full Macros ── */}
          {goalType === 'full_macros' && (
            <div className="space-y-3">
              {/* Sub-mode tabs */}
              <div className="flex gap-2">
                {[['calculator','Calculator'],['percentage','Percentage']].map(([id, label]) => (
                  <button key={id} onClick={() => setFullMode(id)}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                      fullMode === id ? 'bg-[#1e2a3a] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}>{label}</button>
                ))}
              </div>

              {/* Calculator sub-mode */}
              {fullMode === 'calculator' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 bg-gray-50 rounded-lg px-3 py-2.5">
                    <p className="text-xs font-medium text-gray-500 whitespace-nowrap">Calculate:</p>
                    <div className="flex gap-1.5">
                      {[['fat','Fat'],['carbs','Carbs'],['protein','Protein']].map(([id, label]) => (
                        <button key={id} onClick={() => setAutoTarget(id)}
                          className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                            autoTarget === id ? 'bg-[#E8670A] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-100'
                          }`}>{label}</button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Calories <span className="text-gray-400">(kcal)</span></label>
                      <input type="number" min="0" value={form.goal_calories}
                        onChange={e => setForm(f => ({ ...f, goal_calories: e.target.value }))}
                        placeholder="—" className={inputCls} />
                    </div>
                    {[
                      { key: 'goal_protein', label: 'Protein', id: 'protein' },
                      { key: 'goal_carbs',   label: 'Carbs',   id: 'carbs'   },
                      { key: 'goal_fat',     label: 'Fat',     id: 'fat'     },
                    ].map(({ key, label, id }) => (
                      <div key={id}>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          {label} <span className="text-gray-400">(g)</span>
                          {autoTarget === id && <span className="ml-1 text-[#E8670A] font-semibold">= calc</span>}
                        </label>
                        {autoTarget === id ? (
                          <div className={acError ? computedErrCls : computedCls}>
                            {acError ? '—' : acValue}
                          </div>
                        ) : (
                          <input type="number" min="0" value={form[key]}
                            onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                            placeholder="—" className={inputCls} />
                        )}
                      </div>
                    ))}
                  </div>

                  {cal > 0 && (
                    <div className={`rounded-lg px-3 py-2 text-xs ${acError ? 'bg-red-50 border border-red-200 text-red-600 font-medium' : 'bg-gray-50 text-gray-500'}`}>
                      {acError
                        ? `⚠ Entered macros exceed ${cal} kcal — reduce values to enable Save`
                        : `${Math.max(0, acRemain)} kcal remaining → ${autoTarget} = ${acValue} g`}
                    </div>
                  )}
                </div>
              )}

              {/* Percentage sub-mode */}
              {fullMode === 'percentage' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Calories <span className="text-gray-400">(kcal)</span></label>
                    <input type="number" min="0" value={form.goal_calories}
                      onChange={e => setForm(f => ({ ...f, goal_calories: e.target.value }))}
                      placeholder="—" className={inputCls} />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {['protein', 'carbs', 'fat'].map(k => (
                      <div key={k}>
                        <label className="block text-xs font-medium text-gray-600 mb-1 capitalize">{k} %</label>
                        <input type="number" min="0" max="100" value={pct[k]}
                          onChange={e => setPct(p => ({ ...p, [k]: Number(e.target.value) }))}
                          className={inputCls} />
                      </div>
                    ))}
                  </div>
                  <p className={`text-[11px] font-medium ${pctTotal === 100 ? 'text-emerald-600' : 'text-amber-500'}`}>
                    Total: {pctTotal}% {pctTotal === 100 ? '✓' : '— must equal 100% to save'}
                  </p>
                  <div className="bg-gray-50 rounded-lg p-3 grid grid-cols-3 gap-3">
                    {[['Protein', pctProtein, 'g'], ['Carbs', pctCarbs, 'g'], ['Fat', pctFat, 'g']].map(([label, val]) => (
                      <div key={label}>
                        <p className="text-[10px] text-gray-400 mb-1">{label}</p>
                        <div className={computedCls}>{val} g</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {fiberWater}
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
  const slotsPresent = SLOT_DISPLAY_ORDER.filter(s => grouped[s]?.length)

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
  const today = new Date().toISOString().slice(0, 10)
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
    { value: '-750', label: '−750 kcal (aggressive deficit)' },
    { value: '-500', label: '−500 kcal (deficit)' },
    { value: '-250', label: '−250 kcal (mild deficit)' },
    { value: '0',    label: 'Maintenance' },
    { value: '250',  label: '+250 kcal (mild surplus)' },
    { value: '500',  label: '+500 kcal (surplus)' },
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

function NutritionTab({ client, clientId, getToken, onUpdate }) {
  const today = new Date().toISOString().slice(0, 10)
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
  { label: 'Journal',         habit_name: 'Journal',         habit_type: 'boolean',                  identity_category: 'mindset' },
  { label: 'Log food ahead',  habit_name: 'Log food ahead',  habit_type: 'boolean',                  identity_category: 'food_tracking' },
]

// Full habit library grouped by category
const HABIT_LIBRARY = [
  {
    category: 'Nutrition',
    identity_category: 'food_tracking',
    items: [
      { habit_name: 'Hit protein goal',         habit_type: 'numeric', unit: 'g' },
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

// Build a full-month grid for the coach habit calendar preview
function buildMonthCalendar(habits) {
  const today = new Date(); today.setHours(0,0,0,0)
  const todayKey = today.toISOString().slice(0, 10)
  const year = today.getFullYear()
  const month = today.getMonth()
  const firstDay = new Date(year, month, 1)
  const lastDay  = new Date(year, month + 1, 0)
  const monthName = firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  const cells = []
  // Pad days before month start
  for (let i = 0; i < firstDay.getDay(); i++) {
    const d = new Date(firstDay); d.setDate(d.getDate() - (firstDay.getDay() - i))
    cells.push({ date: d, dateKey: d.toISOString().slice(0,10), habits: [], inMonth: false, isToday: false })
  }
  // Days in month
  for (let n = 1; n <= lastDay.getDate(); n++) {
    const d = new Date(year, month, n)
    const dateKey = d.toISOString().slice(0, 10)
    cells.push({ date: d, dateKey, habits: habits.filter(h => habitActiveOnDay(h, d)), inMonth: true, isToday: dateKey === todayKey })
  }
  // Pad end of last week
  const tail = cells.length % 7
  if (tail > 0) {
    let pad = new Date(lastDay); pad.setDate(pad.getDate() + 1)
    for (let i = 0; i < 7 - tail; i++) {
      cells.push({ date: pad, dateKey: pad.toISOString().slice(0,10), habits: [], inMonth: false, isToday: false })
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
  const now = new Date()
  const todayKey = now.toISOString().slice(0, 10)
  const dots = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
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

function HabitsTab({ clientId, getToken }) {
  const [habits, setHabits] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [form, setForm] = useState({
    habit_name: '', habit_type: 'boolean', target_value: '', unit: '',
    frequency: 'daily', start_date: new Date().toISOString().slice(0, 10),
    end_date: '', days_of_week: '', notes: '', identity_category: '',
  })
  const [compCalendar, setCompCalendar] = useState(null)
  const [compLoading, setCompLoading] = useState(false)
  const [compError, setCompError] = useState(null)

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

  function applyPreset(p) {
    setForm(f => ({
      ...f,
      habit_name:        p.habit_name,
      habit_type:        p.habit_type,
      target_value:      '',  // coach sets the goal
      unit:              p.unit ?? '',
      frequency:         'daily',
      start_date:        new Date().toISOString().slice(0, 10),
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
    if (!form.habit_name.trim() || !form.start_date) return
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
    if (res.ok) {
      setForm({
        habit_name: '', habit_type: 'boolean', target_value: '', unit: '',
        frequency: 'daily', start_date: new Date().toISOString().slice(0, 10),
        end_date: '', days_of_week: '', notes: '', identity_category: '',
      })
      setShowForm(false)
      load()
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

  const monthCal = buildMonthCalendar(habits)

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
          {habits.length > 0 && (
            <button onClick={() => setShowPreview(s => !s)}
              className="px-2 py-1 rounded-lg text-xs font-medium border border-[#1e2a3a] text-[#1e2a3a] hover:bg-[#1e2a3a] hover:text-white transition-colors">
              📅 {showPreview ? 'Hide Calendar' : 'Habit Calendar'}
            </button>
          )}
        </div>
      </div>

      {/* Month habit calendar */}
      {showPreview && habits.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">📅 {monthCal.monthName} — Client habit view</p>
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DAYS.map(d => (
              <p key={d} className="text-[10px] font-bold text-gray-400 text-center py-1">{d}</p>
            ))}
          </div>
          {monthCal.weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7 gap-1 mb-1">
              {week.map(({ date, dateKey, habits: dayHabits, inMonth, isToday }) => (
                <div key={dateKey} className={`border rounded-lg p-1 min-h-[68px] ${
                  !inMonth ? 'border-transparent bg-gray-50/40 opacity-40' :
                  isToday  ? 'border-[#E8670A] bg-orange-50' : 'border-gray-200 bg-white'
                }`}>
                  <p className={`text-[10px] font-bold leading-tight mb-0.5 ${isToday ? 'text-[#E8670A]' : inMonth ? 'text-gray-600' : 'text-gray-300'}`}>
                    {date.getDate()}
                  </p>
                  <div className="space-y-0.5">
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
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
              <select value={form.habit_type} onChange={e => setForm(f => ({ ...f, habit_type: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white">
                <option value="boolean">Boolean (yes/no)</option>
                <option value="numeric">Numeric (count/oz)</option>
                <option value="completion">Completion</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Target</label>
              <input type="number" value={form.target_value} onChange={e => setForm(f => ({ ...f, target_value: e.target.value }))}
                placeholder="48"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
              <input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
                placeholder="oz / steps"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
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
            <label className="block text-xs font-medium text-gray-600 mb-1">Identity category</label>
            <select value={form.identity_category} onChange={e => setForm(f => ({ ...f, identity_category: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">— None —</option>
              <option value="food_tracking">Food Tracking</option>
              <option value="movement">Movement</option>
              <option value="mindset">Mindset</option>
              <option value="check_ins">Check-Ins</option>
              <option value="progress">Progress</option>
            </select>
          </div>
          {/* Coach note field hidden — notes column preserved in DB; existing
              notes still display on assigned habit cards below. */}
          <div className="flex gap-2">
            <button onClick={submit} className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09]">Assign Habit</button>
            <button onClick={() => setShowForm(false)} className="text-sm text-gray-500 px-3 py-2">Cancel</button>
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
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Target</label>
                      <input type="number" value={editForm.target_value} onChange={e => setEditForm(f => ({ ...f, target_value: e.target.value }))}
                        placeholder="—" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                      <input value={editForm.unit} onChange={e => setEditForm(f => ({ ...f, unit: e.target.value }))}
                        placeholder="oz / steps" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
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
                        {{food_tracking:'Food Tracking',movement:'Movement',mindset:'Mindset',check_ins:'Check-Ins',progress:'Progress'}[h.identity_category] ?? h.identity_category}
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
    measurement_date: new Date().toISOString().slice(0, 10),
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
        setMForm({ measurement_date: new Date().toISOString().slice(0, 10), chest: '', waist: '', hips: '' })
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
  const vals1 = (series ?? []).map(d => Number(d[valueKey]) || 0)
  const vals2 = series2 ? (series2 ?? []).map(d => Number(d[valueKey2 ?? valueKey]) || 0) : []
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

function ChartCard({ title, legend, series, valueKey, series2, valueKey2, color, color2 }) {
  const points = (series ?? []).filter(d => d[valueKey] != null && Number.isFinite(Number(d[valueKey])))
  const hasEnoughData = points.length >= 2
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <p className="text-xs font-semibold text-gray-700">{title}</p>
        {legend && <div className="flex items-center gap-3 text-[10px] text-gray-400">{legend}</div>}
      </div>
      {hasEnoughData
        ? <MiniChart series={series} valueKey={valueKey} series2={series2} valueKey2={valueKey2} color={color} color2={color2} />
        : <p className="text-[11px] text-gray-300 text-center py-6">Need 2+ entries to chart.</p>}
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

function ProgressTab({ clientId, clientName, getToken }) {
  const [range,       setRange]       = useState('daily')
  const [foodLogDate, setFoodLogDate] = useState(null)
  const today = new Date().toISOString().slice(0, 10)
  const thirtyDaysAgo = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
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

  const weightCurrent      = data?.weight_current      ?? null
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
          {/* Summary cards — no Movement */}
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
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
              label="Avg protein"
              value={s.avg_protein ? `${s.avg_protein}g` : '—'}
              sub="per logged day"
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

          {/* Averages & Trends table — above charts */}
          {rows.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <p className="text-sm font-semibold text-gray-900 px-4 py-3 border-b border-gray-100">Averages &amp; Trends</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[640px]">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500 text-[10px] uppercase tracking-wide">
                      <th className="px-3 py-2 text-left font-semibold sticky left-0 bg-gray-50">Period</th>
                      <th className="px-2 py-2 text-right font-semibold">Weight</th>
                      <th className="px-2 py-2 text-right font-semibold">Cal</th>
                      <th className="px-2 py-2 text-right font-semibold">Pro</th>
                      <th className="px-2 py-2 text-right font-semibold">Fat</th>
                      <th className="px-2 py-2 text-right font-semibold">Fiber</th>
                      <th className="px-2 py-2 text-right font-semibold">Sodium</th>
                      <th className="px-2 py-2 text-right font-semibold">Sugar</th>
                      <th className="px-2 py-2 text-left font-semibold">Goals</th>
                      <th className="px-2 py-2 text-right font-semibold">Steps</th>
                      <th className="px-2 py-2 text-right font-semibold">Sleep</th>
                      <th className="px-2 py-2 text-right font-semibold">H₂O</th>
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
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums whitespace-nowrap">{r.weight   ? `${r.weight} lbs`                       : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums font-medium">{r.calories  ? Number(r.calories).toLocaleString()          : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.protein   ? `${r.protein}g`                                         : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.fat       ? `${r.fat}g`                                             : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.fiber     ? `${r.fiber}g`                                           : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.sodium_mg ? `${Number(r.sodium_mg).toLocaleString()}mg`             : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.sugar     ? `${r.sugar}g`                                           : '—'}</td>
                          <td className="px-2 py-2 text-left text-[10px] text-gray-400 whitespace-nowrap">{gt ?? '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.steps      ? Number(r.steps).toLocaleString()                      : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.sleep_minutes != null ? fmtSleep(r.sleep_minutes)                  : '—'}</td>
                          <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{r.water_oz  ? `${r.water_oz} oz`                                     : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Charts — no Movement per Period */}
          <div className="grid sm:grid-cols-2 gap-4">
            <ChartCard title="Weight (lbs)" series={wt} valueKey="value" />
            <ChartCard
              title="Calories & Protein"
              legend={<><span style={{ color: '#E8670A' }}>— Cal</span><span style={{ color: '#10b981' }}>- - Prot</span></>}
              series={mac} valueKey="calories"
              series2={mac} valueKey2="protein" color2="#10b981"
            />
            <ChartCard title="Daily Steps" series={stp} valueKey="value" />
            <ChartCard title="Sleep (hrs)" series={slpHrs} valueKey="value" color="#6366f1" />
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
                                  <button
                                    type="button"
                                    onClick={() => deleteProgressPhoto(p.id)}
                                    className="mt-1 min-h-8 w-full rounded-lg border border-red-100 text-[10px] font-semibold text-red-600"
                                  >
                                    Delete
                                  </button>
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

        <div className="flex items-center justify-between pt-2 border-t border-gray-200">
          {sub.reviewed_at ? (
            <p className="text-xs text-emerald-700 font-semibold">
              Reviewed{sub.reviewed_by_name ? ` by ${sub.reviewed_by_name}` : ''} · {new Date(sub.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
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

  const checkIns   = submissions?.filter(isCheckInSubmission) ?? []
  const otherForms = submissions?.filter(s => !isCheckInSubmission(s)) ?? []

  return (
    <div className="space-y-6">
      {/* Check-Ins section */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider">Check-Ins</p>
          {!loading && checkIns.length > 0 && (
            <span className="text-[10px] bg-orange-100 text-[#E8670A] font-bold px-1.5 py-0.5 rounded-full">
              {checkIns.length}
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
            <span className="text-[10px] bg-orange-100 text-[#E8670A] font-bold px-1.5 py-0.5 rounded-full">
              {otherForms.length}
            </span>
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

function MessagingTab({ client, role, getToken }) {
  const isAI = client.coaching_type === 'ai'
  const initialThread = isAI ? 'ai_admin' : 'coach_thread'
  const [thread, setThread] = useState(initialThread)
  const [messages,     setMessages]     = useState([])
  const [hasMore,      setHasMore]      = useState(false)
  const [nextBeforeId, setNextBeforeId] = useState(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  const availableThreads = []
  if (isAI) {
    if (role === 'admin') availableThreads.push({ id: 'ai_admin', label: 'AI ↔ Admin', icon: '🤖' })
  } else {
    availableThreads.push({ id: 'coach_thread', label: 'Coach Thread', icon: '💬' })
    if (role === 'admin') availableThreads.push({ id: 'admin_private', label: 'Admin Private', icon: '🔒' })
  }

  const load = useCallback(async () => {
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
  }, [client.id, thread, getToken])

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

  useEffect(() => { load() }, [load])

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

  if (availableThreads.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
        <p className="text-sm text-gray-500">This is an AI coaching client. Only admins can message AI clients unless you're assigned as their coach.</p>
      </div>
    )
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
          {messages.map(m => {
            const isStaff = m.sender_role === 'admin' || m.sender_role === 'coach'
            return (
              <div key={m.id} className={`flex ${isStaff ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                  isStaff
                    ? 'bg-[#E8670A] text-white'
                    : 'bg-white border border-gray-200 text-gray-800'
                }`}>
                  <p className="text-[10px] font-semibold opacity-70 mb-0.5">
                    {m.sender_name ?? m.sender_role} · {new Date(m.created_at).toLocaleString()}
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{m.message_body}</p>
                  {isStaff && m.read_at && (
                    <p className="text-[9px] opacity-60 text-right mt-0.5">
                      Read {new Date(m.read_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Compose */}
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

      {thread === 'admin_private' && (
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
          🔒 This thread is admin-only. Coaches cannot see these messages.
        </p>
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
      const data = await res.json()
      if (!res.ok) { alert(data.error ?? 'Summary failed.'); return }
      setUploads(prev => prev.map(u => u.id === id ? { ...u, ai_summary: data.ai_summary } : u))
    } catch { alert('Summary failed. Please try again.') }
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
                    <div className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">{u.ai_summary}</div>
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

// ─── Main ClientProfile shell ─────────────────────────────────────────────────

export default function ClientProfile() {
  const { getToken } = useAuth()
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [client, setClient] = useState(null)
  const [meRole, setMeRole] = useState(null)
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
        const typeLabel  = client.coaching_type
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
      {tab === 'habits'     && <HabitsTab      clientId={client.id} getToken={getToken} />}
      {tab === 'progress'   && <ProgressTab    clientId={client.id} getToken={getToken} clientName={[client.display_first_name || client.first_name, client.display_last_name || client.last_name].filter(Boolean).join(' ') || client.email?.split('@')[0] || null} />}
      {tab === 'assessment' && <AssessmentTab  clientId={client.id} getToken={getToken} />}
      {tab === 'notes'      && <NotesTab       clientId={client.id} role={meRole} getToken={getToken} />}
      {tab === 'messaging'  && <MessagingTab   client={client} role={meRole} getToken={getToken} />}
      {tab === 'engagement' && <EngagementTab  clientId={client.id} getToken={getToken} />}
      {tab === 'bloodwork'  && <BloodworkTab   clientId={client.id} getToken={getToken} bloodworkEnabled={client.bloodwork_enabled ?? false} onClientUpdate={u => setClient(c => ({ ...c, ...u }))} client={client} />}
    </div>
  )
}
