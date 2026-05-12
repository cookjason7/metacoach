import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'
import { API_URL } from '../config.js'
import FoodSourceBadge from '../components/FoodSourceBadge.jsx'

const SERVING_UNITS = ['g', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'ml', 'fl oz']

// ── helpers ──────────────────────────────────────────────────────────────────

function daysSince(isoString) {
  if (!isoString) return null
  return Math.floor((Date.now() - new Date(isoString)) / (1000 * 60 * 60 * 24))
}

// ── Clients section ───────────────────────────────────────────────────────────

function MacroForm({ client, getToken, onSaved }) {
  const [form, setForm] = useState({
    goal_calories: client.goal_calories ?? '',
    goal_protein:  client.goal_protein  ?? '',
    goal_carbs:    client.goal_carbs    ?? '',
    goal_fat:      client.goal_fat      ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  function set(field, value) { setForm(f => ({ ...f, [field]: value })) }

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
  const [data,    setData]    = useState(undefined) // undefined=not loaded, null=none
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/admin/assessments/${clientId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setData(await res.json())
        else setData(null)
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
      {/* Section 1 */}
      <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider">Contact & Info</p>
      <div className="space-y-1">
        <Row label="Full name"    value={[data.first_name, data.last_name].filter(Boolean).join(' ') || null} />
        <Row label="Phone"        value={data.phone} />
        {/* Structured address — show assembled line if fields present, fall back to legacy */}
        {(data.street_address || data.city || data.state) ? (
          <div className="flex gap-2">
            <span className="text-xs text-gray-400 shrink-0 w-32">Address</span>
            <div className="text-xs text-gray-800 font-medium">
              {data.street_address && <div>{data.street_address}</div>}
              <div>
                {[data.city, data.state].filter(Boolean).join(', ')}
                {data.zip_code ? ` ${data.zip_code}` : ''}
              </div>
              {data.country && data.country !== 'United States' && <div>{data.country}</div>}
            </div>
          </div>
        ) : (
          <Row label="Address" value={data.address} />
        )}
        <Row label="Date of birth" value={data.date_of_birth ? data.date_of_birth.slice(0,10) : null} />
        <Row label="Shirt size"   value={data.shirt_size} />
        <Row label="Coach name"   value={data.coach_name} />
      </div>

      {/* Section 2 */}
      <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider">About You</p>
      <div className="space-y-1">
        <Row label="Occupation"   value={data.occupation} />
        <Row label="Kids"         value={data.num_kids != null ? String(data.num_kids) : null} />
        <Row label="6-mo goals"   value={data.goals_6_months} />
        <Row label="Supplements"  value={data.supplements} />
        <Row label="Injuries"     value={data.injuries_limitations} />
      </div>

      {/* Section 3 */}
      <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider">Energy & Lifestyle</p>
      <div className="space-y-1.5">
        <div className="flex gap-2 items-center">
          <span className="text-xs text-gray-400 shrink-0 w-32">Energy</span>
          <Rating value={data.energy_level} />
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-xs text-gray-400 shrink-0 w-32">Sleep quality</span>
          <Rating value={data.sleep_quality} />
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-xs text-gray-400 shrink-0 w-32">Stress mgmt</span>
          <Rating value={data.stress_management} />
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-xs text-gray-400 shrink-0 w-32">Happiness</span>
          <Rating value={data.happiness_level} />
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-xs text-gray-400 shrink-0 w-32">Confidence</span>
          <Rating value={data.confidence_level} />
        </div>
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

function ClientRow({ client, getToken, onUpdate }) {
  const [editing,         setEditing]         = useState(false)
  const [assessmentOpen,  setAssessmentOpen]  = useState(false)
  const inactive = daysSince(client.last_meal_at)

  function handleSaved(updated) { if (updated) onUpdate(updated); setEditing(false) }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{client.first_name ?? 'Unknown'}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {inactive === null ? 'No meals logged' : inactive === 0 ? 'Logged today' : `Last log: ${inactive}d ago`}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500 shrink-0 flex-wrap justify-end">
          <span title="Calories">{client.goal_calories ? `${client.goal_calories} cal` : '—'}</span>
          <span title="Protein">{client.goal_protein  ? `${client.goal_protein}g P`  : '—'}</span>
          <span title="Carbs">{client.goal_carbs    ? `${client.goal_carbs}g C`    : '—'}</span>
          <span title="Fat">{client.goal_fat      ? `${client.goal_fat}g F`      : '—'}</span>
          <button onClick={() => { setEditing(e => !e); setAssessmentOpen(false) }}
            className="text-[#E8670A] hover:text-[#c45e09] font-medium transition-colors">
            {editing ? 'Close' : 'Macros'}
          </button>
          <button onClick={() => { setAssessmentOpen(o => !o); setEditing(false) }}
            className="text-[#E8670A] hover:text-[#c45e09] font-medium transition-colors">
            {assessmentOpen ? 'Close' : 'Assessment'}
          </button>
        </div>
      </div>
      {editing       && <MacroForm client={client} getToken={getToken} onSaved={handleSaved} />}
      {assessmentOpen && <AssessmentPanel clientId={client.id} getToken={getToken} />}
    </div>
  )
}

// ── Coach Foods section ───────────────────────────────────────────────────────

const EMPTY_FORM = {
  food_name: '', calories: '', protein: '', carbs: '', fat: '', fiber: '',
  serving_size: '100', serving_unit: 'g', notes: '',
}

function CoachFoodsSection({ getToken }) {
  const [coachFoods,    setCoachFoods]    = useState([])
  const [loading,       setLoading]       = useState(true)
  const [showCreate,    setShowCreate]    = useState(false)
  const [form,          setForm]          = useState(EMPTY_FORM)
  const [saving,        setSaving]        = useState(false)
  const [saveErr,       setSaveErr]       = useState(null)
  const [searchQ,       setSearchQ]       = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching,     setSearching]     = useState(false)
  const [deletingId,    setDeletingId]    = useState(null)
  const debounceRef = useRef(null)

  // Load all current coach foods
  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/admin/coach-foods`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) setCoachFoods(await res.json())
      } finally { setLoading(false) }
    }
    load()
  }, [getToken])

  // Search existing foods to prefill create form
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

  // Prefill the create form from a search result
  function prefillFromFood(food) {
    // All search results are per-100g — default serving 100g
    setForm({
      food_name:    food.name,
      calories:     food.calories     != null ? String(Math.round(food.calories))    : '',
      protein:      food.protein_g    != null ? String(Number(food.protein_g))       : '',
      carbs:        food.carbs_g      != null ? String(Number(food.carbs_g))         : '',
      fat:          food.fat_g        != null ? String(Number(food.fat_g))           : '',
      fiber:        food.fiber_g      != null ? String(Number(food.fiber_g))         : '',
      serving_size: '100',
      serving_unit: 'g',
      notes:        '',
    })
    setSearchQ('')
    setSearchResults([])
    setShowCreate(true)
  }

  function setF(e) { setForm(f => ({ ...f, [e.target.name]: e.target.value })) }

  async function createCoachFood(e) {
    e.preventDefault()
    if (!form.food_name.trim()) return
    setSaving(true); setSaveErr(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/coach-foods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          food_name:    form.food_name.trim(),
          calories:     form.calories     !== '' ? Number(form.calories)     : null,
          protein:      form.protein      !== '' ? Number(form.protein)      : null,
          carbs:        form.carbs        !== '' ? Number(form.carbs)        : null,
          fat:          form.fat          !== '' ? Number(form.fat)          : null,
          fiber:        form.fiber        !== '' ? Number(form.fiber)        : null,
          serving_size: form.serving_size !== '' ? Number(form.serving_size) : 100,
          serving_unit: form.serving_unit || 'g',
          notes:        form.notes.trim() || null,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed')
      const created = await res.json()
      setCoachFoods(prev => [...prev, created].sort((a, b) => a.food_name.localeCompare(b.food_name)))
      setForm(EMPTY_FORM)
      setShowCreate(false)
    } catch (err) { setSaveErr(err.message) } finally { setSaving(false) }
  }

  async function removeCoachFood(id) {
    setDeletingId(id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/coach-foods/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setCoachFoods(prev => prev.filter(f => f.id !== id))
    } finally { setDeletingId(null) }
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Coach foods appear to all clients with a <span className="font-semibold text-[#E8670A]">⭐ Coach food</span> badge in search results.
      </p>

      {/* ── Search to prefill ── */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Find &amp; promote an existing food</h3>
        <div className="relative">
          <input
            type="text" value={searchQ} onChange={handleSearch}
            placeholder="Search foods to add as coach food…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
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
                  {food.calories != null ? `${Math.round(food.calories)} cal` : ''} ·
                  {food.protein_g != null ? ` ${Number(food.protein_g).toFixed(1)}g P` : ''} per 100g
                </p>
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-400 mt-2">Click a food to pre-fill the create form below.</p>
      </div>

      {/* ── Create form ── */}
      <div className="bg-white border border-gray-200 rounded-xl mb-4 overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-50 transition-colors"
          onClick={() => setShowCreate(v => !v)}
        >
          <span>+ Create / add coach food</span>
          <span className="text-gray-400 text-lg">{showCreate ? '−' : '+'}</span>
        </button>

        {showCreate && (
          <form onSubmit={createCoachFood} className="px-4 pb-4 border-t border-gray-100 space-y-3 pt-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Food name *</label>
              <input name="food_name" value={form.food_name} onChange={setF} required
                placeholder="e.g. Grilled Chicken Breast"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {[
                ['Calories (per serving)', 'calories', '120'],
                ['Protein g',             'protein',  '22'],
                ['Carbs g',               'carbs',    '0'],
                ['Fat g',                 'fat',      '2.6'],
                ['Fiber g',               'fiber',    '0'],
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
                <input type="number" name="serving_size" value={form.serving_size} onChange={setF} min="0.01" step="any"
                  placeholder="100"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
                <select name="serving_unit" value={form.serving_unit} onChange={setF}
                  className="border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                  {SERVING_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">Enter macros for the serving size above (e.g. 120 cal per 100g)</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Coach notes (optional)</label>
              <input name="notes" value={form.notes} onChange={setF}
                placeholder="e.g. Jason recommends this for post-workout"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
            </div>

            {saveErr && <p className="text-xs text-red-500">{saveErr}</p>}

            <div className="flex gap-2">
              <button type="submit" disabled={saving}
                className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
                {saving ? 'Saving…' : 'Add Coach Food'}
              </button>
              <button type="button" onClick={() => { setShowCreate(false); setForm(EMPTY_FORM) }}
                className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {/* ── Current coach foods list ── */}
      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        Current coach foods ({coachFoods.length})
      </h3>

      {loading && <p className="text-sm text-gray-400 text-center py-6">Loading…</p>}

      {!loading && coachFoods.length === 0 && (
        <div className="text-center py-8 text-sm text-gray-400">
          <p className="text-2xl mb-2">⭐</p>
          <p>No coach foods yet. Search above or create one to get started.</p>
        </div>
      )}

      <div className="space-y-2">
        {coachFoods.map(food => {
          const cal = food.serving_size > 0
            ? Math.round(food.calories_per_serving / food.serving_size * 100)
            : Math.round(food.calories_per_serving ?? 0)
          const pro = food.serving_size > 0
            ? +((food.protein / food.serving_size * 100).toFixed(1))
            : +(food.protein ?? 0)
          return (
            <div key={food.id} className="bg-white border border-orange-200 rounded-xl px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-gray-900">{food.food_name}</p>
                  <span className="inline-flex items-center rounded-full border border-orange-300 bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-[#E8670A]">
                    ⭐ Coach food
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {cal} cal · {pro}g P per 100{food.serving_unit === 'ml' ? 'ml' : 'g'}
                  {food.serving_size && food.serving_unit
                    ? ` · Serving: ${food.serving_size}${food.serving_unit}`
                    : ''}
                </p>
                {food.notes && (
                  <p className="text-xs text-[#E8670A] mt-0.5 italic">"{food.notes}"</p>
                )}
              </div>
              <button
                onClick={() => removeCoachFood(food.id)}
                disabled={deletingId === food.id}
                className="shrink-0 text-xs text-red-400 hover:text-red-600 disabled:opacity-40 transition-colors font-medium"
              >
                {deletingId === food.id ? '…' : 'Remove'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── DEV TOOLS section ────────────────────────────────────────────────────────
// TODO: REMOVE BEFORE PRODUCTION LAUNCH
// This section is for developer/admin testing of the onboarding & assessment flow only.
// It resets flag columns only — no user data is ever deleted.

function StatusPill({ label, value }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold border ${
      value
        ? 'bg-green-50 border-green-200 text-green-700'
        : 'bg-red-50 border-red-200 text-red-500'
    }`}>
      {value ? '✓' : '✗'} {label}
    </span>
  )
}

