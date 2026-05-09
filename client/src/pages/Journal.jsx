import { useState, useEffect, useCallback, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

// ── Constants ──────────────────────────────────────────────────────────────────

const SLOTS = ['Breakfast', 'AM Snack', 'Lunch', 'PM Snack', 'Dinner', 'Late Snack']
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const MACRO_COLORS = { protein: '#EC4899', carbs: '#3B82F6', fat: '#10B981', calories: '#E8670A' }

const SERVING_UNITS = ['g', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'ml', 'fl oz']
const UNIT_TO_G = { g: 1, oz: 28.3495, lb: 453.592, cup: 240, tbsp: 15, tsp: 5, ml: 1, 'fl oz': 29.5735 }
function toGrams(amount, unit) { return amount * (UNIT_TO_G[unit] ?? 1) }

// ── Helpers ────────────────────────────────────────────────────────────────────

function toDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getMonday(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

function getWeekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

function getDefaultSlot() {
  const h = new Date().getHours()
  if (h >= 5  && h < 10) return 'Breakfast'
  if (h >= 10 && h < 12) return 'AM Snack'
  if (h >= 12 && h < 14) return 'Lunch'
  if (h >= 14 && h < 17) return 'PM Snack'
  if (h >= 17 && h < 20) return 'Dinner'
  return 'Late Snack'
}

function sumMacros(meals) {
  return meals.reduce(
    (acc, m) => ({
      calories: acc.calories + (Number(m.calories) || 0),
      protein:  acc.protein  + (Number(m.protein)  || 0),
      carbs:    acc.carbs    + (Number(m.carbs)    || 0),
      fat:      acc.fat      + (Number(m.fat)      || 0),
      fiber:    acc.fiber    + (Number(m.fiber)    || 0),
      sugar:    m.sugar != null ? acc.sugar + Number(m.sugar) : acc.sugar,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 },
  )
}

function groupBySlot(meals) {
  const g = {}
  for (const m of meals) {
    const key = SLOTS.includes(m.meal_slot) ? m.meal_slot : SLOTS[0]
    if (!g[key]) g[key] = []
    g[key].push(m)
  }
  return g
}

// ── Macro Ring (SVG) ───────────────────────────────────────────────────────────

function MacroRing({ label, value, goal, color, unit = 'g' }) {
  const r = 34
  const circ = 2 * Math.PI * r
  const pct = goal > 0 ? Math.min(value / goal, 1) : 0
  const offset = circ * (1 - pct)
  const over = goal > 0 && value > goal

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative w-[76px] h-[76px]">
        <svg className="w-full h-full" viewBox="0 0 76 76" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="38" cy="38" r={r} fill="none" stroke="#f3f4f6" strokeWidth="7" />
          <circle
            cx="38" cy="38" r={r} fill="none"
            stroke={over ? '#ef4444' : color}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.4s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-sm font-bold text-gray-900 leading-none">{Math.round(value)}</span>
          <span className="text-[9px] text-gray-400 leading-none mt-0.5">{goal ? `/ ${goal}` : '—'}{unit}</span>
        </div>
      </div>
      <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color }}>{label}</span>
    </div>
  )
}

// ── Week Strip ─────────────────────────────────────────────────────────────────

