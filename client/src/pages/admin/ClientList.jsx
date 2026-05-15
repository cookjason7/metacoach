import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'
import { API_URL } from '../../config.js'
import FoodSourceBadge from '../../components/FoodSourceBadge.jsx'
import StaffInbox from '../../components/StaffInbox.jsx'

// ── Constants ────────────────────────────────────────────────────────────────

const SERVING_UNITS = ['g', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'ml', 'fl oz']

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_STYLES = {
  'Consistent':            'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Building Momentum':     'bg-blue-50 text-blue-700 border-blue-200',
  'Rebuilding Momentum':   'bg-amber-50 text-amber-700 border-amber-200',
  'Needs Attention':       'bg-orange-50 text-[#E8670A] border-orange-200',
  'New Client':            'bg-gray-50 text-gray-600 border-gray-200',
  'Invited':               'bg-purple-50 text-purple-700 border-purple-200',
}

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES['New Client']
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${style}`}>
      {status}
    </span>
  )
}

function daysSince(iso) {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso)) / 86400_000)
}

function adherenceColor(v) {
  const n = Number(v) || 0
  if (n >= 80) return 'text-emerald-600'
  if (n >= 50) return 'text-blue-600'
  if (n >= 30) return 'text-amber-600'
  return 'text-gray-400'
}

// ── Food & Macros tab components ─────────────────────────────────────────────

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
  const [data,    setData]    = useState(undefined)
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
      <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider">Contact &amp; Info</p>
      <div className="space-y-1">
        <Row label="Full name"    value={[data.first_name, data.last_name].filter(Boolean).join(' ') || null} />
        <Row label="Phone"        value={data.phone} />
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
      </div>
      <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider">About You</p>
      <div className="space-y-1">
        <Row label="Occupation"   value={data.occupation} />
        <Row label="Kids"         value={data.num_kids != null ? String(data.num_kids) : null} />
        <Row label="6-mo goals"   value={data.goals_6_months} />
        <Row label="Supplements"  value={data.supplements} />
        <Row label="Injuries"     value={data.injuries_limitations} />
      </div>
      <p className="text-[10px] font-bold text-[#E8670A] uppercase tracking-wider">Energy &amp; Lifestyle</p>
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

function MacroClientRow({ client, getToken, onUpdate }) {
  const [editing,        setEditing]        = useState(false)
  const [assessmentOpen, setAssessmentOpen] = useState(false)
  const inactive = daysSince(client.last_meal_at)

  function handleSaved(updated) { if (updated) onUpdate(updated); setEditing(false) }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{[client.first_name, client.display_last_name].filter(Boolean).join(' ') || client.email || 'Unknown'}</p>
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
        const res = await fetch(`${API_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
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
  if (clients.length === 0) return <p className="text-sm text-gray-400 py-8 text-center">No clients yet.</p>

  return (
    <div className="space-y-3">
      {clients.map(client => (
        <MacroClientRow key={client.id} client={client} getToken={getToken} onUpdate={handleUpdate} />
      ))}
    </div>
  )
}

// ── Coach Foods tab ───────────────────────────────────────────────────────────

const EMPTY_FOOD_FORM = {
  food_name: '', calories: '', protein: '', carbs: '', fat: '', fiber: '',
  serving_size: '100', serving_unit: 'g', notes: '',
}