// TODO: REMOVE BEFORE PRODUCTION LAUNCH
function DevToolsSection({ clients, getToken }) {
  const [resetting, setResetting] = useState({})  // { [clientId]: 'loading' | 'done' }
  const [overrides, setOverrides] = useState({})  // { [clientId]: updated user object }

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

  // Hard navigate to /dashboard — clears the module-level userStateCache in App.jsx
  // (module variables reset on full page load), causing a fresh /api/users/me fetch.
  // If assessment_complete is now FALSE the app will redirect to /health-assessment.
  function reloadAndTest() {
    window.location.href = '/dashboard'
  }

  return (
    <div>
      {/* ── Warning banner ── */}
      {/* TODO: REMOVE BEFORE PRODUCTION LAUNCH */}
      <div className="bg-yellow-50 border-2 border-yellow-300 rounded-xl p-4 mb-5 flex gap-3">
        <span className="text-xl shrink-0">⚠️</span>
        <div>
          <p className="text-sm font-bold text-yellow-800">DEV TOOLS — Testing Only</p>
          <p className="text-xs text-yellow-700 mt-1">
            Resets <code className="bg-yellow-100 px-0.5 rounded">onboarding_complete</code> and/or{' '}
            <code className="bg-yellow-100 px-0.5 rounded">assessment_complete</code> flags.
            No meals, workouts, journal entries, or community posts are affected.
            <strong> Remove this tab before public launch.</strong>
          </p>
        </div>
      </div>

      {/* ── How-to guide ── */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-5">
        <p className="text-xs font-bold text-gray-700 mb-2">How to test the assessment flow:</p>
        <ol className="text-xs text-gray-600 space-y-1.5 list-decimal list-inside">
          <li>Find your own account in the list below.</li>
          <li>Click <strong>Reset Assessment</strong> (or <strong>Reset Both</strong> to test from full onboarding).</li>
          <li>Click <strong>Reload &amp; Test →</strong> — the page reloads, re-fetches your flags, and redirects to the assessment.</li>
          <li>Complete the flow normally. Return here to reset again for another pass.</li>
        </ol>
        <p className="text-[10px] text-gray-400 mt-2">
          Note: only users who completed onboarding appear here. If you need to test onboarding itself,
          use <strong>Reset Both</strong>, then reload — you will be sent to /onboarding first.
        </p>
      </div>

      {/* ── Client list ── */}
      {clients.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-8">No onboarded users yet.</p>
      )}

      <div className="space-y-2">
        {clients.map(client => {
          const busy    = resetting[client.id] === 'loading'
          const done    = resetting[client.id] === 'done'
          const current = overrides[client.id] ?? client  // use post-reset data if available

          return (
            <div key={client.id} className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {client.first_name ?? 'Unknown'}
                    {client.email && <span className="text-xs text-gray-400 font-normal ml-2">{client.email}</span>}
                  </p>
                  <div className="flex gap-2 mt-1.5 flex-wrap">
                    <StatusPill label="Onboarding"  value={current.onboarding_complete} />
                    <StatusPill label="Assessment"  value={current.assessment_complete} />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 items-center">
                  {/* Reset assessment only */}
                  <button
                    onClick={() => reset(client.id, { reset_assessment: true })}
                    disabled={busy}
                    className="px-3 py-2 text-xs font-semibold rounded-lg border-2 border-yellow-400 text-yellow-700 hover:bg-yellow-50 disabled:opacity-40 transition-colors min-h-[36px]"
                  >
                    {busy ? '…' : 'Reset Assessment'}
                  </button>

                  {/* Reset onboarding + assessment */}
                  <button
                    onClick={() => reset(client.id, { reset_onboarding: true, reset_assessment: true })}
                    disabled={busy}
                    className="px-3 py-2 text-xs font-semibold rounded-lg border-2 border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 transition-colors min-h-[36px]"
                  >
                    {busy ? '…' : 'Reset Both'}
                  </button>

                  {/* Reload button — only shown after a successful reset */}
                  {done && (
                    <button
                      onClick={reloadAndTest}
                      className="px-3 py-2 text-xs font-semibold rounded-lg bg-[#E8670A] text-white hover:bg-[#c45e09] transition-colors min-h-[36px]"
                    >
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

// ── Main Admin page ───────────────────────────────────────────────────────────

export default function Admin() {
  const { getToken } = useAuth()
  const navigate     = useNavigate()
  const [section, setSection] = useState('clients')
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.status === 403) { navigate('/dashboard', { replace: true }); return }
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        setClients(await res.json())
      } catch (err) { setError(err.message) } finally { setLoading(false) }
    }
    load()
  }, [getToken, navigate])

  function handleUpdate(updated) {
    setClients(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c))
  }

  const tabs = [
    { id: 'clients',     label: 'Clients' },
    { id: 'coach-foods', label: 'Coach Foods' },
    // TODO: REMOVE BEFORE PRODUCTION LAUNCH — dev testing utility
    { id: 'dev-tools',   label: '🛠 Dev Tools' },
  ]

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Admin</h1>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1 w-fit">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSection(tab.id)}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
              section === tab.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Clients section ── */}
      {section === 'clients' && (
        <>
          <p className="text-sm text-gray-500 mb-4">Manage client macro targets</p>
          {loading && <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>}
          {error   && <p className="text-sm text-red-500 py-4">{error}</p>}
          {!loading && !error && clients.length === 0 && (
            <p className="text-sm text-gray-400 py-8 text-center">No onboarded clients yet.</p>
          )}
          <div className="space-y-3">
            {clients.map(client => (
              <ClientRow key={client.id} client={client} getToken={getToken} onUpdate={handleUpdate} />
            ))}
          </div>
        </>
      )}

      {/* ── Coach Foods section ── */}
      {section === 'coach-foods' && (
        <CoachFoodsSection getToken={getToken} />
      )}

      {/* ── Dev Tools section ── */}
      {/* TODO: REMOVE BEFORE PRODUCTION LAUNCH */}
      {section === 'dev-tools' && (
        <DevToolsSection clients={clients} getToken={getToken} />
      )}
    </div>
  )
}
