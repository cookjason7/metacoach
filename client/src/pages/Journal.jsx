import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'
import BarcodeScannerWidget from '../components/BarcodeScanner.jsx'
import FoodSourceBadge from '../components/FoodSourceBadge.jsx'
import MicronutrientGrid from '../components/MicronutrientGrid.jsx'
import { calculateMicronutrientTotals } from '../components/MicronutrientTotals.jsx'

// ── Constants ──────────────────────────────────────────────────────────────────

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

const SLOTS = ['Breakfast', 'Lunch', 'Dinner', 'Snack']

// Internal stored slot options for copy/move modal (maps snack timing to DB values)
const SLOT_OPTIONS = [
  { value: 'Breakfast',  label: 'Breakfast' },
  { value: 'AM Snack',   label: 'Morning Snack' },
  { value: 'Lunch',      label: 'Lunch' },
  { value: 'PM Snack',   label: 'Afternoon Snack' },
  { value: 'Dinner',     label: 'Dinner' },
  { value: 'Late Snack', label: 'Evening Snack' },
]

const SNACK_SLOTS = new Set(['AM Snack', 'PM Snack', 'Late Snack', 'Snack'])
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const MACRO_COLORS = { protein: '#EC4899', carbs: '#3B82F6', fat: '#10B981', calories: '#E8670A' }

const SERVING_UNITS = ['g', 'oz', 'lb', 'cup', 'tbsp', 'tsp', 'ml', 'fl oz']
const MANUAL_SERVING_UNITS = ['item', 'g', 'oz', 'cup', 'tbsp', 'tsp', 'slice', 'scoop']
const UNIT_TO_G = { g: 1, oz: 28.3495, lb: 453.592, cup: 240, tbsp: 15, tsp: 5, ml: 1, 'fl oz': 29.5735 }
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
  if (h >= 10 && h < 12) return 'Snack'
  if (h >= 12 && h < 14) return 'Lunch'
  if (h >= 14 && h < 17) return 'Snack'
  if (h >= 17 && h < 20) return 'Dinner'
  return 'Snack'
}

// Map 'Snack' display slot to an internal DB slot based on time of day
function defaultSnackTiming() {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 'AM Snack'
  if (h >= 12 && h < 18) return 'PM Snack'
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
    let key = m.meal_slot
    // Bucket all snack variants under 'Snack'
    if (SNACK_SLOTS.has(key)) key = 'Snack'
    else if (!SLOTS.includes(key)) key = SLOTS[0]
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

// ── Foundation Ring (smaller SVG ring for the Foundation card) ────────────────

function FoundationRing({ label, value, goal, color, unit }) {
  const r = 27
  const circ = 2 * Math.PI * r
  const pct    = goal > 0 ? Math.min(value / goal, 1) : 0
  const offset = circ * (1 - pct)
  const over   = goal > 0 && value > goal

  const fmtVal = unit === 'mcg'
    ? Number(value).toFixed(1).replace(/\.0$/, '')
    : unit === 'mg'
      ? Math.round(value)
      : Math.round(value)

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-[62px] h-[62px]">
        <svg className="w-full h-full" viewBox="0 0 62 62" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="31" cy="31" r={r} fill="none" stroke="#f3f4f6" strokeWidth="6" />
          <circle cx="31" cy="31" r={r} fill="none"
            stroke={over ? '#ef4444' : color}
            strokeWidth="6" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.5s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-px">
          <span className="text-[11px] font-bold text-gray-900 leading-none">{fmtVal}</span>
          {unit && <span className="text-[8px] text-gray-400 leading-none">{unit}</span>}
        </div>
      </div>
      <span className="text-[10px] font-semibold text-gray-600 text-center leading-tight">{label}</span>
      <span className="text-[9px] text-gray-400 leading-none">/ {goal}{unit}</span>
    </div>
  )
}

// ── Women's Health Card (definition kept; rendered on Dashboard only) ─────────

function WomensHealthCard({ meals, waterOz, isToday, onAddWater }) {
  const [addingWater, setAddingWater] = useState(false)
  const [oz, setOz] = useState('8')
  const micros = calculateMicronutrientTotals(meals)
  const getMicro = (key) => micros.find(m => m.key === key)?.value ?? 0

  function handleAddWater() {
    const amount = parseFloat(oz)
    if (!isNaN(amount) && amount > 0) {
      onAddWater(amount)
      setAddingWater(false)
      setOz('8')
    }
  }

  const rings = [
    { label: 'Water',     value: waterOz,                   goal: 64,   unit: 'oz',  color: '#60A5FA' },
    { label: 'Calcium',   value: getMicro('calcium_mg'),    goal: 1200, unit: 'mg',  color: '#3B82F6' },
    { label: 'Vitamin D', value: getMicro('vitamin_d_mcg'), goal: 20,   unit: 'mcg', color: '#F59E0B' },
    { label: 'Iron',      value: getMicro('iron_mg'),       goal: 18,   unit: 'mg',  color: '#8B5CF6' },
  ]

  const overallPct = rings.reduce((s, r) => s + Math.min(r.goal > 0 ? r.value / r.goal : 0, 1), 0) / rings.length

  function statusLabel(p) {
    if (p >= 0.8) return 'On track'
    if (p >= 0.5) return 'Strong start'
    if (p >= 0.2) return 'Needs attention'
    return 'Low today'
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Women's Health</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">{statusLabel(overallPct)}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold" style={{ color: '#3B82F6' }}>{Math.round(overallPct * 100)}%</p>
          <p className="text-[10px] text-gray-400">complete</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-y-4 gap-x-2 mb-3">
        {rings.map(r => <FoundationRing key={r.label} {...r} />)}
      </div>
      {isToday && (
        <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
          <span className="text-[11px] text-gray-400">Log water</span>
          {!addingWater ? (
            <button
              onClick={() => setAddingWater(true)}
              className="w-5 h-5 bg-blue-100 text-blue-600 rounded-full text-xs font-bold flex items-center justify-center hover:bg-blue-200 transition-colors"
            >+</button>
          ) : (
            <span className="flex items-center gap-1">
              <input
                type="number" value={oz} onChange={e => setOz(e.target.value)}
                className="w-12 border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                min="1"
              />
              <span className="text-xs text-gray-400">oz</span>
              <button onClick={handleAddWater} className="text-xs text-blue-600 font-semibold hover:text-blue-800">Add</button>
              <button onClick={() => setAddingWater(false)} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
            </span>
          )}
        </div>
      )}
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

// ── Compact Macro Ring (smaller SVG for 4-up mobile layout) ───────────────────

function CompactMacroRing({ label, value, goal, color, unit = 'g' }) {
  const r = 28
  const circ = 2 * Math.PI * r
  const pct = goal > 0 ? Math.min(value / goal, 1) : 0
  const offset = circ * (1 - pct)
  const over = goal > 0 && value > goal

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-[64px] h-[64px]">
        <svg className="w-full h-full" viewBox="0 0 64 64" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="32" cy="32" r={r} fill="none" stroke="#f3f4f6" strokeWidth="6" />
          <circle
            cx="32" cy="32" r={r} fill="none"
            stroke={over ? '#ef4444' : color}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.4s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xs font-bold text-gray-900 leading-none">{Math.round(value)}</span>
          <span className="text-[9px] text-gray-400 leading-none mt-0.5">{goal ? `/ ${goal}` : '—'}</span>
        </div>
      </div>
      <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color }}>{label}</span>
    </div>
  )
}

// ── Compact Macro Summary (4 rings + Fiber text row) ──────────────────────────

