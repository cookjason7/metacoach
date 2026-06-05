import { useState, useRef, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'
import BarcodeScannerWidget from '../components/BarcodeScanner.jsx'
import FoodSourceBadge from '../components/FoodSourceBadge.jsx'
import MicronutrientGrid from '../components/MicronutrientGrid.jsx'

// ── Constants ─────────────────────────────────────────────────────────────────

const MEAL_SLOTS = ['Breakfast', 'AM Snack', 'Lunch', 'PM Snack', 'Dinner', 'Late Snack']

function getDefaultSlot() {
  const h = new Date().getHours()
  if (h >= 5  && h < 10) return 'Breakfast'
  if (h >= 10 && h < 12) return 'AM Snack'
  if (h >= 12 && h < 14) return 'Lunch'
  if (h >= 14 && h < 17) return 'PM Snack'
  if (h >= 17 && h < 20) return 'Dinner'
  return 'Late Snack'
}

const ING_UNITS = ['g', 'oz', 'cup', 'tbsp', 'tsp', 'pc', 'slice', 'ml']

const SERVING_UNITS = ['g', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'ml', 'fl oz']
const UNIT_TO_G = { g: 1, oz: 28.35, lb: 453.59, cup: 240, tbsp: 15, tsp: 5, ml: 1, 'fl oz': 29.57 }
function toGrams(amount, unit) { return amount * (UNIT_TO_G[unit] ?? 1) }

const MICRO_KEYS = ['fiber_g', 'sodium_mg', 'potassium_mg', 'calcium_mg', 'iron_mg', 'vitamin_d_mcg', 'magnesium_mg']
function scaledMicronutrients(food, grams) {
  if (!food || !grams || grams <= 0) return null
  const ratio = grams / 100
  const out = {}
  for (const key of MICRO_KEYS) {
    if (food[key] != null && Number(food[key]) > 0) out[key] = +(Number(food[key]) * ratio).toFixed(2)
  }
  return Object.keys(out).length ? out : null
}

// ── Shared UI pieces ──────────────────────────────────────────────────────────

function MacroCard({ label, value, unit, color }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
      <p className="text-xs text-gray-400">{unit}</p>
    </div>
  )
}

function NumberField({ label, name, value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="number"
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        min="0"
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
      />
    </div>
  )
}