function WeekStrip({ weekDays, selected, onChange, activeDates, onShift }) {
  const todayStr   = toDateStr(new Date())
  const maxDate    = new Date(); maxDate.setDate(maxDate.getDate() + 7)
  const maxDateStr = toDateStr(maxDate)
  const selStr     = toDateStr(selected)

  return (
    <div className="bg-white rounded-2xl border border-gray-200 px-3 py-3 mb-4">
      <div className="flex items-center justify-between mb-2 px-1">
        <button
          onClick={() => onShift(-7)}
          className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition-colors text-sm"
        >
          ‹
        </button>
        <span className="text-xs font-semibold text-gray-600">
          {weekDays[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          {' — '}
          {weekDays[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
        <button
          onClick={() => onShift(7)}
          disabled={toDateStr(weekDays[6]) >= maxDateStr}
          className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {weekDays.map((day, i) => {
          const ds  = toDateStr(day)
          const isSel   = ds === selStr
          const isToday = ds === todayStr
          const hasMeal = activeDates.has(ds)
          const isFuture = ds > maxDateStr

          return (
            <button
              key={ds}
              onClick={() => !isFuture && onChange(day)}
              disabled={isFuture}
              className={`flex flex-col items-center py-1.5 rounded-xl transition-all ${
                isSel
                  ? 'bg-[#E8670A] text-white'
                  : isToday
                    ? 'bg-orange-50 text-[#E8670A]'
                    : 'text-gray-600 hover:bg-gray-50 disabled:opacity-30'
              }`}
            >
              <span className={`text-[10px] font-medium mb-0.5 ${isSel ? 'text-white/80' : 'text-gray-400'}`}>
                {DAY_LETTERS[i]}
              </span>
              <span className="text-sm font-bold leading-none">{day.getDate()}</span>
              <div className={`w-1.5 h-1.5 rounded-full mt-1 ${
                hasMeal
                  ? isSel ? 'bg-white/70' : 'bg-[#E8670A]'
                  : 'bg-transparent'
              }`} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Macro Rings Row ────────────────────────────────────────────────────────────

function MacroRingsRow({ totals, goals }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4">
      <div className="grid grid-cols-4 gap-2">
        <MacroRing label="Protein"  value={totals.protein}  goal={goals.goal_protein}  color={MACRO_COLORS.protein} />
        <MacroRing label="Carbs"    value={totals.carbs}    goal={goals.goal_carbs}    color={MACRO_COLORS.carbs} />
        <MacroRing label="Fat"      value={totals.fat}      goal={goals.goal_fat}      color={MACRO_COLORS.fat} />
        <MacroRing label="Calories" value={totals.calories} goal={goals.goal_calories} color={MACRO_COLORS.calories} unit=" cal" />
      </div>
    </div>
  )
}

// ── Quick Stats Row ────────────────────────────────────────────────────────────

function QuickStats({ totals, waterOz, isToday, onAddWater }) {
  const [adding, setAdding] = useState(false)
  const [oz,     setOz]     = useState('8')

  function handleAdd() {
    const amount = parseFloat(oz)
    if (!isNaN(amount) && amount > 0) {
      onAddWater(amount)
      setAdding(false)
      setOz('8')
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 mb-4 flex items-center gap-4 flex-wrap text-sm">
      <span className="text-gray-500">
        Fiber <span className="font-semibold text-gray-800">{Math.round(totals.fiber)}g</span>
      </span>
      <span className="text-gray-300">|</span>
      <span className="text-gray-500">
        Sugar <span className="font-semibold text-gray-800">{totals.sugar > 0 ? `${Math.round(totals.sugar)}g` : '—'}</span>
      </span>
      <span className="text-gray-300">|</span>
      <span className="text-gray-500 flex items-center gap-2">
        Water <span className="font-semibold text-gray-800">{waterOz > 0 ? `${waterOz}oz` : '—'}</span>
        {isToday && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="w-5 h-5 bg-blue-100 text-blue-600 rounded-full text-xs font-bold flex items-center justify-center hover:bg-blue-200 transition-colors"
          >+</button>
        )}
        {adding && (
          <span className="flex items-center gap-1">
            <input
              type="number" value={oz} onChange={e => setOz(e.target.value)}
              className="w-12 border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
              min="1"
            />
            <span className="text-xs text-gray-400">oz</span>
            <button onClick={handleAdd} className="text-xs text-blue-600 font-semibold hover:text-blue-800">Add</button>
            <button onClick={() => setAdding(false)} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
          </span>
        )}
      </span>
    </div>
  )
}

// ── Meal Entry ─────────────────────────────────────────────────────────────────

function MealEntry({ meal, onEdit, onDelete, onCopy, onMove }) {
  const { getToken } = useAuth()
  const [confirm,  setConfirm]  = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [moving,   setMoving]   = useState(false)
  const [moveSlot, setMoveSlot] = useState(meal.meal_slot || SLOTS[0])
  const [saving,   setSaving]   = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try { await onDelete(meal.id) } finally { setDeleting(false); setConfirm(false) }
  }

  async function handleMove(slot) {
    if (slot === meal.meal_slot) { setMoving(false); return }
    setSaving(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/meals/${meal.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meal_slot: slot }),
      })
      if (!res.ok) throw new Error()
      onMove(meal.id, slot)
    } catch {} finally { setSaving(false); setMoving(false) }
  }

  return (
    <div className="px-4 py-3 border-b border-gray-50 last:border-0">
      <div className="flex gap-3">
        {meal.photo_url ? (
          <img src={meal.photo_url} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center text-gray-300 text-lg shrink-0">🍽</div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-gray-900 leading-snug truncate">{meal.meal_name}</p>
            <span className="text-sm font-bold text-[#E8670A] shrink-0">{meal.calories ?? '?'}<span className="text-xs font-normal text-gray-400"> cal</span></span>
          </div>
          <div className="flex gap-2 mt-0.5 text-xs text-gray-500 flex-wrap">
            {meal.protein  != null && <span><span className="font-medium" style={{ color: MACRO_COLORS.protein }}>{Number(meal.protein).toFixed(0)}g</span> P</span>}
            {meal.carbs    != null && <span><span className="font-medium" style={{ color: MACRO_COLORS.carbs }}>{Number(meal.carbs).toFixed(0)}g</span> C</span>}
            {meal.fat      != null && <span><span className="font-medium" style={{ color: MACRO_COLORS.fat }}>{Number(meal.fat).toFixed(0)}g</span> F</span>}
          </div>

          {/* Action row */}
          {!confirm && !moving && (
            <div className="flex gap-3 mt-1.5">
              <button onClick={() => onEdit(meal)} className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors">Edit</button>
              <button onClick={() => setMoving(true)} className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors">Move</button>
              <button onClick={() => onCopy(meal)} className="text-[11px] text-[#E8670A] hover:text-[#a34506] transition-colors">Copy</button>
              <button onClick={() => setConfirm(true)} className="text-[11px] text-gray-400 hover:text-red-500 transition-colors">Delete</button>
            </div>
          )}

          {/* Move slot picker */}
          {moving && (
            <div className="flex items-center gap-2 mt-1.5">
              <select
                value={moveSlot}
                onChange={e => setMoveSlot(e.target.value)}
                className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-[#E8670A]"
              >
                {SLOTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button
                onClick={() => handleMove(moveSlot)}
                disabled={saving}
                className="text-[11px] font-semibold text-[#E8670A] hover:text-[#a34506] transition-colors"
              >
                {saving ? '…' : 'Move'}
              </button>
              <button onClick={() => setMoving(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
          )}

          {/* Delete confirm */}
          {confirm && (
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[11px] text-gray-500">Delete?</span>
              <button onClick={handleDelete} disabled={deleting} className="text-[11px] font-semibold text-red-500 hover:text-red-700">
                {deleting ? '…' : 'Yes'}
              </button>
              <button onClick={() => setConfirm(false)} className="text-[11px] text-gray-400 hover:text-gray-600">No</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Slot Section ───────────────────────────────────────────────────────────────

function SlotSection({ name, meals, onAddClick, onEdit, onDelete, onCopy, onMove }) {
  const [open, setOpen] = useState(true)
  const t = sumMacros(meals)

  return (
    <div className="mb-3 rounded-2xl overflow-hidden border border-gray-200 bg-white" style={{ borderLeft: '4px solid #E8670A' }}>
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <div>
          <p className="text-base font-bold text-gray-900 leading-none">{name}</p>
          {meals.length > 0 && (
            <p className="text-xs text-gray-500 mt-1">
              <span className="font-semibold" style={{ color: MACRO_COLORS.protein }}>{t.protein.toFixed(0)}P</span>
              {' · '}
              <span className="font-semibold" style={{ color: MACRO_COLORS.carbs }}>{t.carbs.toFixed(0)}C</span>
              {' · '}
              <span className="font-semibold" style={{ color: MACRO_COLORS.fat }}>{t.fat.toFixed(0)}F</span>
              {' · '}
              <span className="font-semibold text-[#E8670A]">{Math.round(t.calories)} cal</span>
            </p>
          )}
          {meals.length === 0 && <p className="text-xs text-gray-400 mt-0.5">No food logged</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={e => { e.stopPropagation(); onAddClick() }}
            className="w-8 h-8 bg-[#E8670A] text-white rounded-full text-xl font-light flex items-center justify-center hover:bg-[#c45e09] transition-colors shadow-sm"
          >
            +
          </button>
          <span className={`text-gray-300 text-sm transition-transform ${open ? '' : '-rotate-90'}`}>▾</span>
        </div>
      </div>

      {open && meals.length > 0 && (
        <div className="border-t border-gray-100">
          {meals.map(meal => (
            <MealEntry key={meal.id} meal={meal} onEdit={onEdit} onDelete={onDelete} onCopy={onCopy} onMove={onMove} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Edit Meal Modal ────────────────────────────────────────────────────────────

function EditMealModal({ meal, onSave, onClose }) {
  const { getToken } = useAuth()
  const [form, setForm] = useState({
    meal_name: meal.meal_name,
    calories:  meal.calories  != null ? String(meal.calories)  : '',
    protein:   meal.protein   != null ? String(meal.protein)   : '',
    carbs:     meal.carbs     != null ? String(meal.carbs)     : '',
    fat:       meal.fat       != null ? String(meal.fat)       : '',
    fiber:     meal.fiber     != null ? String(meal.fiber)     : '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  function set(e) { setForm(f => ({ ...f, [e.target.name]: e.target.value })) }

  async function submit(e) {
    e.preventDefault()
    if (!form.meal_name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/meals/${meal.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meal_name: form.meal_name.trim(),
          calories:  form.calories !== '' ? Number(form.calories) : undefined,
          protein:   form.protein  !== '' ? Number(form.protein)  : undefined,
          carbs:     form.carbs    !== '' ? Number(form.carbs)    : undefined,
          fat:       form.fat      !== '' ? Number(form.fat)      : undefined,
          fiber:     form.fiber    !== '' ? Number(form.fiber)    : undefined,
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
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-xl space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-gray-900">Edit Meal</h3>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
          <input type="text" name="meal_name" value={form.meal_name} onChange={set} required
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[['Calories', 'calories'], ['Protein g', 'protein'], ['Carbs g', 'carbs'], ['Fat g', 'fat'], ['Fiber g', 'fiber']].map(([lbl, nm]) => (
            <div key={nm}>
              <label className="block text-xs font-medium text-gray-600 mb-1">{lbl}</label>
              <input type="number" name={nm} value={form[nm]} onChange={set} min="0"
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
            </div>
          ))}
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={saving}
            className="flex-1 bg-[#E8670A] text-white py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

// ── Copy Meal Modal ────────────────────────────────────────────────────────────

function CopyMealModal({ meal, onConfirm, onClose }) {
  const todayStr = toDateStr(new Date())
  const minStr   = toDateStr((() => { const d = new Date(); d.setDate(d.getDate() - 90); return d })())
  const [date, setDate] = useState(todayStr)
  const [slot, setSlot] = useState(SLOTS.includes(meal.meal_slot) ? meal.meal_slot : SLOTS[0])
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  async function handleConfirm() {
    setSaving(true)
    setError(null)
    try { await onConfirm(meal.id, date, slot); onClose() }
    catch (err) { setError(err.message); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-xl space-y-3" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-gray-900">Copy Meal</h3>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
          <input type="date" value={date} min={minStr} max={todayStr}
            onChange={e => setDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Meal slot</label>
          <select value={slot} onChange={e => setSlot(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
            {SLOTS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex gap-2">
          <button onClick={handleConfirm} disabled={saving}
            className="flex-1 bg-[#E8670A] text-white py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Copy'}
          </button>
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Photo Logger (auto-save) ───────────────────────────────────────────────────

function PhotoLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()
  const inputRef = useRef(null)
  const [photo,       setPhoto]       = useState(null)
  const [preview,     setPreview]     = useState(null)
  const [description, setDescription] = useState('')
  const [phase,       setPhase]       = useState('idle') // idle | analyzing | done | error
  const [analysis,    setAnalysis]    = useState(null)
  const [error,       setError]       = useState(null)

  function handleFile(file) {
    if (!file?.type.startsWith('image/')) return
    if (preview) URL.revokeObjectURL(preview)
    setPhoto(file); setPreview(URL.createObjectURL(file))
    setAnalysis(null); setPhase('idle'); setError(null)
  }

  async function analyzeAndLog() {
    if (!photo) return
    setPhase('analyzing')
    setError(null)
    try {
      const token = await getToken()

      // Analyze
      const fd = new FormData()
      fd.append('photo', photo)
      if (description.trim()) fd.append('description', description.trim())
      const aRes = await fetch(`${API_URL}/api/meals/analyze`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
      if (!aRes.ok) throw new Error(`Analysis failed (${aRes.status})`)
      const a = await aRes.json()
      setAnalysis(a)

      // Auto-save
      const sf = new FormData()
      sf.append('photo', photo)
      sf.append('meal_name', a.meal_name)
      sf.append('calories',  a.calories  ?? 0)
      sf.append('protein_g', a.protein_g ?? 0)
      sf.append('carbs_g',   a.carbs_g   ?? 0)
      sf.append('fat_g',     a.fat_g     ?? 0)
      sf.append('meal_slot', slotName)
      if (a.fiber_g  != null) sf.append('fiber_g',  a.fiber_g)
      if (a.sugar_g  != null) sf.append('sugar_g',  a.sugar_g)
      if (logDate)            sf.append('log_date', logDate)
      const sRes = await fetch(`${API_URL}/api/meals`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: sf })
      if (!sRes.ok) throw new Error(`Save failed (${sRes.status})`)
      const saved = await sRes.json()

      setPhase('done')
      onSaved({ ...saved, sugar: a.sugar_g }, a)
    } catch (err) {
      setError(err.message)
      setPhase('error')
    }
  }

  function reset() {
    if (preview) URL.revokeObjectURL(preview)
    setPhoto(null); setPreview(null); setDescription(''); setPhase('idle'); setAnalysis(null); setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  if (phase === 'done' && analysis) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">✓</div>
          <div>
            <p className="text-sm font-semibold text-gray-900">{analysis.meal_name}</p>
            <p className="text-xs text-gray-500">{analysis.calories} cal · {analysis.protein_g}g P · {analysis.carbs_g}g C · {analysis.fat_g}g F</p>
          </div>
        </div>
        {analysis.katie_feedback && (
          <div className="bg-[#fff7ed] border border-orange-200 rounded-xl px-4 py-3">
            <p className="text-sm text-gray-700">{analysis.katie_feedback}</p>
            <p className="text-xs text-[#E8670A] font-medium mt-1.5 text-right">Katie</p>
          </div>
        )}
        <button onClick={reset}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
          Log Another Photo
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {!preview ? (
        <div
          className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-[#E8670A] hover:bg-[#fff7ed] transition-colors"
          onClick={() => inputRef.current?.click()}
          onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }}
          onDragOver={e => e.preventDefault()}
        >
          <p className="text-3xl mb-2">📷</p>
          <p className="text-sm font-medium text-gray-700">Drop a photo or tap to upload</p>
          <p className="text-xs text-gray-400 mt-1">JPEG, PNG — max 10 MB</p>
          <input ref={inputRef} type="file" accept="image/*" capture="environment"
            className="hidden" onChange={e => handleFile(e.target.files[0])} />
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden border border-gray-200">
          <img src={preview} alt="" className="w-full max-h-48 object-cover" />
          <div className="px-3 py-2 flex justify-between items-center border-t border-gray-100">
            <span className="text-xs text-gray-400 truncate">{photo?.name}</span>
            <button onClick={reset} className="text-xs text-gray-400 hover:text-red-500 ml-2">Remove</button>
          </div>
        </div>
      )}

      {preview && (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Describe your meal (optional)</label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="e.g. 2 scrambled eggs, 1 slice toast with butter"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
          />
          <p className="text-[10px] text-gray-400 mt-1">Helps improve accuracy of the macro estimate</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {preview && (
        <button
          onClick={analyzeAndLog}
          disabled={phase === 'analyzing'}
          className="w-full bg-[#E8670A] text-white py-3 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
        >
          {phase === 'analyzing' ? (
            <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Analyzing and logging…</>
          ) : 'Analyze and Log'}
        </button>
      )}
    </div>
  )
}

// ── Text Logger ────────────────────────────────────────────────────────────────

function TextLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()
  const [text,   setText]   = useState('')
  const [phase,  setPhase]  = useState('idle')
  const [result, setResult] = useState(null)
  const [error,  setError]  = useState(null)

  async function submit() {
    if (!text.trim()) return
    setPhase('logging')
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/meals/text-log`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), meal_slot: slotName, log_date: logDate }),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || `Error ${res.status}`)
      }
      const meal = await res.json()
      setResult(meal)
      setPhase('done')
      onSaved(meal)
    } catch (err) {
      setError(err.message)
      setPhase('idle')
    }
  }

  if (phase === 'done' && result) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">✓</div>
          <div>
            <p className="text-sm font-semibold text-gray-900">{result.meal_name}</p>
            <p className="text-xs text-gray-500">{result.calories} cal · {result.protein}g P · {result.carbs}g C · {result.fat}g F</p>
          </div>
        </div>
        <button onClick={() => { setText(''); setPhase('idle'); setResult(null) }}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
          Log Another
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">Describe what you ate</label>
        <textarea
          rows={3}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="e.g. 250g baked potato with sour cream, or 6oz grilled chicken breast"
          className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] resize-none"
        />
        <p className="text-[10px] text-gray-400 mt-1">AI will estimate the macros from your description</p>
      </div>
      {error && <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{error}</div>}
      <button
        onClick={submit}
        disabled={phase === 'logging' || !text.trim()}
        className="w-full bg-[#E8670A] text-white py-3 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
      >
        {phase === 'logging' ? (
          <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Logging…</>
        ) : 'Log It'}
      </button>
    </div>
  )
}

// ── Search Logger ──────────────────────────────────────────────────────────────

function SearchLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()
  const debounceRef  = useRef(null)
  const [query,     setQuery]     = useState('')
  const [results,   setResults]   = useState([])
  const [searching, setSearching] = useState(false)
  const [selected,  setSelected]  = useState(null)
  const [amount,    setAmount]    = useState('100')
  const [unit,      setUnit]      = useState('g')
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [error,     setError]     = useState(null)

  function handleQuery(e) {
    const val = e.target.value
    setQuery(val); setSelected(null)
    clearTimeout(debounceRef.current)
    if (!val.trim()) { setResults([]); return }
    debounceRef.current = setTimeout(() => doSearch(val.trim()), 400)
  }

  async function doSearch(q) {
    setSearching(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/foods/search?q=${encodeURIComponent(q)}&limit=20`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error()
      setResults((await res.json()).filter(f => f.calories != null))
    } catch { setResults([]) } finally { setSearching(false) }
  }

  function handleUnitChange(newUnit) {
    const grams = toGrams(parseFloat(amount) || 0, unit)
    const newAmount = grams / (UNIT_TO_G[newUnit] ?? 1)
    setAmount(+newAmount.toFixed(2) + '')
    setUnit(newUnit)
  }

  function calcMacros(food, g) {
    const r = g / 100
    return {
      calories: Math.round((food.calories  ?? 0) * r),
      protein:  +((food.protein_g ?? 0) * r).toFixed(1),
      carbs:    +((food.carbs_g   ?? 0) * r).toFixed(1),
      fat:      +((food.fat_g     ?? 0) * r).toFixed(1),
      fiber:    food.fiber_g > 0 ? +((food.fiber_g ?? 0) * r).toFixed(1) : null,
    }
  }

  async function save() {
    if (!selected) return
    setSaving(true); setError(null)
    try {
      const a = parseFloat(amount)
      if (isNaN(a) || a <= 0) throw new Error('Enter a valid amount')
      const g = toGrams(a, unit)
      const macros = calcMacros(selected, g)
      const token  = await getToken()
      const res = await fetch(`${API_URL}/api/meals/manual`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meal_name: selected.name,
          ...macros,
          protein_g: macros.protein,
          carbs_g: macros.carbs,
          fat_g: macros.fat,
          fiber_g: macros.fiber,
          meal_slot: slotName,
          log_date: logDate,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      const meal = await res.json()
      setSaved(true)
      onSaved(meal)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  const grams = toGrams(parseFloat(amount) || 0, unit)
  const preview = selected && grams > 0 ? calcMacros(selected, grams) : null

  if (saved && selected) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">✓</div>
          <div>
            <p className="text-sm font-semibold text-gray-900">{selected.name}</p>
            <p className="text-xs text-gray-500">{preview?.calories ?? 0} cal</p>
          </div>
        </div>
        <button onClick={() => { setQuery(''); setResults([]); setSelected(null); setAmount('100'); setUnit('g'); setSaved(false) }}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
          Search Again
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <input type="text" value={query} onChange={handleQuery}
          placeholder="Search foods (e.g. chicken breast, oats…)"
          className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
        {searching && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">Searching…</span>}
      </div>
      {results.length > 0 && !selected && (
        <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-60 overflow-y-auto bg-white">
          {results.map((food, i) => (
            <button key={food.id ?? i} onClick={() => { setSelected(food); setResults([]) }}
              className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors">
              <p className="text-sm font-medium text-gray-900">{food.name}</p>
              <p className="text-xs text-gray-500">{Math.round(food.calories)} cal · {(food.protein_g ?? 0).toFixed(1)}g P per 100g</p>
            </button>
          ))}
        </div>
      )}
      {selected && (
        <div className="border border-gray-200 rounded-xl p-4 bg-white space-y-3">
          <div className="flex justify-between items-start">
            <p className="text-sm font-semibold text-gray-900">{selected.name}</p>
            <button onClick={() => setSelected(null)} className="text-xs text-gray-400 hover:text-gray-600">Change</button>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Portion</label>
            <div className="flex gap-2">
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} min="0.01" step="any"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
              <select value={unit} onChange={e => handleUnitChange(e.target.value)}
                className="border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white">
                {SERVING_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>
          {preview && (
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              {[['Cal', preview.calories, 'text-[#E8670A]'], ['P', `${preview.protein}g`, `text-[${MACRO_COLORS.protein}]`], ['C', `${preview.carbs}g`, `text-[${MACRO_COLORS.carbs}]`], ['F', `${preview.fat}g`, `text-[${MACRO_COLORS.fat}]`]].map(([l, v, c]) => (
                <div key={l} className="bg-gray-50 rounded-lg py-2">
                  <p className={`font-bold text-sm ${c}`}>{v}</p>
                  <p className="text-gray-400">{l}</p>
                </div>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={save} disabled={saving || !preview}
            className="w-full bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Log It'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Manual Logger ──────────────────────────────────────────────────────────────

function ManualLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()
  const [form,   setForm]   = useState({ meal_name: '', calories: '', protein_g: '', carbs_g: '', fat_g: '', fiber_g: '' })
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState(null)

  function set(e) { setForm(f => ({ ...f, [e.target.name]: e.target.value })) }

  async function submit(e) {
    e.preventDefault()
    if (!form.meal_name.trim()) return
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/meals/manual`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meal_name: form.meal_name.trim(),
          calories:  form.calories  !== '' ? Number(form.calories)  : null,
          protein_g: form.protein_g !== '' ? Number(form.protein_g) : null,
          carbs_g:   form.carbs_g   !== '' ? Number(form.carbs_g)   : null,
          fat_g:     form.fat_g     !== '' ? Number(form.fat_g)     : null,
          fiber_g:   form.fiber_g   !== '' ? Number(form.fiber_g)   : null,
          meal_slot: slotName,
          log_date:  logDate,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      const meal = await res.json()
      setSaved(true); onSaved(meal)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  if (saved) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">✓</div>
          <p className="text-sm font-semibold text-gray-900">{form.meal_name}</p>
        </div>
        <button onClick={() => { setForm({ meal_name: '', calories: '', protein_g: '', carbs_g: '', fat_g: '', fiber_g: '' }); setSaved(false) }}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
          Log Another
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
        <input type="text" name="meal_name" value={form.meal_name} onChange={set} required
          placeholder="e.g. Grilled chicken with rice"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[['Calories', 'calories', '420'], ['Protein (g)', 'protein_g', '38'], ['Carbs (g)', 'carbs_g', '45'], ['Fat (g)', 'fat_g', '12'], ['Fiber (g)', 'fiber_g', '4']].map(([lbl, nm, ph]) => (
          <div key={nm}>
            <label className="block text-xs font-medium text-gray-600 mb-1">{lbl}</label>
            <input type="number" name={nm} value={form[nm]} onChange={set} min="0" placeholder={ph}
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
        ))}
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <button type="submit" disabled={saving || !form.meal_name.trim()}
        className="w-full bg-[#E8670A] text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
        {saving ? 'Saving…' : 'Log It'}
      </button>
    </form>
  )
}

// ── Barcode Logger ─────────────────────────────────────────────────────────────

function BarcodeLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()
  const scannerRef   = useRef(null)
  const [scanning, setScanning] = useState(false)
  const [food,     setFood]     = useState(null)
  const [servings, setServings] = useState('1')
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [error,    setError]    = useState(null)

  useEffect(() => () => { scannerRef.current?.clear().catch(() => {}) }, [])

  async function startScanner() {
    setError(null); setFood(null)
    try {
      const { Html5QrcodeScanner } = await import('html5-qrcode')
      if (scannerRef.current) { await scannerRef.current.clear().catch(() => {}); scannerRef.current = null }
      const scanner = new Html5QrcodeScanner('barcode-reader-journal', { fps: 10, qrbox: { width: 260, height: 130 }, rememberLastUsedCamera: true }, false)
      scannerRef.current = scanner
      scanner.render(async (code) => {
        await scanner.clear().catch(() => {}); scannerRef.current = null; setScanning(false)
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/foods/barcode/${code}`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) { setError('Product not found'); return }
        setFood(await res.json())
      }, () => {})
      setScanning(true)
    } catch { setError('Camera access denied') }
  }

  async function save() {
    if (!food) return
    setSaving(true); setError(null)
    try {
      const srv = parseFloat(servings) || 1
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/meals/manual`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meal_name: food.brand ? `${food.name} (${food.brand})` : food.name,
          calories:  Math.round((food.calories  ?? 0) * srv),
          protein_g: food.protein_g != null ? +((food.protein_g * srv).toFixed(1)) : null,
          carbs_g:   food.carbs_g   != null ? +((food.carbs_g   * srv).toFixed(1)) : null,
          fat_g:     food.fat_g     != null ? +((food.fat_g     * srv).toFixed(1)) : null,
          fiber_g:   food.fiber_g   != null ? +((food.fiber_g   * srv).toFixed(1)) : null,
          meal_slot: slotName,
          log_date:  logDate,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      const meal = await res.json(); setSaved(true); onSaved(meal)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  const srv = parseFloat(servings) || 1

  if (saved) return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
        <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">✓</div>
        <p className="text-sm font-semibold text-gray-900">{food?.name}</p>
      </div>
      <button onClick={() => { setFood(null); setSaved(false); setServings('1') }}
        className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
        Scan Another
      </button>
    </div>
  )

  return (
    <div className="space-y-4">
      {!scanning && !food && (
        <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center">
          <p className="text-3xl mb-2">🏷️</p>
          <p className="text-sm font-medium text-gray-700 mb-4">Scan a product barcode</p>
          <button onClick={startScanner} className="bg-[#E8670A] text-white px-6 py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors">
            Open Camera
          </button>
        </div>
      )}
      <div id="barcode-reader-journal" className={scanning ? '' : 'hidden'} />
      {error && <p className="text-sm text-red-500 text-center">{error}</p>}
      {food && (
        <div className="border border-gray-200 rounded-xl p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-gray-900">{food.name}</p>
            {food.brand && <p className="text-xs text-gray-400">{food.brand}</p>}
            <p className="text-xs text-gray-500 mt-0.5">Serving: {food.serving_size}</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Servings</label>
            <input type="number" value={servings} onChange={e => setServings(e.target.value)} min="0.5" step="0.5"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            {[['Cal', Math.round((food.calories ?? 0) * srv), 'text-[#E8670A]'], ['P', `${((food.protein_g ?? 0) * srv).toFixed(1)}g`, 'text-pink-500'], ['C', `${((food.carbs_g ?? 0) * srv).toFixed(1)}g`, 'text-blue-500'], ['F', `${((food.fat_g ?? 0) * srv).toFixed(1)}g`, 'text-green-500']].map(([l, v, c]) => (
              <div key={l} className="bg-gray-50 rounded-lg py-2">
                <p className={`font-bold text-sm ${c}`}>{v}</p>
                <p className="text-gray-400">{l}</p>
              </div>
            ))}
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={save} disabled={saving}
            className="w-full bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Log It'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Recipes Logger ─────────────────────────────────────────────────────────────

function RecipesLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()
  const [recipes, setRecipes]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [logging, setLogging]   = useState(null)
  const [loggedId, setLoggedId] = useState(null)
  const [error,   setError]     = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/recipes`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) setRecipes(await res.json())
      } finally { setLoading(false) }
    }
    load()
  }, [getToken])

  async function logRecipe(recipe) {
    setLogging(recipe.id); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/recipes/${recipe.id}/log`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meal_slot: slotName, log_date: logDate }),
      })
      if (!res.ok) throw new Error('Failed to log recipe')
      const meal = await res.json()
      setLoggedId(recipe.id)
      onSaved(meal)
      setTimeout(() => setLoggedId(null), 2000)
    } catch (err) { setError(err.message) } finally { setLogging(null) }
  }

  if (loading) return <p className="text-sm text-gray-400 text-center py-6">Loading…</p>
  if (!recipes.length) return (
    <div className="text-center py-8">
      <p className="text-3xl mb-2">📋</p>
      <p className="text-sm text-gray-500">No saved recipes. Create one in the full Log Meal view.</p>
    </div>
  )

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-500">{error}</p>}
      {recipes.map(r => {
        const s = parseFloat(r.servings) || 1
        const cal = r.calories != null ? Math.round(r.calories / s) : null
        return (
          <div key={r.id} className="flex items-center justify-between gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">{r.name}</p>
              {cal != null && <p className="text-xs text-gray-500">{cal} cal / serving</p>}
            </div>
            <button onClick={() => logRecipe(r)} disabled={logging === r.id}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${loggedId === r.id ? 'bg-green-100 text-green-700' : 'bg-[#E8670A] text-white hover:bg-[#c45e09] disabled:opacity-60'}`}>
              {loggedId === r.id ? '✓ Logged' : logging === r.id ? '…' : 'Log'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ── Add Food Drawer ────────────────────────────────────────────────────────────

const ADD_OPTIONS = [
  { id: 'photo',   icon: '📷', label: 'Photo' },
  { id: 'text',    icon: '💬', label: 'Text Entry' },
  { id: 'search',  icon: '🔍', label: 'Search Foods' },
  { id: 'manual',  icon: '✏️', label: 'Manual' },
  { id: 'barcode', icon: '🏷️', label: 'Barcode' },
  { id: 'recipes', icon: '📋', label: 'Recipes' },
]

const MODE_TITLES = { photo: 'Photo', text: 'Text Entry', search: 'Search Foods', manual: 'Manual Entry', barcode: 'Scan Barcode', recipes: 'Recipes' }
const LOGGERS = { photo: PhotoLogger, text: TextLogger, search: SearchLogger, manual: ManualLogger, barcode: BarcodeLogger, recipes: RecipesLogger }

function AddFoodDrawer({ slotName, onClose, onSaved, logDate }) {
  const [mode, setMode] = useState(null)
  const Logger = mode ? LOGGERS[mode] : null

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="bg-white rounded-t-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            {mode && (
              <button onClick={() => setMode(null)} className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-full hover:bg-gray-100 transition-colors text-lg">
                ‹
              </button>
            )}
            <div>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide">{slotName}</p>
              <h3 className="text-base font-bold text-gray-900">{mode ? MODE_TITLES[mode] : 'Add Food'}</h3>
            </div>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">
            ✕
          </button>
        </div>

        <div className="p-5 pb-24">
          {!mode && (
            <div className="grid grid-cols-3 gap-3">
              {ADD_OPTIONS.map(opt => (
                <button key={opt.id} onClick={() => setMode(opt.id)}
                  className="flex flex-col items-center gap-2 bg-gray-50 hover:bg-orange-50 hover:border-[#E8670A] border border-gray-200 rounded-2xl py-4 transition-all">
                  <span className="text-2xl">{opt.icon}</span>
                  <span className="text-xs font-semibold text-gray-700">{opt.label}</span>
                </button>
              ))}
            </div>
          )}

          {Logger && (
            <Logger
              slotName={slotName}
              logDate={logDate}
              onSaved={(meal, analysis) => { onSaved(meal, analysis); }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Journal Page ──────────────────────────────────────────────────────────

export default function Journal() {
  const { getToken } = useAuth()

  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d
  })
  const [weekStart,   setWeekStart]   = useState(() => getMonday(new Date()))
  const [meals,       setMeals]       = useState([])
  const [goals,       setGoals]       = useState({})
  const [waterOz,     setWaterOz]     = useState(0)
  const [loading,     setLoading]     = useState(true)
  const [activeDates, setActiveDates] = useState(new Set())
  const [addSlot,     setAddSlot]     = useState(null)
  const [editingMeal, setEditingMeal] = useState(null)
  const [copyingMeal, setCopyingMeal] = useState(null)

  const weekDays = getWeekDays(weekStart)
  const todayStr = toDateStr(new Date())
  const isToday  = toDateStr(selectedDate) === todayStr

  // Load meals for selected date
  const loadMeals = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/meals?date=${toDateStr(selectedDate)}`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setMeals(await res.json())
    } finally { setLoading(false) }
  }, [selectedDate, getToken])

  useEffect(() => { loadMeals() }, [loadMeals])

  // Load goals once
  useEffect(() => {
    async function loadGoals() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) setGoals(await res.json())
      } catch {}
    }
    loadGoals()
  }, [getToken])

  // Load water for today only
  useEffect(() => {
    if (!isToday) { setWaterOz(0); return }
    async function loadWater() {
      try {
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/daily-logs/today`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) { const d = await res.json(); setWaterOz(d.water_oz ?? 0) }
      } catch {}
    }
    loadWater()
  }, [isToday, getToken])

  // Load active dates for current week
  useEffect(() => {
    async function loadActive() {
      try {
        const start = toDateStr(weekDays[0])
        const end   = toDateStr(weekDays[6])
        const token = await getToken()
        const res = await fetch(`${API_URL}/api/meals/active-dates?start=${start}&end=${end}`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) setActiveDates(new Set(await res.json()))
      } catch {}
    }
    loadActive()
  }, [weekStart, getToken])

  // Shift week (allow up to today+7)
  function shiftWeek(days) {
    const next = new Date(weekStart)
    next.setDate(weekStart.getDate() + days)
    const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 7)
    if (toDateStr(next) > toDateStr(maxDate)) return
    setWeekStart(next)
  }

  // Change selected date (also sync week if needed)
  function handleDaySelect(day) {
    setSelectedDate(day)
    const monday = getMonday(day)
    if (toDateStr(monday) !== toDateStr(weekStart)) setWeekStart(monday)
  }

  // Add water
  async function addWater(oz) {
    try {
      const token = await getToken()
      const current = waterOz ?? 0
      const res = await fetch(`${API_URL}/api/daily-logs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ water_oz: current + oz }),
      })
      if (res.ok) { const d = await res.json(); setWaterOz(d.water_oz ?? 0) }
    } catch {}
  }

  // Meal CRUD callbacks
  const handleMealSaved = useCallback((meal) => {
    setMeals(prev => [...prev, meal])
    setActiveDates(prev => new Set([...prev, toDateStr(selectedDate)]))
    setAddSlot(null)
  }, [selectedDate])

  const handleMealEdited = useCallback((updated) => {
    setMeals(prev => prev.map(m => m.id === updated.id ? { ...m, ...updated } : m))
    setEditingMeal(null)
  }, [])

  const handleMealDeleted = useCallback(async (mealId) => {
    try {
      const token = await getToken()
      await fetch(`${API_URL}/api/meals/${mealId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      setMeals(prev => prev.filter(m => m.id !== mealId))
    } catch {}
  }, [getToken])

  const handleMealMoved = useCallback((mealId, newSlot) => {
    setMeals(prev => prev.map(m => m.id === mealId ? { ...m, meal_slot: newSlot } : m))
  }, [])

  const handleMealCopied = useCallback(async (mealId, date, slot) => {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/meals/${mealId}/copy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, slot }),
    })
    if (!res.ok) throw new Error('Failed to copy meal')
    const newMeal = await res.json()
    if (date === toDateStr(selectedDate)) setMeals(prev => [...prev, newMeal])
    setCopyingMeal(null)
  }, [getToken, selectedDate])

  const totals    = sumMacros(meals)
  const slotMeals = groupBySlot(meals)

  return (
    <div className="max-w-2xl mx-auto pb-24">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Journal</h1>
        {!isToday && (
          <button
            onClick={() => { setSelectedDate(new Date(new Date().setHours(0,0,0,0))); setWeekStart(getMonday(new Date())) }}
            className="text-sm font-medium text-[#E8670A] hover:text-[#c45e09] transition-colors"
          >
            Today
          </button>
        )}
      </div>

      {/* Week strip calendar */}
      <WeekStrip
        weekDays={weekDays}
        selected={selectedDate}
        onChange={handleDaySelect}
        activeDates={activeDates}
        onShift={shiftWeek}
      />

      {/* Macro rings */}
      <MacroRingsRow totals={totals} goals={goals} />

      {/* Quick stats */}
      <QuickStats totals={totals} waterOz={waterOz} isToday={isToday} onAddWater={addWater} />

      {/* Meal slots */}
      {loading ? (
        <p className="text-sm text-gray-400 text-center py-10">Loading…</p>
      ) : (
        SLOTS.map(slot => (
          <SlotSection
            key={slot}
            name={slot}
            meals={slotMeals[slot] || []}
            onAddClick={() => setAddSlot(slot)}
            onEdit={setEditingMeal}
            onDelete={handleMealDeleted}
            onCopy={setCopyingMeal}
            onMove={handleMealMoved}
          />
        ))
      )}

      {/* Add food drawer */}
      {addSlot && (
        <AddFoodDrawer
          slotName={addSlot}
          logDate={toDateStr(selectedDate)}
          onClose={() => setAddSlot(null)}
          onSaved={handleMealSaved}
        />
      )}

      {/* Edit meal modal */}
      {editingMeal && (
        <EditMealModal
          meal={editingMeal}
          onSave={handleMealEdited}
          onClose={() => setEditingMeal(null)}
        />
      )}

      {/* Copy meal modal */}
      {copyingMeal && (
        <CopyMealModal
          meal={copyingMeal}
          onConfirm={handleMealCopied}
          onClose={() => setCopyingMeal(null)}
        />
      )}

      {/* Fixed bottom nav */}
      <nav
        className="fixed bottom-0 right-0 bg-white border-t border-gray-200 z-40 flex items-center justify-around h-16"
        style={{ left: '15rem' }}
      >
        <NavLink to="/journal"
          className="flex flex-col items-center gap-0.5 text-[#E8670A]">
          <span className="text-lg leading-none">📅</span>
          <span className="text-[10px] font-semibold">Journal</span>
        </NavLink>
        <button
          onClick={() => setAddSlot(getDefaultSlot())}
          className="w-14 h-14 bg-[#E8670A] text-white rounded-full text-3xl font-light flex items-center justify-center shadow-lg hover:bg-[#c45e09] transition-colors -mt-4"
        >
          +
        </button>
        <NavLink to="/ai-coach"
          className={({ isActive }) => `flex flex-col items-center gap-0.5 ${isActive ? 'text-[#E8670A]' : 'text-gray-400 hover:text-gray-700'}`}>
          <span className="text-lg leading-none">💬</span>
          <span className="text-[10px] font-semibold">Coach</span>
        </NavLink>
        <NavLink to="/settings"
          className={({ isActive }) => `flex flex-col items-center gap-0.5 ${isActive ? 'text-[#E8670A]' : 'text-gray-400 hover:text-gray-700'}`}>
          <span className="text-lg leading-none">⚙️</span>
          <span className="text-[10px] font-semibold">Settings</span>
        </NavLink>
      </nav>
    </div>
  )
}