function CoachFoodsTab({ getToken }) {
  const [coachFoods,    setCoachFoods]    = useState([])
  const [loading,       setLoading]       = useState(true)
  const [showCreate,    setShowCreate]    = useState(false)
  const [form,          setForm]          = useState(EMPTY_FOOD_FORM)
  const [saving,        setSaving]        = useState(false)
  const [saveErr,       setSaveErr]       = useState(null)
  const [searchQ,       setSearchQ]       = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching,     setSearching]     = useState(false)
  const [deletingId,    setDeletingId]    = useState(null)
  const debounceRef = useRef(null)

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
    setSearchQ(''); setSearchResults([]); setShowCreate(true)
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
      setForm(EMPTY_FOOD_FORM); setShowCreate(false)
    } catch (err) { setSaveErr(err.message) } finally { setSaving(false) }
  }

  async function removeCoachFood(id) {
    setDeletingId(id)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/admin/coach-foods/${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setCoachFoods(prev => prev.filter(f => f.id !== id))
    } finally { setDeletingId(null) }
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Coach foods appear to all clients with a <span className="font-semibold text-[#E8670A]">⭐ Coach food</span> badge in search results.
      </p>

      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Find &amp; promote an existing food</h3>
        <div className="relative">
          <input
            type="text" value={searchQ} onChange={handleSearch}
            placeholder="Search foods to promote as coach food…"
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
        <p className="text-xs text-gray-400 mt-2">Click a food to pre-fill the form below.</p>
      </div>

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
              <p className="text-[10px] text-gray-400 mt-0.5">Enter macros for the serving size above</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Coach notes (optional)</label>
              <input name="notes" value={form.notes} onChange={setF}
                placeholder="e.g. Great post-workout option"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
            </div>
            {saveErr && <p className="text-xs text-red-500">{saveErr}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={saving}
                className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
                {saving ? 'Saving…' : 'Add Coach Food'}
              </button>
              <button type="button" onClick={() => { setShowCreate(false); setForm(EMPTY_FOOD_FORM) }}
                className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">Cancel</button>
            </div>
          </form>
        )}
      </div>

      <h3 className="text-sm font-semibold text-gray-700 mb-2">Current coach foods ({coachFoods.length})</h3>
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
                  {food.serving_size && food.serving_unit ? ` · Serving: ${food.serving_size}${food.serving_unit}` : ''}
                </p>
                {food.notes && <p className="text-xs text-[#E8670A] mt-0.5 italic">"{food.notes}"</p>}
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