function SlotPicker({ value, onChange }) {
  return (
    <div className="mb-5">
      <label className="block text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">Meal Slot</label>
      <div className="flex flex-wrap gap-1.5">
        {MEAL_SLOTS.map(s => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              value === s
                ? 'bg-[#E8670A] text-white border-[#E8670A]'
                : 'text-gray-600 border-gray-200 hover:border-[#E8670A] hover:text-[#E8670A] bg-white'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function SavedState({ name, onReset, resetLabel = 'Log Another Meal' }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-10 max-w-md text-center">
      <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <span className="text-green-600 text-xl font-bold">✓</span>
      </div>
      <p className="text-lg font-semibold text-gray-900 mb-1">Meal saved</p>
      <p className="text-sm text-gray-500 mb-6">{name} has been added to your log.</p>
      <div className="flex flex-col gap-2 items-center">
        <button
          onClick={onReset}
          className="w-full max-w-xs bg-[#E8670A] text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
        >
          {resetLabel}
        </button>
        <Link
          to="/meal-history"
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors py-1"
        >
          View meal history
        </Link>
      </div>
    </div>
  )
}

// ── Photo mode ────────────────────────────────────────────────────────────────

function PhotoMode({ slot, logDate }) {
  const { getToken } = useAuth()
  const inputRef = useRef(null)

  const [photo,     setPhoto]     = useState(null)
  const [preview,   setPreview]   = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis,  setAnalysis]  = useState(null)
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [error,     setError]     = useState(null)

  function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) return
    if (preview) URL.revokeObjectURL(preview)
    setPhoto(file)
    setPreview(URL.createObjectURL(file))
    setAnalysis(null)
    setSaved(false)
    setError(null)
  }

  async function analyze() {
    if (!photo) return
    setAnalyzing(true)
    setError(null)
    try {
      const token = await getToken()
      const body  = new FormData()
      body.append('photo', photo)
      const res = await fetch(`${API_URL}/api/meals/analyze`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || `Server error ${res.status}`)
      }
      setAnalysis(await res.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setAnalyzing(false)
    }
  }

  async function save() {
    if (!analysis) return
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const body  = new FormData()
      body.append('photo',     photo)
      body.append('meal_name', analysis.meal_name)
      body.append('calories',  analysis.calories)
      body.append('protein_g', analysis.protein_g)
      body.append('carbs_g',   analysis.carbs_g)
      body.append('fat_g',     analysis.fat_g)
      body.append('meal_slot', slot)
      body.append('log_date',  logDate)
      if (analysis.fiber_g != null) body.append('fiber_g', analysis.fiber_g)
      const res = await fetch(`${API_URL}/api/meals`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      })
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
      setSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function reset() {
    if (preview) URL.revokeObjectURL(preview)
    setPhoto(null); setPreview(null); setAnalysis(null)
    setSaved(false); setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  if (saved) return <SavedState name={analysis.meal_name} onReset={reset} />

  return (
    <div className="max-w-lg space-y-5">
      {!preview ? (
        <div
          className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-10 text-center cursor-pointer hover:border-[#E8670A] hover:bg-[#fff7ed] transition-colors"
          onClick={() => inputRef.current?.click()}
          onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }}
          onDragOver={(e) => e.preventDefault()}
        >
          <div className="text-4xl mb-3">📷</div>
          <p className="text-sm font-medium text-gray-700">Drop a photo or tap to upload</p>
          <p className="text-xs text-gray-400 mt-1">JPEG, PNG, WebP — max 10 MB</p>
          <input ref={inputRef} type="file" accept="image/*" capture="environment"
            className="hidden" onChange={(e) => handleFile(e.target.files[0])} />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <img src={preview} alt="Meal preview" className="w-full max-h-72 object-cover" />
          <div className="p-3 flex justify-between items-center border-t border-gray-100">
            <span className="text-xs text-gray-400 truncate max-w-xs">{photo?.name}</span>
            <button onClick={reset} className="text-xs text-gray-400 hover:text-red-500 transition-colors ml-3">Remove</button>
          </div>
        </div>
      )}

      {preview && !analysis && (
        <button
          onClick={analyze}
          disabled={analyzing}
          className="w-full bg-[#E8670A] text-white py-3 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {analyzing ? (
            <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Analyzing with AI…</>
          ) : 'Analyze Meal with AI'}
        </button>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {analysis && (
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Detected meal</p>
            <p className="text-lg font-semibold text-gray-900">{analysis.meal_name}</p>
          </div>

          {/* Ingredient breakdown */}
          {Array.isArray(analysis.ingredients) && analysis.ingredients.length > 0 && (
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Ingredients</p>
              <ul className="space-y-1">
                {analysis.ingredients.map((ing, i) => (
                  <li key={i} className="flex justify-between text-sm">
                    <span className="text-gray-700">{ing.item}</span>
                    <span className="text-gray-400 text-xs self-center ml-2">
                      {ing.portion}{ing.weight_g != null ? ` · ${ing.weight_g}g` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Macros */}
          <div className="grid grid-cols-4 gap-3">
            <MacroCard label="Calories" value={analysis.calories}         unit="kcal"   color="text-orange-500" />
            <MacroCard label="Protein"  value={`${analysis.protein_g}g`} unit="protein" color="text-blue-600" />
            <MacroCard label="Carbs"    value={`${analysis.carbs_g}g`}   unit="carbs"   color="text-yellow-500" />
            <MacroCard label="Fat"      value={`${analysis.fat_g}g`}     unit="fat"     color="text-pink-500" />
          </div>
          <div className="flex gap-4 text-xs text-gray-500 flex-wrap">
            {analysis.fiber_g        != null && <span>Fiber: <span className="font-medium text-[#E8670A]">{analysis.fiber_g}g</span></span>}
            {analysis.saturated_fat_g != null && <span>Sat. fat: <span className="font-medium text-gray-700">{analysis.saturated_fat_g}g</span></span>}
            {analysis.sugar_g        != null && <span>Sugar: <span className="font-medium text-gray-700">{analysis.sugar_g}g</span></span>}
            {analysis.sodium_mg      != null && <span>Sodium: <span className="font-medium text-gray-700">{analysis.sodium_mg}mg</span></span>}
          </div>

          {/* Katie feedback */}
          {analysis.katie_feedback && (
            <div className="bg-[#fff7ed] border border-orange-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-[#E8670A] mb-1">Katie says</p>
              <p className="text-sm text-gray-700 leading-relaxed">{analysis.katie_feedback}</p>
              <p className="text-xs text-[#E8670A] font-medium mt-2 text-right">Katie</p>
            </div>
          )}

          <p className="text-xs text-gray-400">AI estimates — actual values may vary by portion size.</p>

          <div className="flex gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
            >
              {saving ? (
                <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Saving…</>
              ) : 'Save Meal'}
            </button>
            <button onClick={reset} className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
              Start Over
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Manual mode ───────────────────────────────────────────────────────────────

const EMPTY_MANUAL = { meal_name: '', calories: '', protein_g: '', carbs_g: '', fat_g: '', fiber_g: '', servings: '1' }

function ManualMode({ slot, logDate }) {
  const { getToken } = useAuth()
  const [form,   setForm]   = useState(EMPTY_MANUAL)
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState(null)

  function set(e) {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: value }))
  }

  const srv = Math.max(0.25, parseFloat(form.servings) || 1)

  async function save(e) {
    e.preventDefault()
    if (!form.meal_name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const payload = {
        meal_name: form.meal_name.trim(),
        calories:  form.calories  !== '' ? Math.round(Number(form.calories)  * srv) : null,
        protein_g: form.protein_g !== '' ? +(Number(form.protein_g) * srv).toFixed(1) : null,
        carbs_g:   form.carbs_g   !== '' ? +(Number(form.carbs_g)   * srv).toFixed(1) : null,
        fat_g:     form.fat_g     !== '' ? +(Number(form.fat_g)     * srv).toFixed(1) : null,
        fiber_g:   form.fiber_g   !== '' ? +(Number(form.fiber_g)   * srv).toFixed(1) : null,
        meal_slot: slot,
        log_date:  logDate,
      }
      const res = await fetch(`${API_URL}/api/meals/manual`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
      setSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function reset() { setForm(EMPTY_MANUAL); setSaved(false); setError(null) }

  if (saved) return <SavedState name={form.meal_name} onReset={reset} />

  const showTotals = srv !== 1 && (form.calories !== '' || form.protein_g !== '' || form.carbs_g !== '' || form.fat_g !== '')

  return (
    <form onSubmit={save} className="max-w-lg space-y-4">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Food name <span className="text-red-400">*</span></label>
        <input
          type="text"
          name="meal_name"
          value={form.meal_name}
          onChange={set}
          placeholder="e.g. Grilled chicken with rice"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Calories (kcal) per serving" name="calories"  value={form.calories}  onChange={set} placeholder="420" />
        <NumberField label="Protein (g) per serving"     name="protein_g" value={form.protein_g} onChange={set} placeholder="38" />
        <NumberField label="Carbs (g) per serving"       name="carbs_g"   value={form.carbs_g}   onChange={set} placeholder="45" />
        <NumberField label="Fat (g) per serving"         name="fat_g"     value={form.fat_g}     onChange={set} placeholder="12" />
        <NumberField label="Fiber (g) per serving"       name="fiber_g"   value={form.fiber_g}   onChange={set} placeholder="4" />
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Number of servings</label>
          <input
            type="number"
            name="servings"
            value={form.servings}
            onChange={set}
            min="0.25"
            step="0.25"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
        </div>
      </div>

      {showTotals && (
        <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 text-xs text-gray-600">
          <p className="font-semibold mb-1 text-gray-700">Total for {srv} serving{srv !== 1 ? 's' : ''}</p>
          <div className="flex gap-4 flex-wrap">
            {form.calories  !== '' && <span><span className="font-bold text-orange-500">{Math.round(Number(form.calories)  * srv)}</span> cal</span>}
            {form.protein_g !== '' && <span><span className="font-bold text-blue-600">{+(Number(form.protein_g) * srv).toFixed(1)}g</span> P</span>}
            {form.carbs_g   !== '' && <span><span className="font-bold text-yellow-600">{+(Number(form.carbs_g)   * srv).toFixed(1)}g</span> C</span>}
            {form.fat_g     !== '' && <span><span className="font-bold text-pink-500">{+(Number(form.fat_g)     * srv).toFixed(1)}g</span> F</span>}
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <button
        type="submit"
        disabled={saving || !form.meal_name.trim()}
        className="w-full bg-[#E8670A] text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? 'Saving…' : 'Save Meal'}
      </button>
    </form>
  )
}

// ── Food Search mode ──────────────────────────────────────────────────────────

function SearchMode({ slot, logDate }) {
  const { getToken } = useAuth()
  const debounceRef  = useRef(null)

  const [query,       setQuery]       = useState('')
  const [results,     setResults]     = useState([])
  const [searching,   setSearching]   = useState(false)
  const [selected,    setSelected]    = useState(null)
  const [amount,      setAmount]      = useState('100')
  const [unit,        setUnit]        = useState('g')
  const [servings,    setServings]    = useState('1')
  const [saving,      setSaving]      = useState(false)
  const [saved,       setSaved]       = useState(false)
  const [error,       setError]       = useState(null)
  const [recentMeals, setRecentMeals] = useState([])

  // Load the 6 most-recent unique foods the user has logged
  useEffect(() => {
    async function loadRecent() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/meals?limit=40`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const meals = await res.json()
        const seen = new Set()
        const unique = []
        for (const m of meals) {
          if (!seen.has(m.meal_name) && m.calories != null) {
            seen.add(m.meal_name)
            unique.push(m)
            if (unique.length >= 6) break
          }
        }
        setRecentMeals(unique)
      } catch {}
    }
    loadRecent()
  }, [getToken])

  // Convert a logged meal entry into a food-search-compatible object (per-100g macros)
  function mealToFood(meal) {
    const grams = meal.serving_size && meal.serving_unit
      ? toGrams(meal.serving_size, meal.serving_unit) : 100
    const base = grams > 0 ? grams : 100
    const f = 100 / base
    return {
      id:           null,
      name:         meal.meal_name,
      calories:     meal.calories != null ? +(meal.calories * f).toFixed(1) : null,
      protein_g:    meal.protein  != null ? +(meal.protein  * f).toFixed(1) : null,
      carbs_g:      meal.carbs    != null ? +(meal.carbs    * f).toFixed(1) : null,
      fat_g:        meal.fat      != null ? +(meal.fat      * f).toFixed(1) : null,
      fiber_g:      meal.fiber    != null ? +(meal.fiber    * f).toFixed(1) : null,
      _source:      meal.source_type  || 'custom',
      source_label: meal.source_label || 'My food',
      is_verified:  meal.is_verified  || false,
      // Prefill hints — carried through to setAmount / setUnit
      _prefillAmt:  meal.serving_size && meal.serving_unit && SERVING_UNITS.includes(meal.serving_unit)
        ? String(meal.serving_size) : String(Math.round(base)),
      _prefillUnit: meal.serving_unit && SERVING_UNITS.includes(meal.serving_unit)
        ? meal.serving_unit : 'g',
    }
  }

  function pickRecentMeal(meal) {
    const food = mealToFood(meal)
    if (!food) return
    setSelected(food)
    setResults([])
    setAmount(food._prefillAmt)
    setUnit(food._prefillUnit)
  }

  // Select a food from search results — prefill serving size for custom foods
  function handleSelect(food) {
    setSelected(food)
    setResults([])
    setServings('1')
    if (
      food.custom_serving_size != null && food.custom_serving_size > 0 &&
      food.custom_serving_unit && SERVING_UNITS.includes(food.custom_serving_unit)
    ) {
      setAmount(String(food.custom_serving_size))
      setUnit(food.custom_serving_unit)
    } else {
      setAmount('100')
      setUnit('g')
    }
  }

  function handleQuery(e) {
    const val = e.target.value
    setQuery(val)
    setSelected(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!val.trim()) { setResults([]); return }
    debounceRef.current = setTimeout(() => doSearch(val.trim()), 400)
  }

  async function doSearch(q) {
    setSearching(true)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/foods/search?q=${encodeURIComponent(q)}&limit=40`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error()
      setResults((await res.json()).filter(f => f.calories != null))
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  function calcMacros(food, g) {
    const ratio = g / 100
    return {
      calories: Math.round((food.calories  ?? 0) * ratio),
      protein:  Math.round((food.protein_g ?? 0) * ratio * 10) / 10,
      carbs:    Math.round((food.carbs_g   ?? 0) * ratio * 10) / 10,
      fat:      Math.round((food.fat_g     ?? 0) * ratio * 10) / 10,
      fiber:    food.fiber_g > 0 ? Math.round(food.fiber_g * ratio * 10) / 10 : null,
    }
  }

  async function save() {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      const raw = parseFloat(amount)
      if (isNaN(raw) || raw <= 0) throw new Error('Enter a valid amount')
      const srv    = Math.max(0.25, parseFloat(servings) || 1)
      const g      = toGrams(raw, unit) * srv
      const macros = calcMacros(selected, g)
      const micronutrients = scaledMicronutrients(selected, g)
      const token  = await getToken()
      const res    = await fetch(`${API_URL}/api/meals/manual`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meal_name:    selected.name,
          calories:     macros.calories,
          protein_g:    macros.protein,
          carbs_g:      macros.carbs,
          fat_g:        macros.fat,
          fiber_g:      macros.fiber,
          meal_slot:    slot,
          log_date:     logDate,
          serving_size: raw,
          serving_unit: unit,
          source_type:  selected._source,
          source_label: selected.source_label,
          is_verified:  !!selected.is_verified,
          micronutrients,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function handleUnitChange(newUnit) {
    const raw = parseFloat(amount)
    if (!isNaN(raw) && raw > 0) {
      const grams = raw * (UNIT_TO_G[unit] ?? 1)
      const converted = grams / (UNIT_TO_G[newUnit] ?? 1)
      setAmount((Math.round(converted * 1000) / 1000).toString())
    }
    setUnit(newUnit)
  }

  function reset() {
    setQuery(''); setResults([]); setSelected(null)
    setAmount('100'); setUnit('g'); setServings('1'); setSaved(false); setError(null)
  }

  if (saved) return <SavedState name={selected?.name} onReset={reset} resetLabel="Search Again" />

  const raw     = parseFloat(amount)
  const srv     = Math.max(0.25, parseFloat(servings) || 1)
  const g       = !isNaN(raw) && raw > 0 ? toGrams(raw, unit) * srv : 0
  const preview = selected && g > 0 ? calcMacros(selected, g) : null

  return (
    <div className="max-w-lg space-y-4 pb-20">

      {/* Recently Logged — shown only when idle (no query, no selection) */}
      {recentMeals.length > 0 && !query && !selected && (
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Recently logged</p>
          <div className="flex flex-wrap gap-2">
            {recentMeals.map((meal, i) => (
              <button
                key={i}
                onClick={() => pickRecentMeal(meal)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-gray-200 bg-white text-xs font-medium text-gray-700 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors"
              >
                {meal.meal_name}
                <span className="text-gray-400 font-normal">{Math.round(meal.calories)} cal</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={handleQuery}
          placeholder="Search foods (e.g. chicken breast, whole milk, eggs)…"
          className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
        />
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">Searching…</span>
        )}
      </div>

      {results.length > 0 && !selected && (
        <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-72 overflow-y-auto">
          {results.map((food, i) => (
            <button
              key={food.id ?? food.fdc_id ?? i}
              onClick={() => handleSelect(food)}
              className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 leading-snug">{food.name}</p>
                  {food.brand && <p className="text-xs text-gray-500 leading-snug truncate">{food.brand}</p>}
                </div>
                <FoodSourceBadge food={food} className="mt-0.5 shrink-0" />
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {Math.round(food.calories)} cal · {(food.protein_g ?? 0).toFixed(1)}g protein · {(food.carbs_g ?? 0).toFixed(1)}g carbs · {(food.fat_g ?? 0).toFixed(1)}g fat
                <span className="text-gray-400"> per 100g</span>
              </p>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-gray-900 leading-snug">{selected.name}</p>
                <FoodSourceBadge food={selected} />
              </div>
              {selected.brand && <p className="text-xs text-gray-500 mt-0.5">{selected.brand}</p>}
              <p className="text-xs text-gray-400 mt-0.5">
                Per 100g: {Math.round(selected.calories)} cal · {(selected.protein_g ?? 0).toFixed(1)}g P · {(selected.carbs_g ?? 0).toFixed(1)}g C · {(selected.fat_g ?? 0).toFixed(1)}g F
              </p>
            </div>
            <button onClick={() => setSelected(null)} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Change</button>
          </div>

          <div className="space-y-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Serving size</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  min="0.1"
                  step="any"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                />
                <select
                  value={unit}
                  onChange={e => handleUnitChange(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
                >
                  {SERVING_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Number of servings</label>
              <input
                type="number"
                value={servings}
                onChange={e => setServings(e.target.value)}
                min="0.25"
                step="0.25"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </div>
          </div>

          {preview && (
            <>
              <div className="grid grid-cols-4 gap-2">
                <MacroCard label="Calories" value={preview.calories}      unit="kcal"   color="text-orange-500" />
                <MacroCard label="Protein"  value={`${preview.protein}g`} unit="protein" color="text-blue-600" />
                <MacroCard label="Carbs"    value={`${preview.carbs}g`}   unit="carbs"   color="text-yellow-500" />
                <MacroCard label="Fat"      value={`${preview.fat}g`}     unit="fat"     color="text-pink-500" />
              </div>
              <MicronutrientGrid food={selected} grams={g} />
            </>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <button
            onClick={save}
            disabled={saving || !preview}
            className="w-full bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Save Meal'}
          </button>
        </div>
      )}

      {query && results.length === 0 && !searching && !selected && (
        <p className="text-sm text-gray-400 text-center py-8">No results. Try a more specific term (e.g. "raw chicken breast").</p>
      )}
    </div>
  )
}

// ── Recipe Builder mode ───────────────────────────────────────────────────────

const EMPTY_ING = { food_name: '', amount: '', unit: 'g', calories: '', protein: '', carbs: '', fat: '', fiber: '', sugar: '', sodium_mg: '' }

function CreateRecipeForm({ onSave, onCancel, initialRecipe = null }) {
  const { getToken } = useAuth()
  const [name,        setName]        = useState(initialRecipe?.name ?? '')
  const [servings,    setServings]    = useState(String(initialRecipe?.servings ?? '1'))
  const [ingredients, setIngredients] = useState(
    initialRecipe?.ingredients?.length
      ? initialRecipe.ingredients.map(i => ({
          food_name: i.food_name || '',
          amount:    String(i.amount    ?? ''),
          unit:      i.unit     || 'g',
          calories:  String(i.calories  ?? ''),
          protein:   String(i.protein   ?? ''),
          carbs:     String(i.carbs     ?? ''),
          fat:       String(i.fat       ?? ''),
          fiber:     String(i.fiber     ?? ''),
          sugar:     String(i.sugar     ?? ''),
          sodium_mg: String(i.sodium_mg ?? ''),
        }))
      : [{ ...EMPTY_ING }]
  )
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState(null)

  function updateIng(idx, field, val) {
    setIngredients(ings => ings.map((ing, i) => i === idx ? { ...ing, [field]: val } : ing))
  }
  function addIng() { setIngredients(ings => [...ings, { ...EMPTY_ING }]) }
  function removeIng(idx) { setIngredients(ings => ings.filter((_, i) => i !== idx)) }

  const totals = ingredients.reduce(
    (acc, ing) => ({
      calories:  acc.calories  + (parseFloat(ing.calories)  || 0),
      protein:   acc.protein   + (parseFloat(ing.protein)   || 0),
      carbs:     acc.carbs     + (parseFloat(ing.carbs)     || 0),
      fat:       acc.fat       + (parseFloat(ing.fat)       || 0),
      fiber:     acc.fiber     + (parseFloat(ing.fiber)     || 0),
      sugar:     acc.sugar     + (parseFloat(ing.sugar)     || 0),
      sodium_mg: acc.sodium_mg + (parseFloat(ing.sodium_mg) || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium_mg: 0 },
  )

  const srv = parseFloat(servings) || 1

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const url    = initialRecipe
        ? `${API_URL}/api/recipes/${initialRecipe.id}`
        : `${API_URL}/api/recipes`
      const method = initialRecipe ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), servings: srv, ingredients }),
      })
      if (!res.ok) throw new Error(initialRecipe ? 'Failed to update recipe' : 'Failed to save recipe')
      const recipe = await res.json()
      onSave(recipe)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const fieldStyle = 'w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#E8670A]'

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-3">
          <label className="block text-xs font-medium text-gray-600 mb-1">Recipe Name *</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. High Protein Overnight Oats"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Servings</label>
          <input
            type="number"
            value={servings}
            min="0.5"
            step="0.5"
            onChange={e => setServings(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Ingredients</p>
        <div className="space-y-2">
          {ingredients.map((ing, idx) => (
            <div key={idx} className="bg-gray-50 rounded-lg p-3 space-y-2">
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  placeholder="Food name"
                  value={ing.food_name}
                  onChange={e => updateIng(idx, 'food_name', e.target.value)}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#E8670A]"
                />
                <input
                  type="number"
                  placeholder="Amount"
                  value={ing.amount}
                  min="0"
                  onChange={e => updateIng(idx, 'amount', e.target.value)}
                  className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#E8670A]"
                />
                <select
                  value={ing.unit}
                  onChange={e => updateIng(idx, 'unit', e.target.value)}
                  className="w-16 border border-gray-300 rounded-lg px-1 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#E8670A] bg-white"
                >
                  {ING_UNITS.map(u => <option key={u}>{u}</option>)}
                </select>
                {ingredients.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeIng(idx)}
                    className="text-gray-300 hover:text-red-400 text-base leading-none transition-colors"
                  >✕</button>
                )}
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {[['Cal', 'calories'], ['P (g)', 'protein'], ['C (g)', 'carbs'], ['F (g)', 'fat'], ['Fiber', 'fiber']].map(([lbl, field]) => (
                  <div key={field}>
                    <p className="text-[10px] text-gray-400 mb-0.5">{lbl}</p>
                    <input
                      type="number"
                      min="0"
                      value={ing[field]}
                      onChange={e => updateIng(idx, field, e.target.value)}
                      className={fieldStyle}
                    />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {[['Sugar (g)', 'sugar'], ['Sodium (mg)', 'sodium_mg']].map(([lbl, field]) => (
                  <div key={field}>
                    <p className="text-[10px] text-gray-400 mb-0.5">{lbl}</p>
                    <input
                      type="number"
                      min="0"
                      value={ing[field]}
                      onChange={e => updateIng(idx, field, e.target.value)}
                      className={fieldStyle}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addIng}
          className="mt-2 text-xs font-medium text-[#E8670A] hover:text-[#a34506] transition-colors"
        >
          + Add Ingredient
        </button>
      </div>

      {/* Totals */}
      <div className="bg-orange-50 border border-orange-100 rounded-xl p-4">
        <p className="text-xs font-semibold text-gray-600 mb-2">
          Recipe Totals ({srv} {srv === 1 ? 'serving' : 'servings'})
        </p>
        <div className="flex gap-4 text-sm flex-wrap">
          <span><span className="font-bold text-[#E8670A]">{Math.round(totals.calories)}</span> <span className="text-gray-500 text-xs">cal</span></span>
          <span><span className="font-bold text-blue-600">{totals.protein.toFixed(1)}g</span> <span className="text-gray-500 text-xs">protein</span></span>
          <span><span className="font-bold text-yellow-600">{totals.carbs.toFixed(1)}g</span> <span className="text-gray-500 text-xs">carbs</span></span>
          <span><span className="font-bold text-pink-500">{totals.fat.toFixed(1)}g</span> <span className="text-gray-500 text-xs">fat</span></span>
          {totals.sugar > 0 && <span><span className="font-bold text-purple-500">{totals.sugar.toFixed(1)}g</span> <span className="text-gray-500 text-xs">sugar</span></span>}
          {totals.sodium_mg > 0 && <span><span className="font-bold text-teal-600">{Math.round(totals.sodium_mg)}mg</span> <span className="text-gray-500 text-xs">sodium</span></span>}
        </div>
        {srv > 1 && (
          <p className="text-xs text-gray-400 mt-1.5">
            Per serving: {Math.round(totals.calories / srv)} cal · {(totals.protein / srv).toFixed(1)}g P · {(totals.carbs / srv).toFixed(1)}g C · {(totals.fat / srv).toFixed(1)}g F
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="bg-[#E8670A] text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors"
        >
          {saving ? 'Saving…' : initialRecipe ? 'Update Recipe' : 'Save Recipe'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-5 py-2.5 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function RecipesMode({ slot, logDate }) {
  const { getToken } = useAuth()
  const [recipes,       setRecipes]       = useState([])
  const [loading,       setLoading]       = useState(true)
  const [creating,      setCreating]      = useState(false)
  const [editingRecipe, setEditingRecipe] = useState(null)
  const [loggedId,      setLoggedId]      = useState(null)
  const [loggingId,     setLoggingId]     = useState(null)
  const [error,         setError]         = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/recipes`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setRecipes(await res.json())
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { load() }, [load])

  async function logRecipe(recipe) {
    setLoggingId(recipe.id)
    setError(null)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/recipes/${recipe.id}/log`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meal_slot: slot, log_date: logDate }),
      })
      if (!res.ok) throw new Error('Failed to log recipe')
      setLoggedId(recipe.id)
      setTimeout(() => setLoggedId(null), 2000)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoggingId(null)
    }
  }

  async function deleteRecipe(id) {
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/recipes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      setRecipes(prev => prev.filter(r => r.id !== id))
    } catch {}
  }

  if (editingRecipe) {
    return (
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Edit Recipe</h2>
        <CreateRecipeForm
          initialRecipe={editingRecipe}
          onSave={(updated) => {
            setRecipes(prev => prev.map(r => r.id === updated.id ? updated : r))
            setEditingRecipe(null)
          }}
          onCancel={() => setEditingRecipe(null)}
        />
      </div>
    )
  }

  if (creating) {
    return (
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Create New Recipe</h2>
        <CreateRecipeForm
          onSave={(recipe) => { setRecipes(prev => [recipe, ...prev]); setCreating(false) }}
          onCancel={() => setCreating(false)}
        />
      </div>
    )
  }

  const srv = r => parseFloat(r.servings) || 1
  const perSrv = (val, r) => val != null ? +(val / srv(r)).toFixed(1) : null

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{recipes.length} saved recipe{recipes.length !== 1 ? 's' : ''}</p>
        <button
          onClick={() => setCreating(true)}
          className="bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
        >
          + New Recipe
        </button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {loading && <p className="text-sm text-gray-400 text-center py-10">Loading…</p>}

      {!loading && recipes.length === 0 && (
        <div className="text-center py-16">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-sm font-semibold text-gray-700 mb-1">No recipes yet</p>
          <p className="text-xs text-gray-400">Create your first recipe to quick-log it anytime.</p>
        </div>
      )}

      {recipes.map(recipe => {
        const s = srv(recipe)
        const cal  = recipe.calories != null ? Math.round(recipe.calories / s) : null
        const prot = perSrv(recipe.protein, recipe)
        const carb = perSrv(recipe.carbs, recipe)
        const fat  = perSrv(recipe.fat, recipe)

        return (
          <div key={recipe.id} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900">{recipe.name}</p>
                <p className="text-xs text-gray-400 mt-0.5">{s} serving{s !== 1 ? 's' : ''}</p>
                <div className="flex gap-3 mt-1.5 flex-wrap text-xs text-gray-500">
                  {cal  != null && <span><span className="font-medium text-[#E8670A]">{cal}</span> cal</span>}
                  {prot != null && <span><span className="font-medium text-blue-600">{prot}g</span> P</span>}
                  {carb != null && <span><span className="font-medium text-yellow-600">{carb}g</span> C</span>}
                  {fat  != null && <span><span className="font-medium text-pink-500">{fat}g</span> F</span>}
                  <span className="text-gray-300">per serving</span>
                </div>
                {Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0 && (
                  <p className="text-xs text-gray-400 mt-1 truncate">
                    {recipe.ingredients.map(i => i.food_name).filter(Boolean).join(', ')}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => logRecipe(recipe)}
                  disabled={loggingId === recipe.id}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors min-h-[36px] ${
                    loggedId === recipe.id
                      ? 'bg-green-100 text-green-700'
                      : 'bg-[#E8670A] text-white hover:bg-[#c45e09] disabled:opacity-60'
                  }`}
                >
                  {loggedId === recipe.id ? '✓ Logged!' : loggingId === recipe.id ? 'Logging…' : 'Log It'}
                </button>
                <button
                  onClick={() => setEditingRecipe(recipe)}
                  className="px-3 py-2 rounded-lg text-xs font-semibold border border-gray-200 text-gray-600 hover:border-[#E8670A] hover:text-[#E8670A] transition-colors min-h-[36px]"
                  title="Edit recipe"
                >Edit</button>
                <button
                  onClick={() => deleteRecipe(recipe.id)}
                  className="p-2 text-gray-300 hover:text-red-400 text-sm transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center"
                  title="Delete recipe"
                >✕</button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Edit Food Modal ───────────────────────────────────────────────────────────

function EditFoodModal({ food, onSave, onClose }) {
  const { getToken } = useAuth()
  const [form, setForm] = useState({
    food_name:            food.food_name,
    calories_per_serving: food.calories_per_serving != null ? String(food.calories_per_serving) : '',
    protein:              food.protein   != null ? String(food.protein)   : '',
    carbs:                food.carbs     != null ? String(food.carbs)     : '',
    fat:                  food.fat       != null ? String(food.fat)       : '',
    fiber:                food.fiber     != null ? String(food.fiber)     : '',
    sugar:                food.sugar     != null ? String(food.sugar)     : '',
    sodium_mg:            food.sodium_mg != null ? String(food.sodium_mg) : '',
    serving_size:         food.serving_size != null ? String(food.serving_size) : '',
    serving_unit:         food.serving_unit ?? 'g',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  function set(e) { setForm(f => ({ ...f, [e.target.name]: e.target.value })) }

  async function submit(e) {
    e.preventDefault()
    if (!form.food_name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/custom-foods/${food.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          food_name:            form.food_name.trim(),
          calories_per_serving: form.calories_per_serving !== '' ? Number(form.calories_per_serving) : undefined,
          protein:              form.protein   !== '' ? Number(form.protein)   : undefined,
          carbs:                form.carbs     !== '' ? Number(form.carbs)     : undefined,
          fat:                  form.fat       !== '' ? Number(form.fat)       : undefined,
          fiber:                form.fiber     !== '' ? Number(form.fiber)     : undefined,
          sugar:                form.sugar     !== '' ? Number(form.sugar)     : undefined,
          sodium_mg:            form.sodium_mg !== '' ? Number(form.sodium_mg) : undefined,
          serving_size:         form.serving_size !== '' ? Number(form.serving_size) : undefined,
          serving_unit:         form.serving_unit || undefined,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      const updated = await res.json()
      onSave(updated)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mobile-modal-backdrop bg-black/50" onClick={onClose}>
      <form
        onSubmit={submit}
        className="mobile-modal-panel max-w-sm"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-2 shrink-0">
          <h3 className="text-base font-semibold text-gray-900">Edit Food</h3>
        </div>

        {/* Scrollable body */}
        <div className="mobile-modal-body px-5 pb-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Food Name *</label>
            <input type="text" name="food_name" value={form.food_name} onChange={set} required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Serving Size</label>
              <input type="number" name="serving_size" value={form.serving_size} onChange={set} min="0" step="any"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
              <input type="text" name="serving_unit" value={form.serving_unit} onChange={set} placeholder="g, oz, cup…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[['Calories', 'calories_per_serving'], ['Protein (g)', 'protein'], ['Carbs (g)', 'carbs'], ['Fat (g)', 'fat'], ['Fiber (g)', 'fiber'], ['Sugar (g)', 'sugar'], ['Sodium (mg)', 'sodium_mg']].map(([lbl, nm]) => (
              <div key={nm}>
                <label className="block text-xs font-medium text-gray-600 mb-1">{lbl}</label>
                <input type="number" name={nm} value={form[nm]} onChange={set} min="0" step="any"
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
              </div>
            ))}
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        {/* Sticky footer */}
        <div className="mobile-modal-footer flex gap-2">
          <button type="submit" disabled={saving}
            className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onClose} disabled={saving}
            className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

// ── My Foods mode ─────────────────────────────────────────────────────────────

const EMPTY_FOOD = {
  food_name: '', calories_per_serving: '', protein: '', carbs: '', fat: '', fiber: '',
  sugar: '', sodium_mg: '',
  serving_size: '100', serving_unit: 'g', is_global: false,
}

function MyFoodsMode() {
  const { getToken } = useAuth()
  const [foods,       setFoods]       = useState([])
  const [loading,     setLoading]     = useState(true)
  const [creating,    setCreating]    = useState(false)
  const [editingFood, setEditingFood] = useState(null)
  const [isAdmin,     setIsAdmin]     = useState(false)
  const [form,     setForm]     = useState({ ...EMPTY_FOOD })
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState(null)

  useEffect(() => {
    async function init() {
      const token = await getToken()
      const [foodsRes, meRes] = await Promise.all([
        fetch(`${API_URL}/api/custom-foods`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/users/me`,     { headers: { Authorization: `Bearer ${token}` } }),
      ])
      if (foodsRes.ok) setFoods(await foodsRes.json())
      if (meRes.ok) {
        const me = await meRes.json()
        setIsAdmin(me.role === 'admin')
      }
      setLoading(false)
    }
    init()
  }, [getToken])

  function set(e) {
    const { name, value, type, checked } = e.target
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }))
  }

  async function save(e) {
    e.preventDefault()
    if (!form.food_name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/custom-foods`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          food_name:            form.food_name.trim(),
          calories_per_serving: form.calories_per_serving !== '' ? Number(form.calories_per_serving) : null,
          protein:   form.protein   !== '' ? Number(form.protein)   : null,
          carbs:     form.carbs     !== '' ? Number(form.carbs)     : null,
          fat:       form.fat       !== '' ? Number(form.fat)       : null,
          fiber:     form.fiber     !== '' ? Number(form.fiber)     : null,
          sugar:     form.sugar     !== '' ? Number(form.sugar)     : null,
          sodium_mg: form.sodium_mg !== '' ? Number(form.sodium_mg) : null,
          serving_size: form.serving_size !== '' ? Number(form.serving_size) : 100,
          serving_unit: form.serving_unit || 'g',
          is_global: isAdmin ? form.is_global : false,
        }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || 'Failed to save')
      }
      const food = await res.json()
      setFoods(prev => [food, ...prev])
      setForm({ ...EMPTY_FOOD })
      setCreating(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function deleteFood(id) {
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/custom-foods/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      setFoods(prev => prev.filter(f => f.id !== id))
    } catch {}
  }

  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]'
  const tinyInput = 'w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#E8670A]'

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{foods.length} custom food{foods.length !== 1 ? 's' : ''}</p>
        <button
          onClick={() => setCreating(c => !c)}
          className="bg-[#E8670A] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
        >
          {creating ? 'Cancel' : '+ Add Food'}
        </button>
      </div>

      {creating && (
        <form onSubmit={save} className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
          <p className="text-sm font-semibold text-gray-700">Add Custom Food</p>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Food Name *</label>
            <input type="text" name="food_name" value={form.food_name} onChange={set} placeholder="e.g. LWC Protein Shake" className={inputCls} required />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Serving Size</label>
              <input type="number" name="serving_size" value={form.serving_size} onChange={set} min="0" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Serving Unit</label>
              <input type="text" name="serving_unit" value={form.serving_unit} onChange={set} placeholder="g, oz, cup…" className={inputCls} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[['Calories', 'calories_per_serving', '250'], ['Protein (g)', 'protein', '20'], ['Carbs (g)', 'carbs', '30'],
              ['Fat (g)', 'fat', '8'], ['Fiber (g)', 'fiber', '2'], ['Sugar (g)', 'sugar', '0'],
              ['Sodium (mg)', 'sodium_mg', '0']].map(([lbl, nm, ph]) => (
              <div key={nm}>
                <label className="block text-xs font-medium text-gray-600 mb-1">{lbl}</label>
                <input type="number" name={nm} value={form[nm]} onChange={set} min="0" placeholder={ph} className={tinyInput} />
              </div>
            ))}
          </div>

          {isAdmin && (
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" name="is_global" checked={form.is_global} onChange={set} className="rounded text-[#E8670A]" />
              Global (visible to all users)
            </label>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            type="submit"
            disabled={saving || !form.food_name.trim()}
            className="bg-[#E8670A] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Food'}
          </button>
        </form>
      )}

      {loading && <p className="text-sm text-gray-400 text-center py-10">Loading…</p>}

      {!loading && foods.length === 0 && !creating && (
        <div className="text-center py-16">
          <p className="text-4xl mb-3">⭐</p>
          <p className="text-sm font-semibold text-gray-700 mb-1">No custom foods yet</p>
          <p className="text-xs text-gray-400 max-w-xs mx-auto mb-5">Add your go-to foods or LWC supplements here. They'll appear in the food search.</p>
          <button
            onClick={() => setCreating(true)}
            className="bg-[#E8670A] text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
          >
            + Create Food
          </button>
        </div>
      )}

      {foods.map(food => (
        <div key={food.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-gray-900 truncate">{food.food_name}</p>
              {food.is_global && (
                <span className="text-[10px] bg-orange-50 text-[#E8670A] px-1.5 py-0.5 rounded border border-orange-100 shrink-0">Global</span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Per {food.serving_size ?? 100}{food.serving_unit ?? 'g'}:
              {food.calories_per_serving != null && <> <span className="font-medium text-gray-600">{Math.round(food.calories_per_serving)}</span> cal</>}
              {food.protein != null && <> · <span className="font-medium">{food.protein}g</span> P</>}
              {food.carbs   != null && <> · <span className="font-medium">{food.carbs}g</span> C</>}
              {food.fat     != null && <> · <span className="font-medium">{food.fat}g</span> F</>}
            </p>
          </div>
          {(!food.is_global || isAdmin) && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setEditingFood(food)}
                className="text-gray-400 hover:text-[#E8670A] text-xs font-medium transition-colors"
                title="Edit"
              >Edit</button>
              <button
                onClick={() => deleteFood(food.id)}
                className="text-gray-300 hover:text-red-400 text-sm transition-colors"
                title="Delete"
              >✕</button>
            </div>
          )}
        </div>
      ))}

      {editingFood && (
        <EditFoodModal
          food={editingFood}
          onSave={(updated) => {
            setFoods(prev => prev.map(f => f.id === updated.id ? updated : f))
            setEditingFood(null)
          }}
          onClose={() => setEditingFood(null)}
        />
      )}
    </div>
  )
}

// ── Barcode Scanner mode ──────────────────────────────────────────────────────

/**
 * Inline manual-entry form shown when a barcode scan returns "not found".
 * Saves directly to /api/meals/manual, tagging the entry with the barcode.
 */
function BarcodeNotFoundForm({ barcode, slot, logDate, getToken, onSave, onCancel }) {
  const [form,   setForm]   = useState({ meal_name: '', calories: '', protein_g: '', carbs_g: '', fat_g: '', fiber_g: '' })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  function set(e) {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: value }))
  }

  async function save(e) {
    e.preventDefault()
    if (!form.meal_name.trim()) return
    setSaving(true); setError(null)
    try {
      const token = await getToken()

      // 1. Save food to custom_foods with the barcode so future scans find it
      if (barcode) {
        try {
          await fetch(`${API_URL}/api/custom-foods`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              food_name:            form.meal_name.trim(),
              calories_per_serving: form.calories  !== '' ? Number(form.calories)  : null,
              protein:              form.protein_g !== '' ? Number(form.protein_g) : null,
              carbs:                form.carbs_g   !== '' ? Number(form.carbs_g)   : null,
              fat:                  form.fat_g     !== '' ? Number(form.fat_g)     : null,
              fiber:                form.fiber_g   !== '' ? Number(form.fiber_g)   : null,
              serving_size:         100,
              serving_unit:         'g',
              barcode,
            }),
          })
          // Non-critical — if this fails, still log the meal
        } catch {}
      }

      // 2. Log the meal to the food diary
      const res = await fetch(`${API_URL}/api/meals/manual`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meal_name:   form.meal_name.trim(),
          calories:    form.calories  !== '' ? Number(form.calories)  : null,
          protein_g:   form.protein_g !== '' ? Number(form.protein_g) : null,
          carbs_g:     form.carbs_g   !== '' ? Number(form.carbs_g)   : null,
          fat_g:       form.fat_g     !== '' ? Number(form.fat_g)     : null,
          fiber_g:     form.fiber_g   !== '' ? Number(form.fiber_g)   : null,
          meal_slot:   slot,
          log_date:    logDate,
          source_type:  'barcode_manual',
          source_label: barcode ? `Barcode ${barcode}` : 'Manual entry',
        }),
      })
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
      onSave(form.meal_name.trim())
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Add Food Manually</p>
      {barcode && (
        <p className="text-xs text-gray-400">
          Barcode: <span className="font-mono bg-gray-100 px-1 py-0.5 rounded">{barcode}</span>
          <span className="ml-2 text-gray-300">· saved for next scan</span>
        </p>
      )}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Food Name <span className="text-red-400">*</span></label>
        <input
          type="text" name="meal_name" value={form.meal_name} onChange={set} required
          placeholder="e.g. Quest Chocolate Chip Cookie Bar"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[['Calories', 'calories', '200'], ['Protein (g)', 'protein_g', '20'],
          ['Carbs (g)',  'carbs_g',   '25'], ['Fat (g)',     'fat_g',    '8'],
          ['Fiber (g)',  'fiber_g',    '3']].map(([lbl, nm, ph]) => (
          <div key={nm}>
            <label className="block text-xs font-medium text-gray-600 mb-1">{lbl}</label>
            <input type="number" name={nm} value={form[nm]} onChange={set} min="0" placeholder={ph}
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={saving || !form.meal_name.trim()}
          className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Save & Log'}
        </button>
        <button type="button" onClick={onCancel}
          className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
          Cancel
        </button>
      </div>
    </form>
  )
}

// Extract gram weight from serving_size strings like "30g", "2 cookies (30g)"
function parseServingGrams(s) {
  if (!s) return null
  const m = s.match(/\b(\d+(?:\.\d+)?)\s*g(?:\b|$|\))/i)
  return m ? parseFloat(m[1]) : null
}

// Normalise food macros to per-100 g so unit selector works consistently
function normaliseFoodTo100g(food) {
  if (!food.is_per_serving) return { base: food, defaultGrams: 100 }
  const sg = parseServingGrams(food.serving_size)
  if (!sg) return { base: food, defaultGrams: 100 }
  const f = 100 / sg
  return {
    base: {
      calories:  Math.round((food.calories  ?? 0) * f),
      protein_g: food.protein_g != null ? +((food.protein_g * f).toFixed(2)) : null,
      carbs_g:   food.carbs_g   != null ? +((food.carbs_g   * f).toFixed(2)) : null,
      fat_g:     food.fat_g     != null ? +((food.fat_g     * f).toFixed(2)) : null,
      fiber_g:   food.fiber_g   != null ? +((food.fiber_g   * f).toFixed(2)) : null,
      sodium_mg: food.sodium_mg != null ? +((food.sodium_mg * f).toFixed(2)) : null,
      potassium_mg: food.potassium_mg != null ? +((food.potassium_mg * f).toFixed(2)) : null,
      calcium_mg: food.calcium_mg != null ? +((food.calcium_mg * f).toFixed(2)) : null,
      iron_mg: food.iron_mg != null ? +((food.iron_mg * f).toFixed(2)) : null,
      vitamin_d_mcg: food.vitamin_d_mcg != null ? +((food.vitamin_d_mcg * f).toFixed(2)) : null,
      magnesium_mg: food.magnesium_mg != null ? +((food.magnesium_mg * f).toFixed(2)) : null,
    },
    defaultGrams: sg,
  }
}

function BarcodeMode({ slot, logDate }) {
  const { getToken } = useAuth()
  const [scanning,        setScanning]        = useState(true)
  const [loading,         setLoading]         = useState(false)
  const [food,            setFood]            = useState(null)
  const [base,            setBase]            = useState(null)
  const [amount,          setAmount]          = useState('100')
  const [unit,            setUnit]            = useState('g')
  const [servings,        setServings]        = useState('1')
  const [servingGrams,    setServingGrams]    = useState(null)
  const [saving,          setSaving]          = useState(false)
  const [saved,           setSaved]           = useState(false)
  const [savedName,       setSavedName]       = useState(null)
  const [error,           setError]           = useState(null)
  // "not found" flow — barcode was scanned but not in any database
  const [notFound,        setNotFound]        = useState(false)
  const [scannedBarcode,  setScannedBarcode]  = useState(null)
  const [showManualForm,  setShowManualForm]  = useState(false)

  function handleUnitChange(newUnit) {
    const g = toGrams(parseFloat(amount) || 0, unit)
    setAmount(+(g / (UNIT_TO_G[newUnit] ?? 1)).toFixed(2) + '')
    setUnit(newUnit)
  }

  function handleServingsChange(newServings) {
    const sv = Math.max(0.25, parseFloat(newServings) || 1)
    if (servingGrams != null) {
      const totalG = sv * servingGrams
      const inUnit = totalG / (UNIT_TO_G[unit] ?? 1)
      setAmount(String(Math.round(inUnit * 100) / 100))
    }
    setServings(newServings)
  }

  async function handleScan(barcode) {
    setScanning(false)
    setLoading(true)
    setError(null)
    setNotFound(false)
    setScannedBarcode(barcode)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/foods/barcode/${barcode}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      // Always parse JSON defensively — avoid raw parse errors shown to the user
      let data
      try {
        data = await res.json()
      } catch {
        // Response wasn't JSON (e.g. HTML error page from a proxy)
        if (res.status === 404) {
          setNotFound(true)
          return
        }
        throw new Error('Unexpected server response. Try again or log manually.')
      }

      if (!res.ok) {
        // Structured 404 from our backend — show the friendly not-found card
        if (res.status === 404 || data?.not_found) {
          setNotFound(true)
          return
        }
        throw new Error(data?.error || `Server error (${res.status})`)
      }

      const { base: b, defaultGrams } = normaliseFoodTo100g(data)
      setFood(data)
      setBase(b)
      setServingGrams(defaultGrams)
      setServings('1')
      setAmount(String(defaultGrams))
      setUnit('g')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function calcPreview() {
    if (!base) return null
    const g = toGrams(parseFloat(amount) || 0, unit)
    if (g <= 0) return null
    const r = g / 100
    return {
      calories: Math.round((base.calories  ?? 0) * r),
      protein:  +((base.protein_g ?? 0) * r).toFixed(1),
      carbs:    +((base.carbs_g   ?? 0) * r).toFixed(1),
      fat:      +((base.fat_g     ?? 0) * r).toFixed(1),
      fiber:    base.fiber_g  != null ? +((base.fiber_g  * r).toFixed(1)) : null,
      sugar:    food?.sugar_g != null
        ? +((food.sugar_g * (g / (food.is_per_serving ? (parseServingGrams(food.serving_size) ?? 100) : 100))).toFixed(1))
        : null,
      sodium:   food?.sodium_mg != null
        ? Math.round(food.sodium_mg * (g / (food.is_per_serving ? (parseServingGrams(food.serving_size) ?? 100) : 100)))
        : null,
    }
  }

  async function save() {
    const preview = calcPreview()
    if (!food || !preview) return
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const grams = toGrams(parseFloat(amount) || 0, unit)
      const micronutrients = scaledMicronutrients(base, grams)
      const mealName = food.brand ? `${food.name} (${food.brand})` : food.name
      const res = await fetch(`${API_URL}/api/meals/manual`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meal_name:    mealName,
          calories:     preview.calories,
          protein_g:    preview.protein,
          carbs_g:      preview.carbs,
          fat_g:        preview.fat,
          fiber_g:      preview.fiber,
          meal_slot:    slot,
          log_date:     logDate,
          serving_size: parseFloat(amount) || null,
          serving_unit: unit,
          source_type:  food._source,
          source_label: food.source_label,
          is_verified:  !!food.is_verified,
          micronutrients,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setSavedName(mealName)
      setSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function reset() {
    setScanning(false); setFood(null); setBase(null)
    setAmount('100'); setUnit('g'); setServings('1'); setServingGrams(null)
    setSaved(false); setSavedName(null)
    setError(null); setNotFound(false); setScannedBarcode(null); setShowManualForm(false)
  }

  if (saved) return <SavedState name={savedName || food?.name || 'Meal'} onReset={reset} resetLabel="Scan Another" />

  if (scanning) {
    return (
      <div className="max-w-lg">
        <BarcodeScannerWidget
          onScan={handleScan}
          onCancel={() => setScanning(false)}
        />
      </div>
    )
  }

  const preview = calcPreview()

  return (
    <div className="max-w-lg space-y-5">

      {/* ── Food not found ──────────────────────────────────────────────────── */}
      {notFound && !food && !loading && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          {!showManualForm ? (
            <>
              <div className="text-center">
                <div className="text-4xl mb-2">🏷️</div>
                <p className="text-base font-semibold text-gray-900">Food not found</p>
                {scannedBarcode && (
                  <p className="text-xs text-gray-400 font-mono mt-1">{scannedBarcode}</p>
                )}
                <p className="text-sm text-gray-500 mt-2 max-w-xs mx-auto">
                  We couldn't find this barcode yet. You can add it manually and save it for next time.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => setShowManualForm(true)}
                  className="w-full bg-[#E8670A] text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-[#c45e09] transition-colors"
                >
                  Add Food Manually
                </button>
                <button
                  onClick={() => { setNotFound(false); setError(null); setScanning(true) }}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
                >
                  Scan Another
                </button>
              </div>
            </>
          ) : (
            <BarcodeNotFoundForm
              barcode={scannedBarcode}
              slot={slot}
              logDate={logDate}
              getToken={getToken}
              onSave={(name) => { setSavedName(name); setSaved(true) }}
              onCancel={() => setShowManualForm(false)}
            />
          )}
        </div>
      )}

      {/* ── Prompt to open camera (generic, non-not-found state) ────────────── */}
      {!notFound && !food && !loading && (
        <div className="bg-white rounded-xl border-2 border-dashed border-gray-300 p-10 text-center">
          <div className="text-4xl mb-3">🏷️</div>
          <p className="text-sm font-medium text-gray-700 mb-1">Scan a product barcode</p>
          <p className="text-xs text-gray-400 mb-5">Point your camera at any food product barcode</p>
          <button
            onClick={() => { setError(null); setScanning(true) }}
            className="bg-[#E8670A] text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
          >
            Open Camera
          </button>
          {error && (
            <p className="text-sm text-red-500 mt-4">{error}</p>
          )}
        </div>
      )}

      {/* ── Lookup in progress ───────────────────────────────────────────────── */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-10">
          <span className="animate-spin inline-block w-5 h-5 border-2 border-[#E8670A] border-t-transparent rounded-full" />
          <span className="text-sm text-gray-500">Looking up product…</span>
        </div>
      )}

      {/* ── Found food card ──────────────────────────────────────────────────── */}
      {food && base && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          {food.image_url && (
            <img src={food.image_url} alt={food.name}
              className="w-24 h-24 object-contain mx-auto rounded-lg border border-gray-100" />
          )}

          <div className="flex justify-between items-start gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-base font-semibold text-gray-900 leading-snug">{food.name}</p>
                <FoodSourceBadge food={food} />
              </div>
              {food.brand && <p className="text-xs text-gray-400 mt-0.5">{food.brand}</p>}
              {food.serving_size && (
                <p className="text-xs text-gray-500 mt-1">Label serving: <span className="font-medium">{food.serving_size}</span></p>
              )}
            </div>
            <button onClick={reset} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Scan Again</button>
          </div>

          {/* Servings + portion */}
          <div className="space-y-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Number of servings</label>
              <input
                type="number" value={servings} onChange={e => handleServingsChange(e.target.value)}
                min="0.25" step="0.25"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Total amount</label>
              <div className="flex gap-2">
                <input
                  type="number" value={amount} onChange={e => setAmount(e.target.value)}
                  min="0.01" step="any"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
                />
                <select value={unit} onChange={e => handleUnitChange(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white">
                  {SERVING_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Macro preview */}
          {preview && (
            <>
              <div className="grid grid-cols-4 gap-2">
                <MacroCard label="Calories" value={preview.calories}      unit="kcal"    color="text-orange-500" />
                <MacroCard label="Protein"  value={`${preview.protein}g`} unit="protein" color="text-blue-600" />
                <MacroCard label="Carbs"    value={`${preview.carbs}g`}   unit="carbs"   color="text-yellow-500" />
                <MacroCard label="Fat"      value={`${preview.fat}g`}     unit="fat"     color="text-pink-500" />
              </div>
              {preview.sugar != null && (
                <p className="text-xs text-gray-500">Sugar: <span className="font-medium text-gray-700">{preview.sugar}g</span></p>
              )}
              <MicronutrientGrid food={base} grams={toGrams(parseFloat(amount) || 0, unit)} />
            </>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex gap-3">
            <button
              onClick={save} disabled={saving || !preview}
              className="flex-1 bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors"
            >
              {saving ? 'Saving…' : 'Save Meal'}
            </button>
            <button
              onClick={() => { reset(); setScanning(true) }}
              className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
            >
              Scan Again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'photo',    label: '📷 Photo' },
  { id: 'barcode',  label: '🏷️ Scan' },
  { id: 'manual',   label: '✏️ Manual' },
  { id: 'search',   label: '🔍 Search' },
  { id: 'recipes',  label: '📋 Recipes' },
  { id: 'myfoods',  label: '⭐ My Foods' },
]

const SLOT_TABS = ['photo', 'barcode', 'manual', 'search', 'recipes']

export default function LogMeal() {
  const [tab,     setTab]     = useState('photo')
  const [slot,    setSlot]    = useState(getDefaultSlot)
  const [logDate, setLogDate] = useState(() => new Date().toISOString().slice(0, 10))

  return (
    <div className="pb-24">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Log Meal</h1>
      <p className="text-sm text-gray-500 mb-4">Add a meal via photo analysis, manual entry, or food search</p>

      {/* Date picker — shown for all logging tabs */}
      {SLOT_TABS.includes(tab) && (() => {
        const maxDate = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10) })()
        return (
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wide">Log Date</label>
            <input
              type="date"
              value={logDate}
              max={maxDate}
              onChange={e => { const v = e.target.value; setLogDate(v > maxDate ? maxDate : v) }}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>
        )
      })()}

      {/* Slot picker — shown for all logging tabs */}
      {SLOT_TABS.includes(tab) && <SlotPicker value={slot} onChange={setSlot} />}

      {/* Tab bar */}
      <div className="flex gap-0.5 bg-gray-100 rounded-xl p-1 mb-6 max-w-xl">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2 px-2 rounded-lg text-xs font-medium transition-colors ${
              tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'photo'   && <PhotoMode   slot={slot} logDate={logDate} />}
      {tab === 'barcode' && <BarcodeMode slot={slot} logDate={logDate} />}
      {tab === 'manual'  && <ManualMode  slot={slot} logDate={logDate} />}
      {tab === 'search'  && <SearchMode  slot={slot} logDate={logDate} />}
      {tab === 'recipes' && <RecipesMode slot={slot} logDate={logDate} />}
      {tab === 'myfoods' && <MyFoodsMode />}
    </div>
  )
}