function CompactMacroSummary({ totals, goals }) {
  const rings = [
    { label: 'Calories', value: totals.calories, goal: goals.goal_calories || null, color: MACRO_COLORS.calories },
    { label: 'Protein',  value: totals.protein,  goal: goals.goal_protein  || null, color: MACRO_COLORS.protein },
    { label: 'Carbs',    value: totals.carbs,    goal: goals.goal_carbs    || null, color: MACRO_COLORS.carbs },
    { label: 'Fat',      value: totals.fat,      goal: goals.goal_fat      || null, color: MACRO_COLORS.fat },
  ]
  const fiberGoal = goals.goal_fiber || 25
  const fiberPct  = Math.min(totals.fiber / fiberGoal, 1)
  const fiberOver = totals.fiber > fiberGoal
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4">
      <div className="grid grid-cols-4 gap-2">
        {rings.map(r => <CompactMacroRing key={r.label} {...r} />)}
      </div>
      {/* Fiber text row */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100 px-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold text-[#10B981]">Fiber</span>
          <span className={`text-[11px] font-bold ${fiberOver ? 'text-red-500' : 'text-gray-800'}`}>
            {Math.round(totals.fiber)}g
          </span>
          <span className="text-[11px] text-gray-400">/ {fiberGoal}g</span>
        </div>
        {/* Mini progress bar */}
        <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${fiberPct * 100}%`, background: fiberOver ? '#ef4444' : '#10B981' }}
          />
        </div>
      </div>
    </div>
  )
}

// ── Quick Stats Row ────────────────────────────────────────────────────────────

function QuickStats({ totals }) {
  if (totals.sugar <= 0) return null
  return (
    <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 mb-4 flex items-center gap-2 text-sm">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mr-1">Also Logged</span>
      <span className="text-gray-500">
        Sugar <span className="font-semibold text-gray-800">{Math.round(totals.sugar)}g</span>
      </span>
    </div>
  )
}

// ── Meal Entry ─────────────────────────────────────────────────────────────────

function MealEntry({ meal, onEdit, onDelete, onCopy, onMove }) {
  const [confirm,  setConfirm]  = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try { await onDelete(meal.id) } finally { setDeleting(false); setConfirm(false) }
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
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 leading-snug truncate">{meal.meal_name}</p>
              <FoodSourceBadge food={{ ...meal, _source: meal.source_type }} className="mt-1" />
            </div>
            <span className="text-sm font-bold text-[#E8670A] shrink-0">{meal.calories ?? '?'}<span className="text-xs font-normal text-gray-400"> cal</span></span>
          </div>
          <div className="flex gap-2 mt-0.5 text-xs text-gray-500 flex-wrap">
            {meal.protein  != null && <span><span className="font-medium" style={{ color: MACRO_COLORS.protein }}>{Number(meal.protein).toFixed(0)}g</span> P</span>}
            {meal.carbs    != null && <span><span className="font-medium" style={{ color: MACRO_COLORS.carbs }}>{Number(meal.carbs).toFixed(0)}g</span> C</span>}
            {meal.fat      != null && <span><span className="font-medium" style={{ color: MACRO_COLORS.fat }}>{Number(meal.fat).toFixed(0)}g</span> F</span>}
          </div>
          {/* Action row */}
          {!confirm && (
            <div className="flex flex-wrap gap-2 mt-2">
              <button onClick={() => onEdit(meal)} className="min-h-8 px-2 text-[11px] text-gray-500 hover:text-gray-700 transition-colors">Edit</button>
              <button onClick={() => onMove(meal)} className="min-h-8 px-2 text-[11px] text-gray-500 hover:text-gray-700 transition-colors">Move</button>
              <button onClick={() => onCopy(meal)} className="min-h-8 px-2 text-[11px] text-[#E8670A] hover:text-[#a34506] transition-colors">Copy</button>
              <button onClick={() => setConfirm(true)} className="min-h-8 px-2 text-[11px] text-gray-500 hover:text-red-500 transition-colors">Delete</button>
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

function SlotSection({ name, meals, onAddClick, onEdit, onDelete, onCopy, onMove, onCopySlot }) {
  const lsKey = `journal_slot_${name.toLowerCase().replace(/\s+/g, '_')}`
  const [open,     setOpen]     = useState(() => {
    try { const v = localStorage.getItem(lsKey); return v === null ? true : v === 'true' } catch { return true }
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const t     = sumMacros(meals)
  const count = meals.length

  function toggle() {
    setOpen(o => {
      const next = !o
      try { localStorage.setItem(lsKey, String(next)) } catch {}
      return next
    })
  }

  useEffect(() => {
    if (!menuOpen) return
    function handler(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  return (
    <div className="mb-3 rounded-2xl border border-gray-200 bg-white overflow-hidden" style={{ borderLeft: '4px solid #E8670A' }}>

      {/* ── Header row — always visible ─────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-4 py-3.5 cursor-pointer select-none"
        onClick={toggle}
      >
        {/* Slot name + macro summary */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-gray-900">{name}</span>
            {count > 0 && (
              <span className="text-[10px] font-semibold text-gray-400 bg-gray-100 rounded-full px-1.5 py-0.5 leading-none">
                {count} item{count !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {count > 0 ? (
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="text-xs font-bold text-[#E8670A]">{Math.round(t.calories)} cal</span>
              <span className="text-gray-300 text-[10px]">·</span>
              <span className="text-[11px] font-semibold" style={{ color: MACRO_COLORS.protein }}>{t.protein.toFixed(0)}g P</span>
              <span className="text-gray-300 text-[10px]">·</span>
              <span className="text-[11px] font-semibold" style={{ color: MACRO_COLORS.carbs }}>{t.carbs.toFixed(0)}g C</span>
              <span className="text-gray-300 text-[10px]">·</span>
              <span className="text-[11px] font-semibold" style={{ color: MACRO_COLORS.fat }}>{t.fat.toFixed(0)}g F</span>
            </div>
          ) : (
            <p className="text-xs text-gray-400 mt-0.5">Nothing logged yet</p>
          )}
        </div>

        {/* Three-dot menu + add button + chevron */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Three-dot slot menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
              className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
              aria-label={`${name} options`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/>
              </svg>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-20 min-w-[130px] overflow-hidden">
                <button
                  onClick={e => { e.stopPropagation(); setMenuOpen(false); onCopySlot(name) }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Copy Meal
                </button>
              </div>
            )}
          </div>
          <button
            onClick={e => { e.stopPropagation(); onAddClick() }}
            className="w-8 h-8 bg-[#E8670A] text-white rounded-full text-xl font-light flex items-center justify-center hover:bg-[#c45e09] transition-colors shadow-sm"
            aria-label={`Add food to ${name}`}
          >
            +
          </button>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${open ? 'rotate-0' : '-rotate-90'}`}
            fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* ── Animated content area ────────────────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: open && count > 0 ? '1fr' : '0fr',
          transition: 'grid-template-rows 200ms ease',
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          <div className="border-t border-gray-100">
            {meals.map(meal => (
              <MealEntry key={meal.id} meal={meal} onEdit={onEdit} onDelete={onDelete} onCopy={onCopy} onMove={onMove} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Edit Meal Modal ────────────────────────────────────────────────────────────

function EditMealModal({ meal, onSave, onClose }) {
  const { getToken } = useAuth()
  const [form, setForm] = useState({
    meal_name:    meal.meal_name,
    calories:     meal.calories  != null ? String(meal.calories)  : '',
    protein:      meal.protein   != null ? String(meal.protein)   : '',
    carbs:        meal.carbs     != null ? String(meal.carbs)     : '',
    fat:          meal.fat       != null ? String(meal.fat)       : '',
    fiber:        meal.fiber     != null ? String(meal.fiber)     : '',
    serving_size: meal.serving_size != null ? String(meal.serving_size) : '',
    serving_unit: meal.serving_unit ?? 'g',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  // Auto-recalculate macros when serving size / unit changes (only when original serving is known)
  useEffect(() => {
    if (!meal.serving_size || !meal.serving_unit) return
    const origGrams = toGrams(parseFloat(meal.serving_size), meal.serving_unit)
    if (origGrams <= 0) return
    const a = parseFloat(form.serving_size)
    if (isNaN(a) || a <= 0) return
    const g = toGrams(a, form.serving_unit)
    if (g <= 0) return
    setForm(f => ({
      ...f,
      calories: String(Math.round((parseFloat(meal.calories) || 0) / origGrams * g)),
      protein:  String(+(((parseFloat(meal.protein) || 0) / origGrams * g)).toFixed(1)),
      carbs:    String(+(((parseFloat(meal.carbs)   || 0) / origGrams * g)).toFixed(1)),
      fat:      String(+(((parseFloat(meal.fat)     || 0) / origGrams * g)).toFixed(1)),
      fiber:    meal.fiber != null
        ? String(+(((parseFloat(meal.fiber) || 0) / origGrams * g)).toFixed(1))
        : f.fiber,
    }))
  }, [form.serving_size, form.serving_unit]) // eslint-disable-line react-hooks/exhaustive-deps

  function set(e) { setForm(f => ({ ...f, [e.target.name]: e.target.value })) }

  function handleEditUnitChange(newUnit) {
    const a = parseFloat(form.serving_size)
    if (!isNaN(a) && a > 0) {
      const grams = toGrams(a, form.serving_unit)
      const newAmt = grams / (UNIT_TO_G[newUnit] ?? 1)
      setForm(f => ({ ...f, serving_unit: newUnit, serving_size: +(newAmt.toFixed(2)) + '' }))
    } else {
      setForm(f => ({ ...f, serving_unit: newUnit }))
    }
  }

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
          meal_name:    form.meal_name.trim(),
          calories:     form.calories     !== '' ? Number(form.calories)     : undefined,
          protein:      form.protein      !== '' ? Number(form.protein)      : undefined,
          carbs:        form.carbs        !== '' ? Number(form.carbs)        : undefined,
          fat:          form.fat          !== '' ? Number(form.fat)          : undefined,
          fiber:        form.fiber        !== '' ? Number(form.fiber)        : undefined,
          serving_size: form.serving_size !== '' ? Number(form.serving_size) : undefined,
          serving_unit: form.serving_unit || undefined,
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

        {/* Serving size + unit — updates macros automatically */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Serving</label>
          <div className="flex gap-2">
            <input type="number" name="serving_size" value={form.serving_size} onChange={set} min="0.01" step="any"
              placeholder="100"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
            <select value={form.serving_unit} onChange={e => handleEditUnitChange(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
              {SERVING_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          {meal.serving_size && (
            <p className="text-[10px] text-gray-400 mt-0.5">Changing serving recalculates macros</p>
          )}
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

function CopyMealModal({ meal, mode = 'copy', onConfirm, onClose }) {
  const todayStr = toDateStr(new Date())
  const maxStr   = toDateStr((() => { const d = new Date(); d.setDate(d.getDate() + 7); return d })())
  const minStr   = toDateStr((() => { const d = new Date(); d.setDate(d.getDate() - 90); return d })())
  const currentDate = meal.log_date || (meal.logged_at ? meal.logged_at.slice(0, 10) : todayStr)
  const [date, setDate] = useState(mode === 'move' ? currentDate : todayStr)
  const [slot, setSlot] = useState(
    SLOT_OPTIONS.find(o => o.value === meal.meal_slot) ? meal.meal_slot : SLOT_OPTIONS[0].value
  )
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)
  const isMove = mode === 'move'

  async function handleConfirm() {
    setSaving(true)
    setError(null)
    try { await onConfirm(meal.id, date, slot); onClose() }
    catch (err) { setError(err.message); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-xl space-y-3" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-gray-900">{isMove ? 'Move Meal' : 'Copy Meal'}</h3>
        <p className="text-xs text-gray-500">{meal.meal_name}</p>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
          <input type="date" value={date} min={minStr} max={maxStr}
            onChange={e => setDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Meal slot</label>
          <select value={slot} onChange={e => setSlot(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
            {SLOT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex gap-2">
          <button onClick={handleConfirm} disabled={saving}
            className="flex-1 bg-[#E8670A] text-white py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {saving ? 'Saving...' : isMove ? 'Move' : 'Copy'}
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

// ── Copy Day Modal ─────────────────────────────────────────────────────────────

function CopyDayModal({ selectedDate, getToken, onClose, onSuccess }) {
  const curDate  = toDateStr(selectedDate)
  const todayStr = toDateStr(new Date())
  const maxStr   = toDateStr((() => { const d = new Date(); d.setDate(d.getDate() + 7); return d })())

  const [direction, setDirection] = useState('push') // push: cur→other | pull: other→cur
  const [otherDate, setOtherDate] = useState(todayStr === curDate
    ? toDateStr((() => { const d = new Date(); d.setDate(d.getDate() - 1); return d })())
    : todayStr)
  const [step,     setStep]     = useState('pick')   // 'pick' | 'conflict'
  const [conflict, setConflict] = useState(null)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState(null)

  const fromDate = direction === 'push' ? curDate   : otherDate
  const toDate   = direction === 'push' ? otherDate : curDate
  const sameDate = fromDate === toDate

  async function doCopy(mode) {
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const body  = { from_date: fromDate, to_date: toDate }
      if (mode) body.mode = mode
      const res = await fetch(`${API_URL}/api/meals/copy-day`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 409) {
        const data = await res.json()
        setConflict(data); setStep('conflict')
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Failed to copy. Please try again.')
        return
      }
      const data = await res.json()
      onSuccess(toDate, data.copied)
    } catch { setError('Failed to copy. Please try again.') }
    finally  { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">Copy Day</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">

          {step === 'pick' && (
            <>
              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Direction</p>
                {[
                  { val: 'push', title: 'Copy this day to another date', sub: `${curDate} → another date` },
                  { val: 'pull', title: 'Copy another date into this day', sub: `another date → ${curDate}` },
                ].map(opt => (
                  <label key={opt.val}
                    className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
                      direction === opt.val ? 'border-[#E8670A] bg-orange-50' : 'border-gray-200 hover:border-gray-300'
                    }`}>
                    <input type="radio" value={opt.val} checked={direction === opt.val}
                      onChange={() => setDirection(opt.val)}
                      className="mt-0.5 accent-[#E8670A] shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{opt.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{opt.sub}</p>
                    </div>
                  </label>
                ))}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {direction === 'push' ? 'Copy to:' : 'Copy from:'}
                </label>
                <input type="date" value={otherDate} max={maxStr}
                  onChange={e => setOtherDate(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]" />
              </div>

              {sameDate && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Source and destination must be different dates.
                </p>
              )}
              {error && <p className="text-xs text-red-500">{error}</p>}

              <div className="flex gap-2">
                <button onClick={() => doCopy(null)} disabled={saving || sameDate}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                  {saving ? 'Copying…' : 'Copy Day'}
                </button>
                <button onClick={onClose}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium text-gray-500 border border-gray-200 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
              </div>
            </>
          )}

          {step === 'conflict' && (
            <>
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                <p className="text-sm font-semibold text-amber-900">
                  {toDate} already has {conflict?.target_count} meal{conflict?.target_count !== 1 ? 's' : ''}.
                </p>
                <p className="text-xs text-amber-700 mt-1">How would you like to proceed?</p>
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <div className="space-y-2">
                <button onClick={() => doCopy('add')} disabled={saving}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                  {saving ? 'Copying…' : 'Add to existing'}
                </button>
                <button onClick={() => doCopy('replace')} disabled={saving}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors">
                  {saving ? 'Replacing…' : 'Replace existing'}
                </button>
                <button onClick={onClose} className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
                  Cancel
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  )
}

// ── Copy Slot Modal ────────────────────────────────────────────────────────────

const COPY_SLOT_OPTIONS = [
  { value: 'Breakfast', label: 'Breakfast' },
  { value: 'Lunch',     label: 'Lunch' },
  { value: 'Dinner',    label: 'Dinner' },
  { value: 'Snack',     label: 'Snack' },
  { value: 'AM Snack',  label: 'Morning Snack' },
  { value: 'PM Snack',  label: 'Afternoon Snack' },
]

function CopySlotModal({ sourceDate, sourceSlot, getToken, onClose, onSuccess }) {
  const todayStr = toDateStr(new Date())
  const minStr   = toDateStr((() => { const d = new Date(); d.setDate(d.getDate() - 90); return d })())
  const maxStr   = toDateStr((() => { const d = new Date(); d.setDate(d.getDate() + 7); return d })())

  const defaultToDate = todayStr === sourceDate
    ? toDateStr((() => { const d = new Date(); d.setDate(d.getDate() - 1); return d })())
    : todayStr

  const [toDate,   setToDate]   = useState(defaultToDate)
  const [toSlot,   setToSlot]   = useState(sourceSlot)
  const [step,     setStep]     = useState('pick')
  const [conflict, setConflict] = useState(null)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState(null)

  const sameSlot = sourceDate === toDate && sourceSlot === toSlot

  async function doCopy(mode) {
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const body  = { from_date: sourceDate, from_slot: sourceSlot, to_date: toDate, to_slot: toSlot }
      if (mode) body.mode = mode
      const res = await fetch(`${API_URL}/api/meals/copy-meal`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 409) {
        const data = await res.json()
        setConflict(data); setStep('conflict')
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Failed to copy. Please try again.')
        return
      }
      const data = await res.json()
      onSuccess(toDate, toSlot, data.copied)
    } catch { setError('Failed to copy. Please try again.') }
    finally  { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Copy Meal</h3>
            <p className="text-xs text-gray-400 mt-0.5">{sourceSlot} · {sourceDate}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">

          {step === 'pick' && (
            <>
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Copy to</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Date</label>
                      <input type="date" value={toDate} min={minStr} max={maxStr}
                        onChange={e => setToDate(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Meal</label>
                      <select value={toSlot} onChange={e => setToSlot(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]/30 focus:border-[#E8670A]">
                        {COPY_SLOT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {sameSlot && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Source and destination must be different.
                </p>
              )}
              {error && <p className="text-xs text-red-500">{error}</p>}

              <div className="flex gap-2">
                <button onClick={() => doCopy(null)} disabled={saving || sameSlot}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                  {saving ? 'Copying…' : 'Copy Meal'}
                </button>
                <button onClick={onClose}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium text-gray-500 border border-gray-200 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
              </div>
            </>
          )}

          {step === 'conflict' && (
            <>
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                <p className="text-sm font-semibold text-amber-900">
                  {toSlot} on {toDate} already has {conflict?.target_count} item{conflict?.target_count !== 1 ? 's' : ''}.
                </p>
                <p className="text-xs text-amber-700 mt-1">How would you like to proceed?</p>
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <div className="space-y-2">
                <button onClick={() => doCopy('add')} disabled={saving}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold bg-[#E8670A] text-white hover:bg-[#c45e09] disabled:opacity-50 transition-colors">
                  {saving ? 'Copying…' : 'Add to existing'}
                </button>
                <button onClick={() => doCopy('replace')} disabled={saving}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors">
                  {saving ? 'Replacing…' : 'Replace existing'}
                </button>
                <button onClick={onClose} className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
                  Cancel
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  )
}

// ── Photo Logger (auto-save) ───────────────────────────────────────────────────

function PhotoLogger({ slotName, onSaved, logDate, initialFile = null }) {
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

  // Auto-load file passed from the drawer (mobile direct-open flow)
  useEffect(() => {
    if (initialFile) handleFile(initialFile)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
      if (!aRes.ok) throw new Error(
        aRes.status === 400
          ? 'Photo analysis failed. Try another photo or describe the meal below.'
          : `Analysis failed (${aRes.status})`
      )
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

function recentToFoodItem(recent) {
  const servingSize = parseFloat(recent.serving_size) || 100
  const servingUnit = recent.serving_unit || 'g'
  const grams  = toGrams(servingSize, servingUnit)
  const factor = grams > 0 ? (100 / grams) : 1
  return {
    id:           `recent_${recent.meal_name}`,
    name:         recent.meal_name,
    calories:     Math.round((Number(recent.calories) || 0) * factor),
    protein_g:    +((Number(recent.protein) || 0) * factor).toFixed(1),
    carbs_g:      +((Number(recent.carbs)   || 0) * factor).toFixed(1),
    fat_g:        +((Number(recent.fat)     || 0) * factor).toFixed(1),
    fiber_g:      recent.fiber ? +((Number(recent.fiber) || 0) * factor).toFixed(1) : null,
    _source:      recent.source_type || 'logged',
    source_label: recent.source_label || 'Previously logged',
    is_verified:  !!recent.is_verified,
    _defaultServingSize: servingSize,
    _defaultServingUnit: servingUnit,
  }
}

function SearchLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()
  const debounceRef  = useRef(null)
  const [query,        setQuery]        = useState('')
  const [results,      setResults]      = useState([])
  const [searching,    setSearching]    = useState(false)
  const [selected,     setSelected]     = useState(null)
  const [amount,       setAmount]       = useState('100')
  const [unit,         setUnit]         = useState('g')
  const [qty,          setQty]          = useState('1')
  const [saving,       setSaving]       = useState(false)
  const [saved,        setSaved]        = useState(false)
  const [error,        setError]        = useState(null)
  const [recentFoods,  setRecentFoods]  = useState([])
  const [recentLoading, setRecentLoading] = useState(true)

  useEffect(() => {
    async function loadRecent() {
      try {
        const token = await getToken()
        const res = await fetch(
          `${API_URL}/api/meals/recent?slot=${encodeURIComponent(slotName)}&limit=5`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (res.ok) setRecentFoods(await res.json())
      } catch {} finally { setRecentLoading(false) }
    }
    loadRecent()
  }, [slotName, getToken])

  function handleSelectRecent(recent) {
    const food = recentToFoodItem(recent)
    setSelected(food)
    setAmount(String(food._defaultServingSize))
    setUnit(food._defaultServingUnit)
    setQty('1')
    setResults([])
    setQuery('')
  }

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

  async function save() {
    if (!selected) return
    setSaving(true); setError(null)
    try {
      const a = parseFloat(amount)
      if (isNaN(a) || a <= 0) throw new Error('Enter a valid amount')
      const q = Math.max(parseFloat(qty) || 1, 0.01)
      const g = toGrams(a, unit) * q
      const macros = calcMacros(selected, g)
      const token  = await getToken()
      const micronutrients = scaledMicronutrients(selected, g)
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
          serving_size: +(a * q).toFixed(2),
          serving_unit: unit,
          source_type: selected._source,
          source_label: selected.source_label,
          is_verified: !!selected.is_verified,
          micronutrients,
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      const meal = await res.json()
      setSaved(true)
      onSaved(meal)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  const grams = toGrams(parseFloat(amount) || 0, unit)
  const q = Math.max(parseFloat(qty) || 1, 0.01)
  const preview = selected && grams > 0 ? calcMacros(selected, grams * q) : null

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
        <button onClick={() => { setQuery(''); setResults([]); setSelected(null); setAmount('100'); setUnit('g'); setQty('1'); setSaved(false) }}
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

      {/* Recent foods — show when no query typed yet and nothing selected */}
      {!query && !selected && !recentLoading && recentFoods.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Recent</p>
          <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 bg-white">
            {recentFoods.map((recent, i) => (
              <button key={i} onClick={() => handleSelectRecent(recent)}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-gray-900 leading-snug">{recent.meal_name}</p>
                  <span className="text-xs text-gray-400 shrink-0">
                    {recent.calories != null ? `${Math.round(recent.calories)} cal` : ''}
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {recent.serving_size
                    ? `${recent.serving_size}${recent.serving_unit ?? 'g'}`
                    : '100g'}
                  {recent.protein != null ? ` · ${Number(recent.protein).toFixed(0)}g P` : ''}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}

      {results.length > 0 && !selected && (
        <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-60 overflow-y-auto bg-white">
          {results.map((food, i) => (
            <button key={food.id ?? i} onClick={() => { setSelected(food); setResults([]); setQty('1') }}
              className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-gray-900 leading-snug">{food.name}</p>
                <FoodSourceBadge food={food} className="mt-0.5" />
              </div>
              <p className="text-xs text-gray-500">{Math.round(food.calories)} cal · {(food.protein_g ?? 0).toFixed(1)}g P per 100g</p>
            </button>
          ))}
        </div>
      )}
      {selected && (
        <div className="border border-gray-200 rounded-xl p-4 bg-white space-y-3">
          <div className="flex justify-between items-start gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-gray-900 leading-snug">{selected.name}</p>
                <FoodSourceBadge food={selected} />
              </div>
            </div>
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
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Servings</label>
            <input type="number" value={qty} onChange={e => setQty(e.target.value)}
              min="0.1" step="0.1" placeholder="1"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
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
          <MicronutrientGrid food={selected} grams={grams * q} />
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

const EMPTY_MANUAL = {
  meal_name: '', calories: '', protein_g: '', carbs_g: '', fat_g: '', fiber_g: '',
  serving_amt: '1', serving_unit: 'item', servings: '1',
}

function ManualLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()
  const [form,           setForm]           = useState(EMPTY_MANUAL)
  const [saving,         setSaving]         = useState(false)
  const [saved,          setSaved]          = useState(false)
  const [saveToMyFoods,  setSaveToMyFoods]  = useState(false)
  const [myFoodsSaved,   setMyFoodsSaved]   = useState(false)
  const [error,          setError]          = useState(null)

  function set(e) { setForm(f => ({ ...f, [e.target.name]: e.target.value })) }

  const servings  = Math.max(parseFloat(form.servings)  || 1, 0.01)
  const perCal    = parseFloat(form.calories)  || 0
  const perProt   = parseFloat(form.protein_g) || 0
  const perCarbs  = parseFloat(form.carbs_g)   || 0
  const perFat    = parseFloat(form.fat_g)     || 0
  const perFiber  = parseFloat(form.fiber_g)   || 0

  const totalCal   = Math.round(perCal   * servings)
  const totalProt  = +((perProt  * servings).toFixed(1))
  const totalCarbs = +((perCarbs * servings).toFixed(1))
  const totalFat   = +((perFat   * servings).toFixed(1))
  const totalFiber = +((perFiber * servings).toFixed(1))

  const showPreview = servings !== 1 && form.calories !== ''

  const inputCls = 'w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]'

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
          calories:  form.calories  !== '' ? totalCal   : null,
          protein_g: form.protein_g !== '' ? totalProt  : null,
          carbs_g:   form.carbs_g   !== '' ? totalCarbs : null,
          fat_g:     form.fat_g     !== '' ? totalFat   : null,
          fiber_g:   form.fiber_g   !== '' ? totalFiber : null,
          meal_slot: slotName,
          log_date:  logDate,
          serving_size: parseFloat(form.serving_amt) || 1,
          serving_unit: form.serving_unit,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      const meal = await res.json()
      // Best-effort: save to My Foods if checkbox checked
      if (saveToMyFoods) {
        try {
          const cfRes = await fetch(`${API_URL}/api/custom-foods`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              food_name:            form.meal_name.trim(),
              calories_per_serving: form.calories  !== '' ? perCal   : null,
              protein:              form.protein_g !== '' ? perProt  : null,
              carbs:                form.carbs_g   !== '' ? perCarbs : null,
              fat:                  form.fat_g     !== '' ? perFat   : null,
              fiber:                form.fiber_g   !== '' ? perFiber : null,
              serving_size:         parseFloat(form.serving_amt) || 1,
              serving_unit:         form.serving_unit,
              is_global:            false,
            }),
          })
          if (cfRes.ok) setMyFoodsSaved(true)
        } catch {} // best-effort — swallow errors
      }
      setSaved(true); onSaved(meal)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  if (saved) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">✓</div>
          <div>
            <p className="text-sm font-semibold text-gray-900">{form.meal_name}</p>
            {myFoodsSaved && <p className="text-xs text-[#E8670A] mt-0.5">Saved to My Foods</p>}
          </div>
        </div>
        <button onClick={() => { setForm(EMPTY_MANUAL); setSaved(false); setSaveToMyFoods(false); setMyFoodsSaved(false) }}
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
          placeholder="e.g. Hard boiled egg"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
      </div>

      {/* Serving size + servings */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Size</label>
          <input type="number" name="serving_amt" value={form.serving_amt} onChange={set}
            min="0.01" step="any" placeholder="1" className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
          <select name="serving_unit" value={form.serving_unit} onChange={set}
            className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
            {MANUAL_SERVING_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Servings</label>
          <input type="number" name="servings" value={form.servings} onChange={set}
            min="0.1" step="0.1" placeholder="1" className={inputCls} />
        </div>
      </div>
      <p className="text-[10px] text-gray-400 -mt-1">Enter macros per serving. Total = macros × servings.</p>

      <div className="grid grid-cols-2 gap-2">
        {[['Calories', 'calories', '78'], ['Protein (g)', 'protein_g', '6'], ['Carbs (g)', 'carbs_g', '1'], ['Fat (g)', 'fat_g', '5'], ['Fiber (g)', 'fiber_g', '0']].map(([lbl, nm, ph]) => (
          <div key={nm}>
            <label className="block text-xs font-medium text-gray-600 mb-1">{lbl}</label>
            <input type="number" name={nm} value={form[nm]} onChange={set} min="0" placeholder={ph}
              className={inputCls} />
          </div>
        ))}
      </div>

      {/* Live total preview when servings ≠ 1 */}
      {showPreview && (
        <div className="bg-orange-50 border border-orange-100 rounded-lg p-3">
          <p className="text-[10px] text-gray-400 mb-1.5">Total for {form.servings} serving{parseFloat(form.servings) !== 1 ? 's' : ''}</p>
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            {[['Cal', totalCal, 'text-[#E8670A]'], ['P', `${totalProt}g`, 'text-pink-500'], ['C', `${totalCarbs}g`, 'text-blue-500'], ['F', `${totalFat}g`, 'text-green-500']].map(([l, v, c]) => (
              <div key={l} className="bg-white rounded-lg py-1.5">
                <p className={`font-bold text-sm ${c}`}>{v}</p>
                <p className="text-gray-400">{l}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input type="checkbox" checked={saveToMyFoods} onChange={e => setSaveToMyFoods(e.target.checked)}
          className="w-4 h-4 rounded accent-[#E8670A]" />
        <span className="text-xs text-gray-600">Save to My Foods</span>
      </label>

      {error && <p className="text-sm text-red-500">{error}</p>}
      <button type="submit" disabled={saving || !form.meal_name.trim()}
        className="w-full bg-[#E8670A] text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
        {saving ? 'Saving…' : 'Log It'}
      </button>
    </form>
  )
}

// ── Barcode Logger ─────────────────────────────────────────────────────────────

// Extract gram weight from strings like "30g", "2 cookies (30g)", "1/4 cup (28 g)"
function parseServingGrams(s) {
  if (!s) return null
  const m = s.match(/\b(\d+(?:\.\d+)?)\s*g(?:\b|$|\))/i)
  return m ? parseFloat(m[1]) : null
}

// Normalise food macros to per-100 g so the unit selector works consistently.
// Returns { base (per-100g macros), defaultGrams }.
function normaliseFoodTo100g(food) {
  if (!food.is_per_serving) return { base: food, defaultGrams: 100 }
  const sg = parseServingGrams(food.serving_size)
  if (!sg) return { base: food, defaultGrams: 100 } // can't parse — treat as per-100g
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

function BarcodeLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()
  const [scanning, setScanning] = useState(true)
  const [loading,  setLoading]  = useState(false)
  const [food,     setFood]     = useState(null)   // raw food from API
  const [base,     setBase]     = useState(null)   // per-100g normalised macros
  const [amount,   setAmount]   = useState('100')
  const [unit,     setUnit]     = useState('g')
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [error,    setError]    = useState(null)

  function handleUnitChange(newUnit) {
    const g = toGrams(parseFloat(amount) || 0, unit)
    setAmount(+(g / (UNIT_TO_G[newUnit] ?? 1)).toFixed(2) + '')
    setUnit(newUnit)
  }

  async function handleScan(barcode) {
    setScanning(false)
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/foods/barcode/${barcode}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}))
        throw new Error(msg || 'Product not found. Try logging manually.')
      }
      const f = await res.json()
      const { base: b, defaultGrams } = normaliseFoodTo100g(f)
      setFood(f)
      setBase(b)
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
      fiber:    base.fiber_g != null ? +((base.fiber_g * r).toFixed(1)) : null,
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
      const res = await fetch(`${API_URL}/api/meals/manual`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meal_name: food.brand ? `${food.name} (${food.brand})` : food.name,
          calories:  preview.calories,
          protein_g: preview.protein,
          carbs_g:   preview.carbs,
          fat_g:     preview.fat,
          fiber_g:   preview.fiber,
          meal_slot: slotName,
          log_date:  logDate,
          serving_size: parseFloat(amount) || null,
          serving_unit: unit,
          source_type: food._source,
          source_label: food.source_label,
          is_verified: !!food.is_verified,
          micronutrients,
        }),
      })
      if (!res.ok) throw new Error('Save failed')
      const meal = await res.json()
      setSaved(true)
      onSaved(meal)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  function reset() {
    setScanning(false); setFood(null); setBase(null)
    setAmount('100'); setUnit('g'); setSaved(false); setError(null)
  }

  if (saved) return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
        <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">✓</div>
        <p className="text-sm font-semibold text-gray-900">{food?.name}</p>
      </div>
      <button onClick={reset}
        className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
        Scan Another
      </button>
    </div>
  )

  if (scanning) {
    return (
      <BarcodeScannerWidget
        onScan={handleScan}
        onCancel={() => setScanning(false)}
      />
    )
  }

  const preview = calcPreview()

  return (
    <div className="space-y-4">
      {!food && !loading && (
        <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center space-y-3">
          <p className="text-3xl">🏷️</p>
          <p className="text-sm font-medium text-gray-700">Scan a product barcode</p>
          <p className="text-xs text-gray-400">Point your camera at any food product barcode</p>
          <button
            onClick={() => { setError(null); setScanning(true) }}
            className="bg-[#E8670A] text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors"
          >
            Open Camera
          </button>
          {error && <p className="text-sm text-red-500 mt-1">{error}</p>}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-8">
          <span className="animate-spin inline-block w-5 h-5 border-2 border-[#E8670A] border-t-transparent rounded-full" />
          <span className="text-sm text-gray-500">Looking up product…</span>
        </div>
      )}

      {food && base && (
        <div className="border border-gray-200 rounded-xl p-4 bg-white space-y-3">
          <div className="flex justify-between items-start">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-gray-900 leading-snug">{food.name}</p>
                <FoodSourceBadge food={food} />
              </div>
              {food.brand && <p className="text-xs text-gray-400">{food.brand}</p>}
              <p className="text-xs text-gray-500 mt-0.5">{food.serving_size}</p>
            </div>
            <button onClick={reset} className="text-xs text-gray-400 hover:text-gray-600 shrink-0 ml-2">
              Scan Again
            </button>
          </div>

          {/* Portion + unit selector */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Portion</label>
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

          {/* Macro preview chips */}
          {preview && (
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              {[['Cal', preview.calories, 'text-[#E8670A]'], ['P', `${preview.protein}g`, 'text-pink-500'], ['C', `${preview.carbs}g`, 'text-blue-500'], ['F', `${preview.fat}g`, 'text-green-500']].map(([l, v, c]) => (
                <div key={l} className="bg-gray-50 rounded-lg py-2">
                  <p className={`font-bold text-sm ${c}`}>{v}</p>
                  <p className="text-gray-400">{l}</p>
                </div>
              ))}
            </div>
          )}
          <MicronutrientGrid food={base} grams={toGrams(parseFloat(amount) || 0, unit)} />

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

// ── My Foods & Recipes Logger ──────────────────────────────────────────────────

const EMPTY_ING = { food_name: '', calories: '', protein: '', carbs: '', fat: '', fiber: '', amount: '', unit: '' }

function RecipesLogger({ slotName, onSaved, logDate }) {
  const { getToken } = useAuth()

  // My Foods state
  const [myFoods,  setMyFoods]  = useState([])
  const [loading,  setLoading]  = useState(true)
  const [selected, setSelected] = useState(null)
  const [qty,      setQty]      = useState('1')
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [error,    setError]    = useState(null)

  // Recipes list + log state
  const [recipes,      setRecipes]      = useState([])
  const [recipeView,   setRecipeView]   = useState(null)  // null | 'create' | 'log'
  const [activeRecipe, setActiveRecipe] = useState(null)
  const [rQty,         setRQty]         = useState('1')
  const [rSaving,      setRSaving]      = useState(false)
  const [rSaved,       setRSaved]       = useState(false)
  const [rError,       setRError]       = useState(null)

  // Recipe delete state
  const [deletingId,    setDeletingId]    = useState(null)   // recipe.id pending confirm
  const [deleteWorking, setDeleteWorking] = useState(false)
  const [deleteError,   setDeleteError]   = useState(null)

  // Create recipe state
  const [cName,     setCName]     = useState('')
  const [cServings, setCServings] = useState('4')
  const [cIngs,     setCIngs]     = useState([])
  const [cDraft,    setCDraft]    = useState(EMPTY_ING)
  const [cSaving,   setCSaving]   = useState(false)
  const [cError,    setCError]    = useState(null)

  // Ingredient source mode: 'search' | 'myfoods' | 'manual'
  const [cIngMode,       setCIngMode]       = useState('search')
  const [cQuery,         setCQuery]         = useState('')
  const [cSearchResults, setCSearchResults] = useState([])
  const [cSearching,     setCSearching]     = useState(false)
  const [cIngFood,       setCIngFood]       = useState(null)   // selected DB food (search)
  const [cIngAmount,     setCIngAmount]     = useState('100')
  const [cIngUnit,       setCIngUnit]       = useState('g')
  const [cMyFoodSel,     setCMyFoodSel]     = useState(null)   // selected My Food
  const [cMyFoodQty,     setCMyFoodQty]     = useState('1')
  const cDebounceRef = useRef(null)

  useEffect(() => {
    async function load() {
      try {
        const token = await getToken()
        const [cfRes, rRes] = await Promise.all([
          fetch(`${API_URL}/api/custom-foods`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_URL}/api/recipes`,      { headers: { Authorization: `Bearer ${token}` } }),
        ])
        if (cfRes.ok) {
          const all = await cfRes.json()
          setMyFoods(all.filter(f => !f.is_global))
        }
        if (rRes.ok) setRecipes(await rRes.json())
      } finally { setLoading(false) }
    }
    load()
  }, [getToken])

  // ── My Foods helpers ───────────────────────────────────────────────────────
  const q = Math.max(parseFloat(qty) || 1, 0.01)
  const preview = selected ? {
    calories: Math.round((parseFloat(selected.calories_per_serving) || 0) * q),
    protein:  +((parseFloat(selected.protein) || 0) * q).toFixed(1),
    carbs:    +((parseFloat(selected.carbs)   || 0) * q).toFixed(1),
    fat:      +((parseFloat(selected.fat)     || 0) * q).toFixed(1),
    fiber:    selected.fiber ? +((parseFloat(selected.fiber) || 0) * q).toFixed(1) : null,
  } : null

  async function save() {
    if (!selected || !preview) return
    setSaving(true); setError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/meals/manual`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meal_name:    selected.food_name,
          calories:     preview.calories,
          protein_g:    preview.protein,
          carbs_g:      preview.carbs,
          fat_g:        preview.fat,
          fiber_g:      preview.fiber,
          meal_slot:    slotName,
          log_date:     logDate,
          serving_size: +((parseFloat(selected.serving_size) || 1) * q).toFixed(2),
          serving_unit: selected.serving_unit,
          source_type:  'custom',
          source_label: 'My food',
        }),
      })
      if (!res.ok) throw new Error('Failed to save')
      const meal = await res.json()
      setSaved(true); onSaved(meal)
    } catch (err) { setError(err.message) } finally { setSaving(false) }
  }

  // ── Recipe log helpers ─────────────────────────────────────────────────────
  const rSrv = activeRecipe ? Math.max(parseFloat(activeRecipe.servings) || 1, 0.01) : 1
  const rq   = Math.max(parseFloat(rQty) || 1, 0.01)
  const rPreview = activeRecipe ? {
    calories: Math.round((parseFloat(activeRecipe.calories) || 0) / rSrv * rq),
    protein:  +((parseFloat(activeRecipe.protein) || 0) / rSrv * rq).toFixed(1),
    carbs:    +((parseFloat(activeRecipe.carbs)   || 0) / rSrv * rq).toFixed(1),
    fat:      +((parseFloat(activeRecipe.fat)     || 0) / rSrv * rq).toFixed(1),
    fiber:    activeRecipe.fiber != null ? +((parseFloat(activeRecipe.fiber) || 0) / rSrv * rq).toFixed(1) : null,
  } : null

  async function logRecipe() {
    if (!activeRecipe) return
    setRSaving(true); setRError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/recipes/${activeRecipe.id}/log`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meal_slot: slotName, log_date: logDate, servings: rq }),
      })
      if (!res.ok) throw new Error('Failed to log recipe')
      const meal = await res.json()
      setRSaved(true); onSaved(meal)
    } catch (err) { setRError(err.message) } finally { setRSaving(false) }
  }

  async function deleteRecipe(id) {
    setDeleteWorking(true); setDeleteError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/recipes/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Failed to delete recipe')
      setRecipes(prev => prev.filter(r => r.id !== id))
      setDeletingId(null)
    } catch (err) { setDeleteError(err.message) } finally { setDeleteWorking(false) }
  }

  // ── Create recipe helpers ──────────────────────────────────────────────────
  const cTotals = cIngs.reduce(
    (acc, ing) => ({
      calories: acc.calories + (parseFloat(ing.calories) || 0),
      protein:  acc.protein  + (parseFloat(ing.protein)  || 0),
      carbs:    acc.carbs    + (parseFloat(ing.carbs)    || 0),
      fat:      acc.fat      + (parseFloat(ing.fat)      || 0),
      fiber:    acc.fiber    + (parseFloat(ing.fiber)    || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
  )
  const cSrv = Math.max(parseFloat(cServings) || 1, 0.01)
  const cPerSrv = {
    calories: Math.round(cTotals.calories / cSrv),
    protein:  +(cTotals.protein / cSrv).toFixed(1),
    carbs:    +(cTotals.carbs   / cSrv).toFixed(1),
    fat:      +(cTotals.fat     / cSrv).toFixed(1),
  }

  function isNegativeValue(value) {
    if (value === '' || value == null) return false
    const n = Number(value)
    return Number.isNaN(n) || n < 0
  }

  function validateIngredient({ name, amount, values = [] }) {
    if (!String(name ?? '').trim()) return 'Ingredient name required'
    const qty = Number(amount)
    if (!Number.isFinite(qty) || qty <= 0) return 'Enter a valid amount'
    if (values.some(isNegativeValue)) return 'Calories and macros cannot be negative'
    return null
  }

  function validateRecipe() {
    if (!cName.trim()) return 'Recipe name required'
    const servings = Number(cServings)
    if (!Number.isFinite(servings) || servings <= 0) return 'Enter total servings made'
    if (!cIngs.length) return 'Add at least one ingredient'
    return null
  }

  // Ingredient search helpers
  function handleCQuery(val) {
    setCQuery(val); setCIngFood(null)
    clearTimeout(cDebounceRef.current)
    if (!val.trim()) { setCSearchResults([]); return }
    cDebounceRef.current = setTimeout(() => doCIngSearch(val.trim()), 400)
  }

  async function doCIngSearch(q) {
    setCSearching(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/foods/search?q=${encodeURIComponent(q)}&limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error()
      setCSearchResults((await res.json()).filter(f => f.calories != null))
    } catch { setCSearchResults([]) } finally { setCSearching(false) }
  }

  function selectCIngFood(food) {
    setCIngFood(food); setCIngAmount('100'); setCIngUnit('g')
    setCQuery(food.name ?? food.food_name ?? ''); setCSearchResults([])
  }

  function addFromSearch() {
    if (!cIngFood) { setCError('Select a food first'); return }
    const name = cIngFood.name ?? cIngFood.food_name ?? ''
    const validation = validateIngredient({
      name,
      amount: cIngAmount,
      values: [cIngFood.calories, cIngFood.protein_g, cIngFood.carbs_g, cIngFood.fat_g, cIngFood.fiber_g],
    })
    if (validation) { setCError(validation); return }
    const g = toGrams(parseFloat(cIngAmount), cIngUnit)
    const m = calcMacros(cIngFood, g)
    setCIngs(prev => [...prev, {
      food_name: name.trim(),
      calories:  m.calories,
      protein:   m.protein,
      carbs:     m.carbs,
      fat:       m.fat,
      fiber:     m.fiber ?? '',
      amount:    parseFloat(cIngAmount) || '',
      unit:      cIngUnit,
    }])
    setCIngFood(null); setCQuery(''); setCIngAmount('100'); setCIngUnit('g')
    setCError(null)
  }

  function addFromMyFood() {
    if (!cMyFoodSel) { setCError('Select a food first'); return }
    const validation = validateIngredient({
      name: cMyFoodSel.food_name,
      amount: cMyFoodQty,
      values: [cMyFoodSel.calories_per_serving, cMyFoodSel.protein, cMyFoodSel.carbs, cMyFoodSel.fat, cMyFoodSel.fiber],
    })
    if (validation) { setCError(validation); return }
    const qty = parseFloat(cMyFoodQty)
    setCIngs(prev => [...prev, {
      food_name: cMyFoodSel.food_name.trim(),
      calories:  Math.round((parseFloat(cMyFoodSel.calories_per_serving) || 0) * qty),
      protein:   +((parseFloat(cMyFoodSel.protein) || 0) * qty).toFixed(1),
      carbs:     +((parseFloat(cMyFoodSel.carbs)   || 0) * qty).toFixed(1),
      fat:       +((parseFloat(cMyFoodSel.fat)     || 0) * qty).toFixed(1),
      fiber:     cMyFoodSel.fiber ? +((parseFloat(cMyFoodSel.fiber) || 0) * qty).toFixed(1) : '',
      amount:    +((parseFloat(cMyFoodSel.serving_size) || 1) * qty).toFixed(2),
      unit:      cMyFoodSel.serving_unit || '',
    }])
    setCMyFoodSel(null); setCMyFoodQty('1')
    setCError(null)
  }

  function addIngredient() {
    const validation = validateIngredient({
      name: cDraft.food_name,
      amount: cDraft.amount,
      values: [cDraft.calories, cDraft.protein, cDraft.carbs, cDraft.fat, cDraft.fiber],
    })
    if (validation) { setCError(validation); return }
    setCIngs(prev => [...prev, { ...cDraft, food_name: cDraft.food_name.trim() }])
    setCDraft(EMPTY_ING)
    setCError(null)
  }

  async function createRecipe() {
    if (cSaving) return
    const validation = validateRecipe()
    if (validation) { setCError(validation); return }
    setCSaving(true); setCError(null)
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/recipes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cName.trim(), servings: parseFloat(cServings), ingredients: cIngs }),
      })
      if (!res.ok) throw new Error('Failed to save recipe')
      const recipe = await res.json()
      setRecipes(prev => [recipe, ...prev])
      setRecipeView(null)
      setCName(''); setCServings('4'); setCIngs([])
      setCError(null)
    } catch (err) { setCError(err.message) } finally { setCSaving(false) }
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  // My Foods success
  if (saved && selected) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">✓</div>
          <div>
            <p className="text-sm font-semibold text-gray-900">{selected.food_name}</p>
            <p className="text-xs text-gray-500">{preview?.calories} cal</p>
          </div>
        </div>
        <button onClick={() => { setSelected(null); setQty('1'); setSaved(false) }}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
          Log Another
        </button>
      </div>
    )
  }

  // Recipe success
  if (rSaved && activeRecipe) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
          <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">✓</div>
          <div>
            <p className="text-sm font-semibold text-gray-900">{activeRecipe.name}</p>
            <p className="text-xs text-gray-500">{rPreview?.calories} cal</p>
          </div>
        </div>
        <button onClick={() => { setActiveRecipe(null); setRQty('1'); setRSaved(false); setRecipeView(null) }}
          className="w-full py-2.5 rounded-xl text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
          Log Another
        </button>
      </div>
    )
  }

  if (loading) return <p className="text-sm text-gray-400 text-center py-6">Loading…</p>

  // My Foods detail / log
  if (selected) {
    return (
      <div className="border border-gray-200 rounded-xl p-4 bg-white space-y-3">
        <div className="flex justify-between items-start gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 leading-snug">{selected.food_name}</p>
            {selected.serving_size && (
              <p className="text-xs text-gray-400 mt-0.5">
                {selected.serving_size} {selected.serving_unit} / serving
              </p>
            )}
          </div>
          <button onClick={() => setSelected(null)} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Change</button>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Servings</label>
          <input type="number" value={qty} onChange={e => setQty(e.target.value)}
            min="0.1" step="0.1" placeholder="1"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
        </div>
        {preview && (
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            {[['Cal', preview.calories, 'text-[#E8670A]'], ['P', `${preview.protein}g`, 'text-pink-500'], ['C', `${preview.carbs}g`, 'text-blue-500'], ['F', `${preview.fat}g`, 'text-green-500']].map(([l, v, c]) => (
              <div key={l} className="bg-gray-50 rounded-lg py-2">
                <p className={`font-bold text-sm ${c}`}>{v}</p>
                <p className="text-gray-400">{l}</p>
              </div>
            ))}
          </div>
        )}
        {preview?.fiber != null && <p className="text-xs text-gray-400">Fiber: {preview.fiber}g</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button onClick={save} disabled={saving || !preview}
          className="w-full bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Log It'}
        </button>
      </div>
    )
  }

  // Recipe log panel
  if (recipeView === 'log' && activeRecipe) {
    return (
      <div className="border border-gray-200 rounded-xl p-4 bg-white space-y-3">
        <div className="flex justify-between items-start gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 leading-snug">{activeRecipe.name}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {Math.round((parseFloat(activeRecipe.calories) || 0) / rSrv)} cal/serving · {activeRecipe.servings} servings total
            </p>
          </div>
          <button onClick={() => { setRecipeView(null); setActiveRecipe(null); setRQty('1') }}
            className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Change</button>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Servings eaten</label>
          <input type="number" value={rQty} onChange={e => setRQty(e.target.value)}
            min="0.1" step="0.1" placeholder="1"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
        </div>
        {rPreview && (
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            {[['Cal', rPreview.calories, 'text-[#E8670A]'], ['P', `${rPreview.protein}g`, 'text-pink-500'], ['C', `${rPreview.carbs}g`, 'text-blue-500'], ['F', `${rPreview.fat}g`, 'text-green-500']].map(([l, v, c]) => (
              <div key={l} className="bg-gray-50 rounded-lg py-2">
                <p className={`font-bold text-sm ${c}`}>{v}</p>
                <p className="text-gray-400">{l}</p>
              </div>
            ))}
          </div>
        )}
        {rPreview?.fiber != null && <p className="text-xs text-gray-400">Fiber: {rPreview.fiber}g</p>}
        {rError && <p className="text-sm text-red-500">{rError}</p>}
        <button onClick={logRecipe} disabled={rSaving}
          className="w-full bg-[#E8670A] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
          {rSaving ? 'Saving…' : 'Log It'}
        </button>
      </div>
    )
  }

  // Create recipe form
  if (recipeView === 'create') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={() => { setRecipeView(null); setCName(''); setCServings('4'); setCIngs([]); setCError(null) }}
            className="text-sm text-gray-500 hover:text-gray-700">← Back</button>
          <p className="text-sm font-semibold text-gray-900">New Recipe</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Recipe Name</label>
            <input type="text" value={cName} onChange={e => setCName(e.target.value)}
              placeholder="e.g. Chicken Stir Fry"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Total Servings Made</label>
            <input type="number" value={cServings} onChange={e => setCServings(e.target.value)}
              min="0.5" step="0.5" placeholder="4"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
          </div>
        </div>

        {cIngs.length > 0 && (
          <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 bg-white">
            {cIngs.map((ing, i) => (
              <div key={i} className="flex items-start justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 leading-snug">{ing.food_name}</p>
                  <p className="text-xs text-gray-400">
                    {ing.calories ? `${Math.round(ing.calories)} cal` : ''}
                    {ing.protein  ? ` · ${ing.protein}g P` : ''}
                    {ing.carbs    ? ` · ${ing.carbs}g C`   : ''}
                    {ing.fat      ? ` · ${ing.fat}g F`     : ''}
                    {(ing.amount || ing.unit) ? ` · ${ing.amount}${ing.unit ? ' ' + ing.unit : ''}` : ''}
                  </p>
                </div>
                <button onClick={() => setCIngs(prev => prev.filter((_, j) => j !== i))}
                  className="text-xs text-red-400 hover:text-red-600 shrink-0 pt-0.5">Remove</button>
              </div>
            ))}
          </div>
        )}

        {cIngs.length > 0 && (
          <div className="bg-gray-50 rounded-xl p-3 space-y-1.5">
            <div className="flex justify-between text-xs text-gray-500">
              <span>Total recipe</span>
              <span>{Math.round(cTotals.calories)} cal · {cTotals.protein.toFixed(0)}g P · {cTotals.carbs.toFixed(0)}g C · {cTotals.fat.toFixed(0)}g F</span>
            </div>
            <div className="flex justify-between text-xs font-semibold text-gray-700">
              <span>Per serving ({cServings || 1})</span>
              <span>{cPerSrv.calories} cal · {cPerSrv.protein}g P · {cPerSrv.carbs}g C · {cPerSrv.fat}g F</span>
            </div>
          </div>
        )}

        <div className="border border-gray-200 rounded-xl p-4 space-y-3 bg-white">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add Ingredient</p>

          {/* Mode tabs */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 text-xs font-semibold">
            {[['search','Search'],['myfoods','My Foods'],['manual','Manual']].map(([mode, label]) => (
              <button key={mode} onClick={() => { setCIngMode(mode); setCError(null) }}
                className={`flex-1 py-2 transition-colors ${cIngMode === mode ? 'bg-[#E8670A] text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* Search mode */}
          {cIngMode === 'search' && (
            <div className="space-y-2">
              <input type="text" value={cQuery} onChange={e => handleCQuery(e.target.value)}
                placeholder="Search foods…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
              {cSearching && <p className="text-xs text-gray-400 text-center py-1">Searching…</p>}
              {cSearchResults.length > 0 && !cIngFood && (
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-40 overflow-y-auto">
                  {cSearchResults.filter(f => f.name || f.food_name).map(food => (
                    <button key={food.id} onClick={() => selectCIngFood(food)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors">
                      <p className="text-sm font-medium text-gray-900 leading-snug">{food.name ?? food.food_name}</p>
                      <p className="text-xs text-gray-400">
                        {Math.round(food.calories)} cal · {(food.protein_g ?? 0).toFixed(1)}g P per 100g
                      </p>
                    </button>
                  ))}
                </div>
              )}
              {cIngFood && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-gray-900 truncate">{cIngFood.name ?? cIngFood.food_name}</p>
                    <button onClick={() => { setCIngFood(null); setCQuery('') }} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Change</button>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="block text-xs text-gray-500 mb-0.5">Amount</label>
                      <input type="number" min="0" value={cIngAmount} onChange={e => setCIngAmount(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs text-gray-500 mb-0.5">Unit</label>
                      <select value={cIngUnit} onChange={e => setCIngUnit(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]">
                        {SERVING_UNITS.map(u => <option key={u}>{u}</option>)}
                      </select>
                    </div>
                  </div>
                  {(() => {
                    const g = toGrams(parseFloat(cIngAmount) || 0, cIngUnit)
                    if (g <= 0) return null
                    const m = calcMacros(cIngFood, g)
                    return (
                      <div className="grid grid-cols-4 gap-1 text-center text-xs">
                        {[['Cal', m.calories, 'text-[#E8670A]'], ['P', `${m.protein}g`, 'text-pink-500'], ['C', `${m.carbs}g`, 'text-blue-500'], ['F', `${m.fat}g`, 'text-green-500']].map(([l, v, c]) => (
                          <div key={l} className="bg-gray-50 rounded py-1.5">
                            <p className={`font-bold ${c}`}>{v}</p>
                            <p className="text-gray-400">{l}</p>
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                  <button onClick={addFromSearch}
                    className="w-full py-2.5 rounded-lg text-sm font-semibold border-2 border-[#E8670A] text-[#E8670A] hover:bg-[#fff7ed] transition-colors">
                    + Add Ingredient
                  </button>
                </div>
              )}
            </div>
          )}

          {/* My Foods mode */}
          {cIngMode === 'myfoods' && (
            <div className="space-y-2">
              {myFoods.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-3">No saved foods yet.</p>
              ) : cMyFoodSel ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-gray-900 truncate">{cMyFoodSel.food_name}</p>
                    <button onClick={() => setCMyFoodSel(null)} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Change</button>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-0.5">Servings</label>
                    <input type="number" min="0.1" step="0.1" value={cMyFoodQty} onChange={e => setCMyFoodQty(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
                  </div>
                  {(() => {
                    const q = Math.max(parseFloat(cMyFoodQty) || 1, 0.01)
                    return (
                      <div className="grid grid-cols-4 gap-1 text-center text-xs">
                        {[
                          ['Cal', Math.round((parseFloat(cMyFoodSel.calories_per_serving) || 0) * q), 'text-[#E8670A]'],
                          ['P',   `${+((parseFloat(cMyFoodSel.protein) || 0) * q).toFixed(1)}g`, 'text-pink-500'],
                          ['C',   `${+((parseFloat(cMyFoodSel.carbs)   || 0) * q).toFixed(1)}g`, 'text-blue-500'],
                          ['F',   `${+((parseFloat(cMyFoodSel.fat)     || 0) * q).toFixed(1)}g`, 'text-green-500'],
                        ].map(([l, v, c]) => (
                          <div key={l} className="bg-gray-50 rounded py-1.5">
                            <p className={`font-bold ${c}`}>{v}</p>
                            <p className="text-gray-400">{l}</p>
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                  <button onClick={addFromMyFood}
                    className="w-full py-2.5 rounded-lg text-sm font-semibold border-2 border-[#E8670A] text-[#E8670A] hover:bg-[#fff7ed] transition-colors">
                    + Add Ingredient
                  </button>
                </div>
              ) : (
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-48 overflow-y-auto">
                  {myFoods.map(food => (
                    <button key={food.id} onClick={() => { setCMyFoodSel(food); setCMyFoodQty('1') }}
                      className="w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors">
                      <p className="text-sm text-gray-900 leading-snug">{food.food_name}</p>
                      <p className="text-xs text-gray-400">
                        {food.calories_per_serving != null ? `${Math.round(food.calories_per_serving)} cal` : ''}
                        {food.protein != null ? ` · ${Number(food.protein).toFixed(0)}g P` : ''}
                        {food.serving_size ? ` · ${food.serving_size} ${food.serving_unit ?? ''}` : ''}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Manual mode */}
          {cIngMode === 'manual' && (
            <div className="space-y-2">
              <input type="text" value={cDraft.food_name} onChange={e => setCDraft(d => ({ ...d, food_name: e.target.value }))}
                placeholder="Food name"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
              <div className="grid grid-cols-2 gap-2">
                {[['calories','Calories'],['protein','Protein (g)'],['carbs','Carbs (g)'],['fat','Fat (g)']].map(([k, lbl]) => (
                  <div key={k}>
                    <label className="block text-xs text-gray-500 mb-0.5">{lbl}</label>
                    <input type="number" min="0" value={cDraft[k]} onChange={e => setCDraft(d => ({ ...d, [k]: e.target.value }))}
                      placeholder="0"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-0.5">Fiber (g) optional</label>
                  <input type="number" min="0" value={cDraft.fiber} onChange={e => setCDraft(d => ({ ...d, fiber: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-0.5">Amount</label>
                  <div className="flex gap-1">
                    <input type="number" min="0" value={cDraft.amount} onChange={e => setCDraft(d => ({ ...d, amount: e.target.value }))}
                      placeholder="100"
                      className="w-1/2 border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
                    <input type="text" value={cDraft.unit} onChange={e => setCDraft(d => ({ ...d, unit: e.target.value }))}
                      placeholder="g"
                      className="w-1/2 border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]" />
                  </div>
                </div>
              </div>
              <button onClick={addIngredient}
                className="w-full py-2.5 rounded-lg text-sm font-semibold border-2 border-[#E8670A] text-[#E8670A] hover:bg-[#fff7ed] transition-colors">
                + Add Ingredient
              </button>
            </div>
          )}

          {cError && <p className="text-sm text-red-500">{cError}</p>}
        </div>

        <button onClick={createRecipe} disabled={cSaving}
          className="w-full bg-[#E8670A] text-white py-3 rounded-xl text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {cSaving ? 'Saving…' : 'Save Recipe'}
        </button>
      </div>
    )
  }

  // Main list
  return (
    <div className="space-y-5">
      {/* My Foods */}
      <div>
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">My Foods</p>
        {myFoods.length === 0 ? (
          <div className="text-center py-6 border border-gray-200 rounded-xl bg-gray-50">
            <p className="text-sm text-gray-500">No saved foods yet.</p>
            <p className="text-xs text-gray-400 mt-1">Save a manual food to reuse it here.</p>
          </div>
        ) : (
          <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 bg-white">
            {myFoods.map(food => (
              <button key={food.id} onClick={() => { setSelected(food); setQty('1') }}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-gray-900 leading-snug">{food.food_name}</p>
                  <span className="text-xs font-semibold text-[#E8670A] shrink-0">
                    {food.calories_per_serving != null ? `${Math.round(food.calories_per_serving)} cal` : ''}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {food.serving_size ? `${food.serving_size} ${food.serving_unit ?? ''}` : '1 serving'}
                  {food.protein != null ? ` · ${Number(food.protein).toFixed(0)}g P` : ''}
                  {food.carbs   != null ? ` · ${Number(food.carbs).toFixed(0)}g C`   : ''}
                  {food.fat     != null ? ` · ${Number(food.fat).toFixed(0)}g F`     : ''}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Recipes */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Recipes</p>
          <button onClick={() => setRecipeView('create')}
            className="text-xs font-semibold text-[#E8670A] hover:text-[#c45e09] transition-colors">
            + Create Recipe
          </button>
        </div>
        {recipes.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-gray-200 rounded-xl">
            <p className="text-sm text-gray-500">No recipes yet.</p>
            <p className="text-xs text-gray-400 mt-1">Create a recipe to log it quickly.</p>
          </div>
        ) : (
          <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 bg-white">
            {recipes.map(recipe => {
              const srv = Math.max(parseFloat(recipe.servings) || 1, 0.01)
              const isConfirming = deletingId === recipe.id

              if (isConfirming) {
                return (
                  <div key={recipe.id} className="px-4 py-3 bg-red-50">
                    <p className="text-sm font-medium text-gray-900 mb-0.5 leading-snug">{recipe.name}</p>
                    <p className="text-xs text-gray-500 mb-3">Delete this recipe? This cannot be undone. Previously logged meals are not affected.</p>
                    {deleteError && <p className="text-xs text-red-600 mb-2">{deleteError}</p>}
                    <div className="flex gap-2">
                      <button onClick={() => { setDeletingId(null); setDeleteError(null) }}
                        disabled={deleteWorking}
                        className="flex-1 py-2 rounded-lg text-sm font-semibold border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors">
                        Cancel
                      </button>
                      <button onClick={() => deleteRecipe(recipe.id)}
                        disabled={deleteWorking}
                        className="flex-1 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors">
                        {deleteWorking ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                )
              }

              return (
                <div key={recipe.id} className="flex items-stretch divide-x divide-gray-100">
                  <button onClick={() => { setActiveRecipe(recipe); setRQty('1'); setRecipeView('log') }}
                    className="flex-1 text-left px-4 py-3 hover:bg-gray-50 transition-colors min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900 leading-snug">{recipe.name}</p>
                      <span className="text-xs font-semibold text-[#E8670A] shrink-0">
                        {recipe.calories != null ? `${Math.round(recipe.calories / srv)} cal/srv` : ''}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {recipe.servings} servings
                      {recipe.protein != null ? ` · ${(recipe.protein / srv).toFixed(0)}g P` : ''}
                      {recipe.carbs   != null ? ` · ${(recipe.carbs   / srv).toFixed(0)}g C` : ''}
                      {recipe.fat     != null ? ` · ${(recipe.fat     / srv).toFixed(0)}g F` : ''}
                    </p>
                  </button>
                  <button onClick={() => { setDeletingId(recipe.id); setDeleteError(null) }}
                    aria-label={`Delete ${recipe.name}`}
                    className="px-4 flex items-center justify-center text-gray-300 hover:text-red-400 hover:bg-red-50 transition-colors shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
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
  { id: 'recipes', icon: '📋', label: 'My Foods & Recipes' },
]

const MODE_TITLES = { photo: 'Photo', text: 'Text Entry', search: 'Search Foods', manual: 'Manual Entry', barcode: 'Scan Barcode', recipes: 'My Foods & Recipes' }
const LOGGERS = { photo: PhotoLogger, text: TextLogger, search: SearchLogger, manual: ManualLogger, barcode: BarcodeLogger, recipes: RecipesLogger }

const SNACK_TIMING_OPTIONS = [
  { value: 'AM Snack',   label: 'Morning',   emoji: '🌅' },
  { value: 'PM Snack',   label: 'Afternoon', emoji: '☀️' },
  { value: 'Late Snack', label: 'Evening',   emoji: '🌙' },
]

function AddFoodDrawer({ slotName, onClose, onSaved, logDate }) {
  const [mode, setMode] = useState(null)
  const isSnack = slotName === 'Snack'
  // For snack slots, user picks a timing before choosing a logger
  const [snackTiming, setSnackTiming] = useState(null)
  const photoInputRef = useRef(null)
  const [photoFile,   setPhotoFile]   = useState(null)

  // The DB slot we actually store (e.g. 'AM Snack', 'Lunch', etc.)
  const effectiveSlot = isSnack
    ? (snackTiming ?? defaultSnackTiming())
    : slotName

  // Friendly display name for header
  const timingLabel = isSnack && snackTiming
    ? SNACK_TIMING_OPTIONS.find(o => o.value === snackTiming)?.label + ' Snack'
    : slotName

  const Logger = mode ? LOGGERS[mode] : null

  // Step back: from mode → timing (snack) or close
  function handleBack() {
    if (mode) { setMode(null); setPhotoFile(null); return }
    if (isSnack && snackTiming) { setSnackTiming(null); return }
    onClose()
  }

  const showTimingPicker = isSnack && snackTiming === null
  const showModePicker   = !showTimingPicker && !mode

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
      <div className="bg-white rounded-t-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            {(mode || (isSnack && snackTiming)) && (
              <button onClick={handleBack} className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-full hover:bg-gray-100 transition-colors text-lg">
                ‹
              </button>
            )}
            <div>
              <p className="text-[11px] text-gray-400 uppercase tracking-wide">{timingLabel}</p>
              <h3 className="text-base font-bold text-gray-900">
                {showTimingPicker ? 'When are you snacking?' : mode ? MODE_TITLES[mode] : 'Add Food'}
              </h3>
            </div>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">
            ✕
          </button>
        </div>

        <div className="p-5 pb-24">
          {/* Step 1 (snack only): pick timing */}
          {showTimingPicker && (
            <div className="grid grid-cols-3 gap-3">
              {SNACK_TIMING_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setSnackTiming(opt.value)}
                  className="flex flex-col items-center gap-2 bg-gray-50 hover:bg-orange-50 hover:border-[#E8670A] border border-gray-200 rounded-2xl py-5 transition-all">
                  <span className="text-2xl">{opt.emoji}</span>
                  <span className="text-xs font-semibold text-gray-700">{opt.label}</span>
                </button>
              ))}
            </div>
          )}

          {/* Step 2: pick logger mode */}
          {showModePicker && (
            <div className="grid grid-cols-3 gap-3">
              {/* Hidden file input — triggered directly when Photo is tapped */}
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) { setPhotoFile(file); setMode('photo') }
                  e.target.value = ''
                }}
              />
              {ADD_OPTIONS.map(opt => (
                <button key={opt.id}
                  onClick={() => opt.id === 'photo' ? photoInputRef.current?.click() : setMode(opt.id)}
                  className="flex flex-col items-center gap-2 bg-gray-50 hover:bg-orange-50 hover:border-[#E8670A] border border-gray-200 rounded-2xl py-4 transition-all">
                  <span className="text-2xl">{opt.icon}</span>
                  <span className="text-xs font-semibold text-gray-700">{opt.label}</span>
                </button>
              ))}
            </div>
          )}

          {/* Step 3: logger */}
          {Logger && (
            <Logger
              slotName={effectiveSlot}
              logDate={logDate}
              onSaved={(meal, analysis) => { onSaved(meal, analysis); }}
              {...(mode === 'photo' && photoFile ? { initialFile: photoFile } : {})}
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
  const [editingMeal,  setEditingMeal]  = useState(null)
  const [copyingMeal,  setCopyingMeal]  = useState(null)
  const [movingMeal,   setMovingMeal]   = useState(null)
  const [copyDayOpen,   setCopyDayOpen]   = useState(false)
  const [copyDayMsg,    setCopyDayMsg]    = useState(null)
  const [copySlotSource, setCopySlotSource] = useState(null) // { date, slot } | null

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

  const handleMealMoved = useCallback(async (mealId, date, slot) => {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/meals/${mealId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ log_date: date, meal_slot: slot }),
    })
    if (!res.ok) throw new Error('Failed to move meal')
    const updated = await res.json()
    if (date === toDateStr(selectedDate)) {
      setMeals(prev => prev.map(m => m.id === mealId ? { ...m, ...updated } : m))
    } else {
      setMeals(prev => prev.filter(m => m.id !== mealId))
    }
    setActiveDates(prev => new Set([...prev, date]))
    setMovingMeal(null)
  }, [getToken, selectedDate])

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
    setActiveDates(prev => new Set([...prev, date]))
    setCopyingMeal(null)
  }, [getToken, selectedDate])

  const handleCopyDaySuccess = useCallback((toDate, count) => {
    setCopyDayOpen(false)
    if (toDate === toDateStr(selectedDate)) loadMeals()
    setActiveDates(prev => new Set([...prev, toDate]))
    setCopyDayMsg(`Copied ${count} meal${count !== 1 ? 's' : ''} to ${toDate}`)
    setTimeout(() => setCopyDayMsg(null), 4000)
  }, [selectedDate, loadMeals])

  const handleCopySlotSuccess = useCallback((toDate, toSlot, count) => {
    setCopySlotSource(null)
    if (toDate === toDateStr(selectedDate)) loadMeals()
    setActiveDates(prev => new Set([...prev, toDate]))
    setCopyDayMsg(`Copied ${count} item${count !== 1 ? 's' : ''} to ${toSlot} on ${toDate}`)
    setTimeout(() => setCopyDayMsg(null), 4000)
  }, [selectedDate, loadMeals])

  const totals    = sumMacros(meals)
  const slotMeals = groupBySlot(meals)

  return (
    <div className="max-w-2xl mx-auto pb-24">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Food Log</h1>
        <div className="flex items-center gap-2">
          {!isToday && (
            <button
              onClick={() => { setSelectedDate(new Date(new Date().setHours(0,0,0,0))); setWeekStart(getMonday(new Date())) }}
              className="text-sm font-medium text-[#E8670A] hover:text-[#c45e09] transition-colors"
            >
              Today
            </button>
          )}
          <button
            onClick={() => setCopyDayOpen(true)}
            className="text-xs font-medium text-gray-500 hover:text-[#E8670A] border border-gray-200 rounded-lg px-2.5 py-1.5 transition-colors"
          >
            Copy Day
          </button>
        </div>
      </div>
      {copyDayMsg && (
        <div className="mb-4 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-sm text-emerald-800 font-medium">
          ✓ {copyDayMsg}
        </div>
      )}

      {/* Week strip calendar */}
      <WeekStrip
        weekDays={weekDays}
        selected={selectedDate}
        onChange={handleDaySelect}
        activeDates={activeDates}
        onShift={shiftWeek}
      />

      {/* Compact macro summary: 4 rings + fiber row */}
      <CompactMacroSummary totals={totals} goals={goals} />

      {/* Meal slots — first on mobile so food logging is front and center */}
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
            onMove={setMovingMeal}
            onCopySlot={slotName => setCopySlotSource({ date: toDateStr(selectedDate), slot: slotName })}
          />
        ))
      )}

      {/* Also Logged */}
      <QuickStats totals={totals} />

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

      {/* Move meal modal */}
      {movingMeal && (
        <CopyMealModal
          mode="move"
          meal={movingMeal}
          onConfirm={handleMealMoved}
          onClose={() => setMovingMeal(null)}
        />
      )}

      {/* Copy day modal */}
      {copyDayOpen && (
        <CopyDayModal
          selectedDate={selectedDate}
          getToken={getToken}
          onClose={() => setCopyDayOpen(false)}
          onSuccess={handleCopyDaySuccess}
        />
      )}

      {/* Copy meal modal */}
      {copySlotSource && (
        <CopySlotModal
          sourceDate={copySlotSource.date}
          sourceSlot={copySlotSource.slot}
          getToken={getToken}
          onClose={() => setCopySlotSource(null)}
          onSuccess={handleCopySlotSuccess}
        />
      )}

    </div>
  )
}