// ── Dev Tools tab ─────────────────────────────────────────────────────────────

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
        const res = await fetch(`${API_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
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

  function reloadAndTest() { window.location.href = '/dashboard' }

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
            <strong> Remove this tab before public launch.</strong>
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
      {clients.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No users yet.</p>}
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
                  <button
                    onClick={() => reset(client.id, { reset_assessment: true })}
                    disabled={busy}
                    className="px-3 py-2 text-xs font-semibold rounded-lg border-2 border-yellow-400 text-yellow-700 hover:bg-yellow-50 disabled:opacity-40 transition-colors min-h-[36px]"
                  >
                    {busy ? '…' : 'Reset Assessment'}
                  </button>
                  <button
                    onClick={() => reset(client.id, { reset_onboarding: true, reset_assessment: true })}
                    disabled={busy}
                    className="px-3 py-2 text-xs font-semibold rounded-lg border-2 border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40 transition-colors min-h-[36px]"
                  >
                    {busy ? '…' : 'Reset Both'}
                  </button>
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

// ── Admin Messaging Inbox tab (delegates to shared StaffInbox) ───────────────

function AdminMessagingTab({ getToken }) {
  return <StaffInbox getToken={getToken} />
}

// ── Placeholder tab ───────────────────────────────────────────────────────────

function PlaceholderTab({ title, description }) {
  return (
    <div className="text-center py-16">
      <p className="text-3xl mb-3">🚧</p>
      <p className="text-base font-semibold text-gray-700 mb-1">{title}</p>
      <p className="text-sm text-gray-400">{description}</p>
    </div>
  )
}

// ── Invite Client modal ───────────────────────────────────────────────────────

const EMPTY_INVITE = { first_name: '', last_name: '', email: '', phone: '', notes: '' }

function InviteModal({ getToken, onClose, onSuccess }) {
  const [form,       setForm]       = useState(EMPTY_INVITE)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState(null)
  const [isArchived, setIsArchived] = useState(false)   // true when 409 is an archived-client conflict
  const [result,     setResult]     = useState(null)    // { invite_url, email_sent, email_note, first_name }
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
          first_name: form.first_name.trim(),
          last_name:  form.last_name.trim() || undefined,
          email:      form.email.trim(),
          phone:      form.phone.trim()  || undefined,
          notes:      form.notes.trim()  || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Invite failed. Please try again.')
        setIsArchived(!!data.is_archived)
        return
      }
      setResult(data)
    } catch { setError('Network error. Please try again.') }
    finally { setSaving(false) }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(result.invite_url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#fff7ed] flex items-center justify-center text-[#E8670A] text-lg shrink-0">✉️</div>
            <div>
              <p className="text-base font-bold text-gray-900">Invite VIP Client</p>
              <p className="text-xs text-gray-400">They'll receive a secure sign-up link</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0">×</button>
        </div>

        {/* ── Success state ── */}
        {result ? (
          <div>
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-4">
              <p className="text-sm font-semibold text-emerald-800 mb-1">
                ✓ Invite created for {result.first_name}!
              </p>
              {result.email_sent ? (
                <p className="text-xs text-emerald-700">Email sent to <strong>{form.email}</strong>.</p>
              ) : (
                <p className="text-xs text-amber-700">
                  ⚠ Email not sent{result.email_note ? `: ${result.email_note}` : '.'} Copy and share the link below manually.
                </p>
              )}
            </div>
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">Invite link</label>
              <div className="flex gap-2">
                <input
                  readOnly value={result.invite_url}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-xs text-gray-700 bg-gray-50 select-all"
                  onClick={e => e.target.select()}
                />
                <button
                  onClick={copyLink}
                  className="shrink-0 bg-[#E8670A] text-white px-3 py-2 rounded-lg text-xs font-semibold hover:bg-[#c45e09] transition-colors min-w-[70px]"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setResult(null); setForm(EMPTY_INVITE); setCopied(false) }}
                className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors"
              >
                Invite Another
              </button>
              <button
                onClick={onSuccess}
                className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          /* ── Form state ── */
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">First name *</label>
                <input
                  name="first_name" value={form.first_name} onChange={setF} required
                  placeholder="Jane"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Last name</label>
                <input
                  name="last_name" value={form.last_name} onChange={setF}
                  placeholder="Smith"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
              <input
                type="email" name="email" value={form.email} onChange={setF} required
                placeholder="jane@example.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Client must sign up with this exact email.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Phone (optional)</label>
              <input
                type="tel" name="phone" value={form.phone} onChange={setF}
                placeholder="+1 (555) 000-0000"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
              <textarea
                name="notes" value={form.notes} onChange={setF} rows={2}
                placeholder="e.g. Referred by John, interested in weight loss"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
              />
            </div>
            {error && (
              <div className="bg-red-50 rounded-lg px-3 py-2">
                <p className="text-xs text-red-600">{error}</p>
                {isArchived && (
                  <button
                    type="button"
                    onClick={() => { onClose(); /* caller navigates to archived tab */ }}
                    className="text-xs text-[#E8670A] underline mt-1 block"
                  >
                    Go to Archived Clients → Reactivate, then reinvite
                  </button>
                )}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button
                type="button" onClick={onClose}
                className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit" disabled={saving}
                className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-50 transition-colors"
              >
                {saving ? 'Sending…' : 'Send Invite'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ClientList() {
  const { getToken } = useAuth()
  const navigate     = useNavigate()
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [search,  setSearch]  = useState('')
  const [filter,  setFilter]  = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [lifecycleFilter, setLifecycleFilter] = useState('active')
  const [activeTab, setActiveTab] = useState('clients')
  const [isAdmin,      setIsAdmin]      = useState(false)
  const [inviteOpen,   setInviteOpen]   = useState(false)

  // Detect admin role once on mount
  useEffect(() => {
    async function checkRole() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const data = await res.json()
          setIsAdmin(data.role === 'admin')
        }
      } catch {}
    }
    checkRole()
  }, [getToken])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/coach-admin/clients?status=${lifecycleFilter}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 403) { navigate('/dashboard', { replace: true }); return }
      if (!res.ok) throw new Error(`Server ${res.status}`)
      setClients(await res.json())
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [getToken, navigate, lifecycleFilter])

  useEffect(() => { load() }, [load])

  async function archiveClient(e, id) {
    e.stopPropagation()
    if (!confirm('Archive this client? They will be hidden from the active list but all their data is preserved.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}/archive`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) load()
  }

  async function reactivateClient(e, id) {
    e.stopPropagation()
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}/reactivate`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) load()
  }

  async function deleteClient(e, id, name) {
    e.stopPropagation()
    if (!confirm(`Soft-delete ${name}? Their data is preserved and the row is hidden. Type DELETE in the next prompt to confirm.`)) return
    const confirmText = prompt('Type DELETE to confirm:')
    if (confirmText !== 'DELETE') return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/coach-admin/clients/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) load()
    else {
      const err = await res.json().catch(() => ({}))
      alert(err.error ?? 'Could not delete')
    }
  }

  const filtered = clients.filter(c => {
    if (filter === 'vip' && c.coaching_type !== 'vip') return false
    if (filter === 'ai'  && c.coaching_type !== 'ai')  return false
    if (statusFilter !== 'all' && c.status_tag !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (!`${c.first_name ?? ''} ${c.display_last_name ?? ''} ${c.email ?? ''}`.toLowerCase().includes(q)) return false
    }
    return true
  })

  // Tabs — Dev Tools only shown to admins
  const tabs = [
    { id: 'clients',        label: 'Clients' },
    { id: 'food-macros',    label: 'Food & Macros' },
    { id: 'habit-coaching', label: 'Habit Coaching' },
    { id: 'messaging',      label: 'Messaging' },
    { id: 'coach-foods',    label: 'Coach Foods' },
    ...(isAdmin ? [{ id: 'dev-tools', label: '🛠 Dev Tools' }] : []),
  ]

  return (
    <div className="max-w-7xl">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Coaching Command Center</h1>
          <p className="text-sm text-gray-500">Clients, macros, habits, and coaching tools in one place.</p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setInviteOpen(true)}
            className="shrink-0 bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
          >
            + Invite Client
          </button>
        )}
      </div>

      {/* Invite Client modal */}
      {inviteOpen && (
        <InviteModal
          getToken={getToken}
          onClose={() => setInviteOpen(false)}
          onSuccess={() => { setInviteOpen(false); load() }}
        />
      )}

      {/* ── Tab bar (scrollable on mobile) ── */}
      <div className="mb-6 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
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
            </button>
          ))}
        </div>
      </div>

      {/* ── Clients tab ── */}
      {activeTab === 'clients' && (
        <>
          {/* Filters */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
              <select value={filter} onChange={e => setFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="all">All clients</option>
                <option value="vip">VIP coaching</option>
                <option value="ai">AI coaching</option>
              </select>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="all">All statuses</option>
                <option value="Consistent">Consistent</option>
                <option value="Building Momentum">Building Momentum</option>
                <option value="Rebuilding Momentum">Rebuilding Momentum</option>
                <option value="Needs Attention">Needs Attention</option>
                <option value="New Client">New Client</option>
              </select>
              <select value={lifecycleFilter} onChange={e => setLifecycleFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                <option value="active">Active clients</option>
                <option value="invited">Invited clients</option>
                <option value="archived">Archived clients</option>
                <option value="all">All (active + archived)</option>
              </select>
            </div>
            <p className="text-xs text-gray-400 mt-2">{filtered.length} of {clients.length} clients</p>
          </div>

          {loading && <p className="text-center text-gray-400 py-12 text-sm">Loading clients…</p>}
          {error   && <p className="text-center text-red-500 py-8 text-sm">{error}</p>}
          {!loading && !error && filtered.length === 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
              <p className="text-2xl mb-2">👥</p>
              <p className="text-sm text-gray-500">No clients match your filters yet.</p>
            </div>
          )}

          {/* Desktop table */}
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
                  <th className="text-left px-3 py-3 font-semibold">Status</th>
                  <th className="text-right px-3 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(c => {
                  const inactive = daysSince(c.last_meal_at ?? c.last_login_at)
                  return (
                    <tr key={c.id}
                      onClick={() => navigate(`/admin/clients/${c.id}`)}
                      className="hover:bg-orange-50/50 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3">
                        <p className="font-semibold text-gray-900">
                          {[c.first_name, c.display_last_name].filter(Boolean).join(' ') || c.email || 'Unknown'}
                        </p>
                        <p className="text-xs text-gray-400 truncate max-w-[180px]">{c.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold border ${
                          c.coaching_type === 'ai'
                            ? 'bg-purple-50 text-purple-700 border-purple-200'
                            : 'bg-orange-50 text-[#E8670A] border-orange-200'
                        }`}>
                          {c.coaching_type === 'ai' ? 'AI' : 'VIP'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">{c.assigned_coach_name ?? '—'}</td>
                      <td className="px-3 py-3 text-xs text-gray-500">
                        {inactive === null ? '—' : inactive === 0 ? 'Today' : `${inactive}d ago`}
                      </td>
                      <td className={`px-3 py-3 text-center font-bold ${adherenceColor(c.adherence_7d)}`}>
                        {Math.round(Number(c.adherence_7d) || 0)}%
                      </td>
                      <td className={`px-3 py-3 text-center font-bold ${adherenceColor(c.adherence_30d)}`}>
                        {Math.round(Number(c.adherence_30d) || 0)}%
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <StatusBadge status={c.status_tag} />
                          {c.client_status === 'archived' && (
                            <span className="inline-flex items-center rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-[9px] font-bold text-gray-600 w-fit">
                              📦 Archived
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        {c.client_status === 'archived' ? (
                          <button onClick={e => reactivateClient(e, c.id)}
                            className="text-xs text-emerald-600 hover:text-emerald-700 font-semibold mr-2">
                            Reactivate
                          </button>
                        ) : (
                          <button onClick={e => archiveClient(e, c.id)}
                            className="text-xs text-gray-500 hover:text-gray-700 font-medium mr-2">
                            Archive
                          </button>
                        )}
                        <button onClick={e => deleteClient(e, c.id, c.first_name ?? 'this client')}
                          className="text-xs text-red-400 hover:text-red-600 font-medium">
                          Delete
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="lg:hidden space-y-3">
            {filtered.map(c => {
              const inactive = daysSince(c.last_meal_at ?? c.last_login_at)
              return (
                <button key={c.id}
                  onClick={() => navigate(`/admin/clients/${c.id}`)}
                  className="w-full text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-[#E8670A] active:scale-[0.99] transition-all"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900">
                        {[c.first_name, c.display_last_name].filter(Boolean).join(' ') || c.email || 'Unknown'}
                      </p>
                      <p className="text-xs text-gray-400 truncate">{c.email}</p>
                    </div>
                    <StatusBadge status={c.status_tag} />
                  </div>
                  <div className="flex items-center gap-2 text-[10px] mb-2 flex-wrap">
                    <span className={`rounded-full px-2 py-0.5 font-bold border ${
                      c.coaching_type === 'ai'
                        ? 'bg-purple-50 text-purple-700 border-purple-200'
                        : 'bg-orange-50 text-[#E8670A] border-orange-200'
                    }`}>{c.coaching_type === 'ai' ? 'AI' : 'VIP'}</span>
                    {c.assigned_coach_name && (
                      <span className="text-gray-500">Coach: {c.assigned_coach_name}</span>
                    )}
                    <span className="text-gray-400">
                      {inactive === null ? 'No activity' : inactive === 0 ? 'Active today' : `${inactive}d ago`}
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <div>
                      <span className="text-gray-400">7d </span>
                      <span className={`font-bold ${adherenceColor(c.adherence_7d)}`}>
                        {Math.round(Number(c.adherence_7d) || 0)}%
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400">30d </span>
                      <span className={`font-bold ${adherenceColor(c.adherence_30d)}`}>
                        {Math.round(Number(c.adherence_30d) || 0)}%
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
                    {c.client_status === 'archived' ? (
                      <span className="inline-flex items-center rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-[9px] font-bold text-gray-600">
                        📦 Archived
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[9px] font-bold text-emerald-700">
                        ● Active
                      </span>
                    )}
                    <div className="flex gap-3">
                      {c.client_status === 'archived' ? (
                        <span onClick={e => reactivateClient(e, c.id)} className="text-[11px] text-emerald-600 hover:text-emerald-700 font-semibold cursor-pointer">
                          Reactivate
                        </span>
                      ) : (
                        <span onClick={e => archiveClient(e, c.id)} className="text-[11px] text-gray-500 hover:text-gray-700 font-medium cursor-pointer">
                          Archive
                        </span>
                      )}
                      <span onClick={e => deleteClient(e, c.id, c.first_name ?? 'this client')} className="text-[11px] text-red-400 hover:text-red-600 font-medium cursor-pointer">
                        Delete
                      </span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* ── Food & Macros tab ── */}
      {activeTab === 'food-macros' && (
        <div>
          <p className="text-sm text-gray-500 mb-4">Set and manage macro targets for each client.</p>
          <FoodMacrosTab getToken={getToken} />
        </div>
      )}

      {/* ── Habit Coaching tab ── */}
      {activeTab === 'habit-coaching' && (
        <PlaceholderTab
          title="Habit Coaching"
          description="Assign and track client habits. Use the Client Profile for now — full bulk habit management coming soon."
        />
      )}

      {/* ── Messaging tab ── */}
      {activeTab === 'messaging' && (
        <AdminMessagingTab getToken={getToken} />
      )}

      {/* ── Coach Foods tab ── */}
      {activeTab === 'coach-foods' && (
        <CoachFoodsTab getToken={getToken} />
      )}

      {/* ── Dev Tools tab (admin only) ── */}
      {activeTab === 'dev-tools' && isAdmin && (
        <DevToolsTab getToken={getToken} />
      )}
    </div>
  )
}
