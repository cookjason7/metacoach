import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useParams, useNavigate } from 'react-router-dom'
import { API_URL } from '../../config.js'

const TABS = [
  { id: 'overview',    label: 'Overview',  icon: '◉' },
  { id: 'nutrition',   label: 'Nutrition', icon: '🥗' },
  { id: 'habits',      label: 'Habits',    icon: '✓' },
  { id: 'progress',    label: 'Progress',  icon: '↗' },
  { id: 'assessment',  label: 'Forms',     icon: '★' },
  { id: 'notes',       label: 'Notes',     icon: '✎' },
  { id: 'messaging',   label: 'Messages',  icon: '✉' },
  { id: 'engagement',  label: 'Engagement', icon: '⚡' },
]

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

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ client, role, getToken, onUpdate }) {
  const [coaches, setCoaches] = useState([])
  const [editing, setEditing] = useState(false)
  const startDateInitial =
    client.start_date ? String(client.start_date).slice(0, 10) :
    client.effective_start_date ? String(client.effective_start_date).slice(0, 10) : ''
  const [form, setForm] = useState({
    coaching_type:     client.coaching_type ?? 'vip',
    assigned_coach_id: client.assigned_coach_id ?? '',
    role:              client.role ?? 'client',
    start_date:        startDateInitial,
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
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${client.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coaching_type:     form.coaching_type,
        assigned_coach_id: form.assigned_coach_id === '' ? null : Number(form.assigned_coach_id),
        role:              form.role,
        start_date:        form.start_date || null,
        phone_number:      form.phone_number || null,
        paid:              form.paid,
      }),
    })
    if (res.ok) { onUpdate(await res.json()); setEditing(false) }
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
              client.display_last_name,
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
                <InfoRow label="Coaching type"   value={client.coaching_type === 'ai' ? 'AI Coaching' : 'VIP Coaching'} />
                <InfoRow label="Assigned coach"  value={client.assigned_coach_name} emptyText="Not assigned yet" />
                <InfoRow label="Start date"      value={displayStartDate} />
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
                <label className="block text-xs font-medium text-gray-600 mb-1">Coaching type</label>
                <select value={form.coaching_type} onChange={e => setForm(f => ({ ...f, coaching_type: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                  <option value="vip">VIP Coaching</option>
                  <option value="ai">AI Coaching</option>
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
                <label className="block text-xs font-medium text-gray-600 mb-1">Start date</label>
                <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
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
              <button onClick={save} className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09]">Save changes</button>
              <button onClick={() => setEditing(false)} className="text-xs text-gray-500 px-3 py-2">Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Nutrition Targets — visible to admin and coaches (coaches only reach assigned clients) */}
      <NutritionTargetsCard
        client={client}
        getToken={getToken}
        onUpdate={onUpdate}
      />
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

  return (
    <div className="space-y-4">
      {/* 1. Date selector */}
      <div className="flex items-center gap-3">
        <input type="date" value={date} max={today}
          onChange={e => setDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30" />
        {date !== today && (
          <button onClick={() => setDate(today)} className="text-xs text-[#E8670A] font-medium hover:text-[#c45e09]">Today</button>
        )}
      </div>

      {/* 2. Nutrition Targets */}
      <NutritionTargetsCard client={client} getToken={getToken} onUpdate={onUpdate} />

      {/* 3. Selected Day Summary */}
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

      {/* 4. Food Log */}
      <FoodLogSection clientId={clientId} date={date} getToken={getToken} />

      {/* 5. 7-Day Averages */}
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
  { label: 'Drink water',     habit_name: 'Drink water',     habit_type: 'numeric',    unit: 'oz' },
  { label: 'Step goal',       habit_name: 'Step goal',       habit_type: 'numeric',    unit: 'steps' },
  { label: 'Complete workout',habit_name: 'Complete workout',habit_type: 'completion' },
  { label: 'Journal',         habit_name: 'Journal',         habit_type: 'boolean' },
  { label: 'Log food ahead',  habit_name: 'Log food ahead',  habit_type: 'boolean' },
]

// Full habit library grouped by category
const HABIT_LIBRARY = [
  {
    category: 'Nutrition',
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
    items: [
      { habit_name: 'Drink water',    habit_type: 'numeric', unit: 'oz' },
      { habit_name: 'Hit water goal', habit_type: 'numeric', unit: 'oz' },
    ],
  },
  {
    category: 'Movement',
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
    items: [
      { habit_name: 'Bedtime routine',         habit_type: 'boolean' },
      { habit_name: 'Digital detox before bed',habit_type: 'boolean' },
      { habit_name: 'Sleep target',            habit_type: 'numeric', unit: 'hours' },
    ],
  },
  {
    category: 'Progress',
    items: [
      { habit_name: 'Daily weight',          habit_type: 'boolean' },
      { habit_name: 'Progress photos',       habit_type: 'boolean' },
      { habit_name: 'Complete check-in form',habit_type: 'boolean' },
      { habit_name: 'Measurements',          habit_type: 'boolean' },
    ],
  },
]

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

// Build the next-N-days mini-calendar preview for the coach habit tab
function buildHabitPreview(habits, days = 14) {
  const result = []
  const today = new Date(); today.setHours(0,0,0,0)
  for (let i = 0; i < days; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i)
    const dKey = d.toISOString().slice(0, 10)
    const dDow = d.getDay()
    const dayHabits = habits.filter(h => {
      if (!h.active) return false
      const hStart = new Date(`${String(h.start_date).slice(0,10)}T00:00:00`)
      const hEnd   = h.end_date ? new Date(`${String(h.end_date).slice(0,10)}T00:00:00`) : null
      if (d < hStart) return false
      if (hEnd && d > hEnd) return false
      if (h.frequency === 'specific_days') {
        const allowed = (h.days_of_week ?? '').split(',').map(s => parseInt(s, 10))
        if (!allowed.includes(dDow)) return false
      }
      if (h.frequency === 'weekly' && dDow !== hStart.getDay()) return false
      return true
    })
    result.push({ date: d, dateKey: dKey, habits: dayHabits })
  }
  return result
}

function HabitsTab({ clientId, getToken }) {
  const [habits, setHabits] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [form, setForm] = useState({
    habit_name: '', habit_type: 'boolean', target_value: '', unit: '',
    frequency: 'daily', start_date: new Date().toISOString().slice(0, 10),
    end_date: '', days_of_week: '', notes: '',
  })

  const load = useCallback(async () => {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/habits`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setHabits(await res.json())
    setLoading(false)
  }, [clientId, getToken])

  useEffect(() => { load() }, [load])

  function applyPreset(p) {
    setForm(f => ({
      ...f,
      habit_name:   p.habit_name,
      habit_type:   p.habit_type,
      target_value: '',  // coach sets the goal
      unit:         p.unit ?? '',
      frequency:    'daily',
      start_date:   new Date().toISOString().slice(0, 10),
      end_date:     '',
      days_of_week: '',
      notes:        '',
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
        target_value: form.target_value !== '' ? Number(form.target_value) : null,
        end_date:     form.end_date || null,
        days_of_week: form.frequency === 'specific_days' ? (form.days_of_week || null) : null,
      }),
    })
    if (res.ok) {
      setForm({
        habit_name: '', habit_type: 'boolean', target_value: '', unit: '',
        frequency: 'daily', start_date: new Date().toISOString().slice(0, 10),
        end_date: '', days_of_week: '', notes: '',
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

  const previewDays = buildHabitPreview(habits, 14)

  return (
    <div className="space-y-4">
      {/* Quick presets */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <p className="text-xs font-semibold text-gray-700 mb-2">Quick assign</p>
        <div className="flex flex-wrap gap-2">
          {QUICK_PRESETS.map(p => (
            <button key={p.label} onClick={() => applyPreset(p)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border-2 border-gray-200 text-gray-700 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors">
              + {p.label}
            </button>
          ))}
          <button onClick={() => setShowForm(s => !s)}
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#E8670A] text-white hover:bg-[#c45e09]">
            + Custom habit
          </button>
          <button onClick={() => setShowLibrary(s => !s)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border-2 border-[#1e2a3a] text-[#1e2a3a] hover:bg-[#1e2a3a] hover:text-white transition-colors">
            📚 Full habit library
          </button>
        </div>
      </div>

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
                    <button key={item.habit_name} onClick={() => applyPreset(item)}
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
                  {h.notes && <p className="text-xs text-[#E8670A] italic mt-1">"{h.notes}"</p>}
                </div>
                <button onClick={() => deleteHabit(h.id)}
                  className="text-xs text-red-400 hover:text-red-600 font-medium shrink-0">Remove</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Client calendar preview — 14-day strip showing what the client will see */}
      {habits.length > 0 && (
        <div>
          <button onClick={() => setShowPreview(s => !s)}
            className="text-xs text-[#E8670A] hover:text-[#c45e09] font-semibold mb-2 flex items-center gap-1">
            {showPreview ? '▼' : '▶'} Preview client calendar (next 14 days)
          </button>
          {showPreview && (
            <div className="bg-white border border-gray-200 rounded-xl p-3">
              <div className="grid grid-cols-7 gap-1.5">
                {previewDays.map(({ date, dateKey, habits: dayHabits }, i) => {
                  const isToday = dateKey === new Date().toISOString().slice(0, 10)
                  return (
                    <div key={dateKey} className={`border rounded-lg p-1.5 min-h-[80px] ${
                      isToday ? 'border-[#E8670A] bg-orange-50' : 'border-gray-200 bg-white'
                    }`}>
                      <p className={`text-[10px] font-bold mb-1 ${isToday ? 'text-[#E8670A]' : 'text-gray-500'}`}>
                        {DAYS[date.getDay()]} {date.getDate()}
                      </p>
                      <div className="space-y-0.5">
                        {dayHabits.map(h => (
                          <div key={h.id} className="text-[9px] bg-emerald-50 text-emerald-800 px-1 py-0.5 rounded border border-emerald-100 truncate" title={h.habit_name}>
                            ○ {h.habit_name}
                          </div>
                        ))}
                        {dayHabits.length === 0 && <p className="text-[9px] text-gray-300">—</p>}
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="text-[10px] text-gray-400 mt-2 italic">
                This is what {''}<span className="font-semibold text-gray-600">your client will see</span> on their Calendar page.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Progress Tab ─────────────────────────────────────────────────────────────

function ProgressTab({ clientId, getToken }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/progress`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setData(await res.json())
      setLoading(false)
    }
    load()
  }, [clientId, getToken])

  if (loading) return <p className="text-sm text-gray-400 text-center py-8">Loading progress…</p>
  if (!data)   return <p className="text-sm text-red-500 text-center py-8">Failed to load progress.</p>

  const weights = data.weights ?? []
  const water = data.water ?? []
  const steps = data.steps ?? []
  const recentMeals = data.recent_meals ?? []
  const recentWorkouts = data.recent_workouts ?? []
  const progressPhotos = data.progress_photos ?? []
  const hasAnyProgress =
    weights.length > 0 ||
    water.length > 0 ||
    steps.length > 0 ||
    recentMeals.length > 0 ||
    recentWorkouts.length > 0 ||
    progressPhotos.length > 0

  function StatBox({ label, items, valueKey }) {
    const latest = items[0]
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <p className="text-xs text-gray-400 mb-1">{label}</p>
        <p className="text-2xl font-bold text-gray-900">
          {latest ? Number(latest[valueKey]).toLocaleString() : '—'}
        </p>
        <p className="text-[10px] text-gray-400 mt-0.5">
          {items.length > 0 ? `${items.length} log${items.length === 1 ? '' : 's'} · 30d` : 'No logs yet'}
        </p>
      </div>
    )
  }

  function SectionEmpty({ children }) {
    return (
      <p className="text-xs text-gray-400 bg-gray-50 border border-dashed border-gray-200 rounded-lg px-3 py-2">
        {children}
      </p>
    )
  }

  if (!hasAnyProgress) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Progress</h2>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-6 sm:p-8 text-center">
          <p className="text-2xl mb-2">↗</p>
          <p className="text-sm text-gray-500 max-w-xl mx-auto">
            Progress tracking will show this client's weight trends, measurements, progress photos, workout history, and wins once they start logging more data.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">Progress</h2>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatBox label="Latest weight (lbs)" items={weights} valueKey="weight_lbs" />
        <StatBox label="Latest water (oz)"   items={water}   valueKey="water_oz" />
        <StatBox label="Latest steps"        items={steps}   valueKey="steps" />
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-900 mb-2">Measurements</p>
          <SectionEmpty>Not logged yet.</SectionEmpty>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-900 mb-2">Recent wins</p>
          <SectionEmpty>Not logged yet.</SectionEmpty>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <p className="text-sm font-semibold text-gray-900 mb-3">Recent meals</p>
        {recentMeals.length === 0 && <SectionEmpty>Not logged yet.</SectionEmpty>}
        <div className="space-y-1.5">
          {recentMeals.map((m, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-gray-800 truncate">{m.meal_name}</span>
              <span className="text-gray-500 text-xs shrink-0 ml-2">
                {m.calories} cal · {fmtDate(m.logged_at)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <p className="text-sm font-semibold text-gray-900 mb-3">Recent workouts</p>
        {recentWorkouts.length === 0 && <SectionEmpty>Not logged yet.</SectionEmpty>}
        <div className="space-y-1.5">
          {recentWorkouts.map((w, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-gray-800 truncate">{w.workout_name ?? 'Workout'}</span>
              <span className="text-gray-500 text-xs shrink-0 ml-2">{fmtDate(w.completed_at)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <p className="text-sm font-semibold text-gray-900 mb-3">Progress photos</p>
        {progressPhotos.length === 0 ? (
          <SectionEmpty>Not logged yet.</SectionEmpty>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {progressPhotos.map((p, i) => (
              <div key={i} className="aspect-[3/4] rounded-lg overflow-hidden bg-gray-100">
                <img src={p.photo_url} alt={p.angle} className="w-full h-full object-cover" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Assessment Tab ───────────────────────────────────────────────────────────

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

function FormSubmissionsSection({ clientId, getToken }) {
  const [submissions, setSubmissions] = useState(undefined)
  const [loading,     setLoading]     = useState(true)
  const [openId,      setOpenId]      = useState(null)
  const [reviewing,   setReviewing]   = useState(null)   // subId in-flight
  const [savingNote,  setSavingNote]  = useState(null)   // subId in-flight
  const [noteDrafts,  setNoteDrafts]  = useState({})     // { [subId]: string }

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
    // Seed draft note from saved value if not already editing
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
        setSubmissions(prev => prev.map(s =>
          s.id === sub.id ? { ...s, coach_note: note.trim() || null } : s
        ))
      }
    } catch {}
    finally { setSavingNote(null) }
  }

  function ExpandedPanel({ sub }) {
    const schema = Array.isArray(sub.version_schema) ? sub.version_schema : []
    const draft  = noteDrafts[sub.id] ?? sub.coach_note ?? ''
    const isDirty = draft !== (sub.coach_note ?? '')

    return (
      <div className="space-y-4">
        {/* Answers */}
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

        {/* Note */}
        <div className="pt-3 border-t border-gray-200">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 font-bold mb-1">Staff Note</p>
          <textarea
            rows={2}
            value={draft}
            onChange={e => setNoteDrafts(prev => ({ ...prev, [sub.id]: e.target.value }))}
            placeholder="Add a note about this submission…"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
          {isDirty && (
            <button
              onClick={() => handleSaveNote(sub)}
              disabled={savingNote === sub.id}
              className="mt-1.5 text-xs bg-[#E8670A] text-white font-bold px-3 py-1.5 rounded-lg hover:bg-[#c45e09] disabled:opacity-50"
            >
              {savingNote === sub.id ? 'Saving…' : 'Save Note'}
            </button>
          )}
        </div>

        {/* Review action */}
        <div className="flex items-center justify-between pt-2 border-t border-gray-200">
          {sub.reviewed_at ? (
            <p className="text-xs text-emerald-700 font-semibold">
              Reviewed{sub.reviewed_by_name ? ` by ${sub.reviewed_by_name}` : ''} · {new Date(sub.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          ) : (
            <button
              onClick={() => handleMarkReviewed(sub)}
              disabled={reviewing === sub.id}
              className="text-xs bg-emerald-600 text-white font-bold px-3 py-1.5 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
            >
              {reviewing === sub.id ? 'Marking…' : 'Mark Reviewed'}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider mb-3">Form Submissions</p>
      {loading ? (
        <p className="text-sm text-gray-400 py-2">Loading…</p>
      ) : !submissions || submissions.length === 0 ? (
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-5 text-center">
          <p className="text-sm text-gray-500">No form submissions yet.</p>
        </div>
      ) : (
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
                {submissions.map(sub => {
                  const isOpen = openId === sub.id
                  return (
                    <>
                      <tr key={sub.id} className="border-t border-gray-100 hover:bg-gray-50/60 transition-colors">
                        <td className="px-4 py-3">
                          <p className="text-sm font-semibold text-gray-900 truncate max-w-[200px]">{sub.form_title}</p>
                          {sub.version_num && <p className="text-[10px] text-gray-400 mt-0.5">v{sub.version_num}</p>}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{fmtDateTime(sub.submitted_at)}</td>
                        <td className="px-4 py-3"><ReviewedBadge sub={sub} /></td>
                        <td className="px-4 py-3 text-xs text-gray-500 max-w-[140px]">
                          <span className="truncate block">{sub.coach_note || '—'}</span>
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
                        <tr key={sub.id + '_detail'}>
                          <td colSpan={5} className="px-4 pb-4 pt-2 bg-gray-50/60">
                            <ExpandedPanel sub={sub} />
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {submissions.map(sub => {
              const isOpen = openId === sub.id
              return (
                <div key={sub.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">{sub.form_title}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{fmtDateTime(sub.submitted_at)}</p>
                      </div>
                      <ReviewedBadge sub={sub} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500 truncate max-w-[60%]">
                        {sub.coach_note ? `Note: ${sub.coach_note}` : 'Notes: —'}
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
                      <ExpandedPanel sub={sub} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Weekly Check-Ins section (inside Forms tab) ──────────────────────────────

function WeeklyCheckinsSection({ clientId, getToken }) {
  const [checkins, setCheckins] = useState(undefined)
  const [loading, setLoading]   = useState(true)
  const [openId,  setOpenId]    = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/coach-admin/clients/${clientId}/checkins`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!cancelled) setCheckins(res.ok ? await res.json() : [])
      } catch { if (!cancelled) setCheckins([]) }
      finally  { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [clientId, getToken])

  function fmtWR(ws) {
    const [y, m, d] = ws.slice(0, 10).split('-').map(Number)
    const mon = new Date(y, m - 1, d)
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
    const f = (dt) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return `${f(mon)} – ${f(sun)}, ${y}`
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs font-bold text-[#E8670A] uppercase tracking-wider">Weekly Check-Ins</p>
        {!loading && checkins?.length > 0 && (
          <span className="text-[10px] bg-orange-100 text-[#E8670A] font-bold px-1.5 py-0.5 rounded-full">
            {checkins.length}
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 py-3">Loading check-ins…</p>
      ) : !checkins?.length ? (
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-6 text-center">
          <p className="text-sm text-gray-500">No weekly check-ins submitted yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {checkins.map(c => {
            const isOpen = openId === c.id
            return (
              <div key={c.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                {/* Summary row */}
                <button
                  onClick={() => setOpenId(isOpen ? null : c.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{fmtWR(c.week_start)}</p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 mt-0.5">
                      {c.energy             != null && <span className="text-xs text-gray-500">⚡ {c.energy}/5</span>}
                      {c.stress             != null && <span className="text-xs text-gray-500">😤 {c.stress}/5</span>}
                      {c.workouts_completed != null && <span className="text-xs text-gray-500">💪 {c.workouts_completed} workouts</span>}
                      {c.current_weight     != null && <span className="text-xs text-gray-500">⚖️ {c.current_weight} lbs</span>}
                    </div>
                  </div>
                  <svg className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-4">
                    {/* Ratings */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: 'Sleep',    val: c.sleep_quality },
                        { label: 'Energy',   val: c.energy },
                        { label: 'Stress',   val: c.stress },
                        { label: 'Cravings', val: c.cravings },
                      ].map(({ label, val }) => (
                        <div key={label}>
                          <p className="text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-1">{label}</p>
                          {val != null ? (
                            <span className="inline-flex gap-0.5">
                              {[1,2,3,4,5].map(n => (
                                <span key={n} className={`w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center ${
                                  n <= val ? 'bg-[#E8670A] text-white' : 'bg-gray-100 text-gray-300'
                                }`}>{n}</span>
                              ))}
                            </span>
                          ) : <span className="text-xs text-gray-400">—</span>}
                        </div>
                      ))}
                    </div>

                    {/* Activity counts */}
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label: 'Workouts',    val: c.workouts_completed },
                        { label: 'Days logged', val: c.days_food_logged },
                        { label: 'Hit protein', val: c.days_hit_protein },
                      ].map(({ label, val }) => (
                        <div key={label} className="text-center bg-gray-50 rounded-lg p-2">
                          <p className="text-xl font-bold text-gray-900 leading-tight">{val ?? '—'}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">{label}</p>
                        </div>
                      ))}
                    </div>

                    {/* Text answers */}
                    {[
                      { label: 'Biggest win',      val: c.biggest_win },
                      { label: 'Biggest struggle', val: c.biggest_struggle },
                      { label: 'Notes for coach',  val: c.coach_notes },
                    ].filter(x => x.val).map(({ label, val }) => (
                      <div key={label}>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-0.5">{label}</p>
                        <p className="text-sm text-gray-800 whitespace-pre-wrap">{val}</p>
                      </div>
                    ))}

                    {c.current_weight != null && (
                      <div>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wider font-bold mb-0.5">Weight</p>
                        <p className="text-sm text-gray-800">{c.current_weight} lbs</p>
                      </div>
                    )}

                    <p className="text-[10px] text-gray-300">
                      Submitted {new Date(c.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      {c.updated_at && c.updated_at !== c.submitted_at
                        ? ` · Updated ${new Date(c.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                        : ''}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
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

      {/* ── Form Submissions (always shown) ── */}
      <FormSubmissionsSection clientId={clientId} getToken={getToken} />

      {/* ── Weekly Check-Ins (always shown) ── */}
      <WeeklyCheckinsSection clientId={clientId} getToken={getToken} />

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
              <button onClick={() => deleteNote(n.id)} className="text-[10px] text-gray-400 hover:text-red-500 shrink-0">Delete</button>
            </div>
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{n.note_body}</p>
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
  const [messages, setMessages] = useState([])
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
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${client.id}/messages?thread=${thread}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setMessages(await res.json())
    setLoading(false)
  }, [client.id, thread, getToken])

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

  if (loading) return <p className="text-sm text-gray-400 text-center py-8">Loading engagement…</p>
  if (!stats)   return <p className="text-sm text-red-500 text-center py-8">Failed to load.</p>

  const foodLogs = Number(stats.food_logs_week) || 0
  const workouts = Number(stats.workouts_week) || 0
  const waterLogs = Number(stats.water_logs_week) || 0
  const stepLogs = Number(stats.step_logs_week) || 0
  const habitsComplete = Number(stats.habits_complete_week) || 0
  const habitsMissed = Number(stats.habits_missed_week) || 0
  const comebackCount = Number(stats.comeback_count) || 0
  const lastMealDays = stats.last_meal_at ? daysSince(stats.last_meal_at) : null
  const lastDailyLogDays = stats.last_daily_log ? daysSince(stats.last_daily_log) : null
  const lastActivityDays =
    [lastMealDays, lastDailyLogDays].filter(v => v !== null).sort((a, b) => a - b)[0] ?? null
  const hasActivity =
    foodLogs > 0 ||
    workouts > 0 ||
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
  if (workouts === 0) followUps.push('No workouts logged this week.')
  if (habitsMissed > habitsComplete) followUps.push('More missed habit days than completed days this week.')

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">Engagement</h2>
        <p className="text-sm text-gray-500 mt-1">
          Use this section to quickly see whether the client is staying active with their plan and where they may need follow-up.
        </p>
      </div>

      {!hasActivity ? (
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
            <Stat label="Workouts" value={workouts} sub="this week" />
            <Stat label="Habits" value={`${habitsComplete}/${habitsComplete + habitsMissed}`} sub="completed this week" />
          </div>

          <div>
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">What they logged recently</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Food" value={foodLogs || '—'} sub={foodLogs > 0 ? 'logs this week' : 'Not logged yet'} />
              <Stat label="Workouts" value={workouts || '—'} sub={workouts > 0 ? 'this week' : 'Not logged yet'} />
              <Stat label="Water" value={waterLogs || '—'} sub={waterLogs > 0 ? 'logs this week' : 'Not logged yet'} />
              <Stat label="Steps" value={stepLogs || '—'} sub={stepLogs > 0 ? 'logs this week' : 'Not logged yet'} />
            </div>
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
    </div>
  )
}

// ─── Main ClientProfile shell ─────────────────────────────────────────────────

export default function ClientProfile() {
  const { getToken } = useAuth()
  const { id } = useParams()
  const navigate = useNavigate()
  const [client, setClient] = useState(null)
  const [meRole, setMeRole] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('overview')

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
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">
          {[client.display_first_name || client.first_name, client.display_last_name].filter(Boolean).join(' ') || client.email?.split('@')[0] || 'Client'}
        </h1>
        <p className="text-sm text-gray-500">{client.email}</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-5 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="flex gap-1 min-w-max">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 sm:px-4 py-2.5 text-xs sm:text-sm font-semibold transition-colors border-b-2 whitespace-nowrap ${
                tab === t.id
                  ? 'border-[#E8670A] text-[#E8670A]'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              <span className="mr-1">{t.icon}</span>{t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'overview'   && <OverviewTab    client={client} role={meRole} getToken={getToken} onUpdate={u => setClient(c => ({ ...c, ...u }))} />}
      {tab === 'nutrition'  && <NutritionTab   client={client} clientId={client.id} getToken={getToken} onUpdate={u => setClient(c => ({ ...c, ...u }))} />}
      {tab === 'habits'     && <HabitsTab      clientId={client.id} getToken={getToken} />}
      {tab === 'progress'   && <ProgressTab    clientId={client.id} getToken={getToken} />}
      {tab === 'assessment' && <AssessmentTab  clientId={client.id} getToken={getToken} />}
      {tab === 'notes'      && <NotesTab       clientId={client.id} role={meRole} getToken={getToken} />}
      {tab === 'messaging'  && <MessagingTab   client={client} role={meRole} getToken={getToken} />}
      {tab === 'engagement' && <EngagementTab  clientId={client.id} getToken={getToken} />}
    </div>
  )
}
