import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const SLOT_ORDER = ['Breakfast', 'AM Snack', 'Lunch', 'PM Snack', 'Dinner', 'Late Snack']

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDateLabel(date) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString())     return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

function dayTotals(meals) {
  return meals.reduce(
    (acc, m) => ({
      calories: acc.calories + (Number(m.calories) || 0),
      protein:  acc.protein  + (Number(m.protein)  || 0),
      carbs:    acc.carbs    + (Number(m.carbs)    || 0),
      fat:      acc.fat      + (Number(m.fat)      || 0),
      fiber:    acc.fiber    + (Number(m.fiber)    || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
  )
}

function groupBySlot(meals) {
  const groups = {}
  for (const meal of meals) {
    const key = SLOT_ORDER.includes(meal.meal_slot) ? meal.meal_slot : 'Other'
    if (!groups[key]) groups[key] = []
    groups[key].push(meal)
  }
  return groups
}

// ── Shared UI pieces ──────────────────────────────────────────────────────────

function MacroChip({ label, value, unit = 'g' }) {
  return (
    <span className="text-xs text-gray-500">
      <span className="font-medium text-gray-700">
        {value != null ? Number(value).toFixed(1) : '?'}{unit}
      </span>{' '}{label}
    </span>
  )
}

function MacroBar({ label, logged, goal, color, unit = 'g' }) {
  const pct  = goal ? Math.min((logged / goal) * 100, 100) : 0
  const over = goal && logged > goal
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-500">{label}</span>
        <span className={over ? 'text-red-500 font-medium' : 'text-gray-700'}>
          {Math.round(logged)}{unit}{goal ? ` / ${goal}${unit}` : ''}
        </span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${over ? 'bg-red-400' : color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── Date navigation ───────────────────────────────────────────────────────────

function DateNav({ date, onChange }) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const minDate = new Date(today)
  minDate.setDate(today.getDate() - 90)
  const maxDate = new Date(today)
  maxDate.setDate(today.getDate() + 30)

  function shift(days) {
    const next = new Date(date)
    next.setDate(date.getDate() + days)
    onChange(next)
  }

  return (
    <div className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-4 py-3 mb-4">
      <button
        onClick={() => shift(-1)}
        disabled={date <= minDate}
        className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-lg leading-none"
      >
        ←
      </button>
      <span className="text-sm font-semibold text-gray-800">{formatDateLabel(date)}</span>
      <button
        onClick={() => shift(1)}
        disabled={date >= maxDate}
        className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-lg leading-none"
      >
        →
      </button>
    </div>
  )
}

// ── Daily macro summary ───────────────────────────────────────────────────────

function DaySummary({ meals, goals }) {
  const t = dayTotals(meals)
  const goalCalories = goals.goal_calories ?? 2000
  const goalProtein  = goals.goal_protein  ?? 150
  const goalCarbs    = goals.goal_carbs    ?? 150
  const goalFat      = goals.goal_fat      ?? 65
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 space-y-3">
      <MacroBar label="Calories" logged={t.calories} goal={goalCalories} color="bg-[#E8670A]" unit=" kcal" />
      <MacroBar label="Protein"  logged={t.protein}  goal={goalProtein}  color="bg-blue-500" />
      <MacroBar label="Carbs"    logged={t.carbs}    goal={goalCarbs}    color="bg-yellow-400" />
      <MacroBar label="Fat"      logged={t.fat}      goal={goalFat}      color="bg-pink-400" />
    </div>
  )
}

// ── Copy Meal modal ───────────────────────────────────────────────────────────

function CopyModal({ meal, onConfirm, onClose }) {
  const todayStr = toDateStr(new Date())
  const minStr   = toDateStr((() => { const d = new Date(); d.setDate(d.getDate() - 90); return d })())
  const [date,   setDate]   = useState(todayStr)
  const [slot,   setSlot]   = useState(SLOT_ORDER.includes(meal.meal_slot) ? meal.meal_slot : SLOT_ORDER[0])
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  async function handleConfirm() {
    setSaving(true)
    setError(null)
    try {
      await onConfirm(meal.id, date, slot)
      onClose()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-gray-900 mb-1">Copy Meal</h3>
        <p className="text-sm text-gray-500 mb-4">
          Copy <span className="font-medium text-gray-700">{meal.meal_name}</span> to:
        </p>
        <div className="space-y-3 mb-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
            <input
              type="date" value={date} min={minStr} max={todayStr}
              onChange={e => setDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Meal slot</label>
            <select
              value={slot}
              onChange={e => setSlot(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A] bg-white"
            >
              {SLOT_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
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

// ── Copy Day modal ────────────────────────────────────────────────────────────

function CopyDayModal({ fromDate, mealCount, onConfirm, onClose }) {
  const todayStr = toDateStr(new Date())
  const minStr   = toDateStr((() => { const d = new Date(); d.setDate(d.getDate() - 90); return d })())
  const [toDate, setToDate] = useState(todayStr)
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  async function handleConfirm() {
    setSaving(true)
    setError(null)
    try {
      await onConfirm(fromDate, toDate)
      onClose()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-gray-900 mb-1">Copy Full Day</h3>
        <p className="text-sm text-gray-500 mb-4">
          Copy all <span className="font-medium text-gray-700">{mealCount} meals</span> to which day?
        </p>
        <input
          type="date" value={toDate} min={minStr} max={todayStr}
          onChange={e => setToDate(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
        />
        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
        <div className="flex gap-2">
          <button onClick={handleConfirm} disabled={saving}
            className="flex-1 bg-[#E8670A] text-white py-2 rounded-lg text-sm font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
            {saving ? 'Copying…' : 'Copy Day'}
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

// ── Edit form ─────────────────────────────────────────────────────────────────

function MealEditForm({ meal, onSave, onCancel }) {
  const [form, setForm] = useState({
    meal_name:     meal.meal_name,
    calories:      meal.calories      != null ? String(meal.calories)      : '',
    protein:       meal.protein       != null ? String(meal.protein)       : '',
    carbs:         meal.carbs         != null ? String(meal.carbs)         : '',
    fat:           meal.fat           != null ? String(meal.fat)           : '',
    fiber:         meal.fiber         != null ? String(meal.fiber)         : '',
    portion_notes: meal.portion_notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  function set(e) {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: value }))
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!form.meal_name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onSave(meal.id, {
        meal_name:     form.meal_name.trim(),
        calories:      form.calories  !== '' ? Number(form.calories)  : undefined,
        protein:       form.protein   !== '' ? Number(form.protein)   : undefined,
        carbs:         form.carbs     !== '' ? Number(form.carbs)     : undefined,
        fat:           form.fat       !== '' ? Number(form.fat)       : undefined,
        fiber:         form.fiber     !== '' ? Number(form.fiber)     : undefined,
        portion_notes: form.portion_notes.trim() || undefined,
      })
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  const FIELDS = [
    ['Calories', 'calories'],
    ['Protein g', 'protein'],
    ['Carbs g', 'carbs'],
    ['Fat g', 'fat'],
    ['Fiber g', 'fiber'],
  ]

  return (
    <form onSubmit={handleSave} className="mt-3 pt-3 border-t border-gray-100 space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Meal name</label>
        <input
          type="text" name="meal_name" value={form.meal_name} onChange={set} required
          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {FIELDS.map(([label, name]) => (
          <div key={name}>
            <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
            <input
              type="number" name={name} value={form[name]} onChange={set} min="0"
              className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
            />
          </div>
        ))}
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
        <input
          type="text" name="portion_notes" value={form.portion_notes} onChange={set}
          placeholder="e.g. 1 large bowl, 6 oz chicken"
          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
        />
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving}
          className="bg-[#E8670A] text-white px-4 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#c45e09] disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel}
          className="px-4 py-1.5 rounded-lg text-xs font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
          Cancel
        </button>
      </div>
    </form>
  )
}

// ── Meal card ─────────────────────────────────────────────────────────────────

function MealCard({ meal, onUpdate, onDelete, onCopy }) {
  const [editing,    setEditing]    = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting,   setDeleting]   = useState(false)
  const [showCopy,   setShowCopy]   = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      await onDelete(meal.id)
    } finally {
      setDeleting(false)
      setConfirming(false)
    }
  }

  return (
    <>
      <div className="py-4">
        <div className="flex gap-4">
          <div className="w-16 h-16 rounded-xl overflow-hidden bg-gray-100 shrink-0">
            {meal.photo_url
              ? <img src={meal.photo_url} alt={meal.meal_name} className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-gray-300 text-2xl">🍽</div>
            }
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-gray-900 truncate">{meal.meal_name}</p>
              <span className="text-xs text-gray-400 shrink-0">{formatTime(meal.logged_at)}</span>
            </div>
            <p className="text-sm font-bold text-gray-800 mt-0.5">
              {meal.calories ?? '?'}{' '}
              <span className="font-normal text-gray-500 text-xs">cal</span>
            </p>
            <div className="flex gap-3 mt-1 flex-wrap">
              <MacroChip label="protein" value={meal.protein} />
              <MacroChip label="carbs"   value={meal.carbs} />
              <MacroChip label="fat"     value={meal.fat} />
              {meal.fiber != null && <MacroChip label="fiber" value={meal.fiber} />}
            </div>
            {meal.portion_notes && (
              <p className="text-xs text-gray-400 mt-0.5 italic">{meal.portion_notes}</p>
            )}

            {!editing && !confirming && (
              <div className="flex gap-3 mt-2">
                <button onClick={() => setEditing(true)}
                  className="text-xs font-medium text-gray-400 hover:text-gray-600 transition-colors">
                  Edit
                </button>
                <button onClick={() => setShowCopy(true)}
                  className="text-xs font-medium text-[#E8670A] hover:text-[#a34506] transition-colors">
                  Copy
                </button>
                <button onClick={() => setConfirming(true)}
                  className="text-xs font-medium text-gray-400 hover:text-red-500 transition-colors">
                  Delete
                </button>
              </div>
            )}

            {confirming && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-gray-500">Delete this meal?</span>
                <button onClick={handleDelete} disabled={deleting}
                  className="text-xs font-semibold text-red-500 hover:text-red-700 transition-colors">
                  {deleting ? 'Deleting…' : 'Yes, delete'}
                </button>
                <button onClick={() => setConfirming(false)}
                  className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {editing && (
          <MealEditForm
            meal={meal}
            onSave={async (id, updates) => { await onUpdate(id, updates); setEditing(false) }}
            onCancel={() => setEditing(false)}
          />
        )}
      </div>

      {showCopy && (
        <CopyModal meal={meal} onConfirm={onCopy} onClose={() => setShowCopy(false)} />
      )}
    </>
  )
}

// ── Slot subtotal ─────────────────────────────────────────────────────────────

function SlotSubtotal({ meals }) {
  const t = dayTotals(meals)
  return (
    <div className="flex items-center gap-4 py-2.5 border-t border-gray-100 text-xs">
      <span className="text-gray-400 font-medium w-14 shrink-0">Subtotal</span>
      <span className="text-gray-700 font-semibold">{Math.round(t.calories)} <span className="font-normal text-gray-400">cal</span></span>
      <span className="text-blue-600 font-semibold">{t.protein.toFixed(1)}g <span className="font-normal text-gray-400">P</span></span>
      <span className="text-yellow-600 font-semibold">{t.carbs.toFixed(1)}g <span className="font-normal text-gray-400">C</span></span>
      <span className="text-pink-500 font-semibold">{t.fat.toFixed(1)}g <span className="font-normal text-gray-400">F</span></span>
    </div>
  )
}

// ── Daily totals ──────────────────────────────────────────────────────────────

function DailyTotals({ meals }) {
  const t = dayTotals(meals)
  const items = [
    { label: 'Calories', value: Math.round(t.calories), unit: 'kcal', color: 'text-[#E8670A]'   },
    { label: 'Protein',  value: Math.round(t.protein),  unit: 'g',    color: 'text-blue-600'    },
    { label: 'Carbs',    value: Math.round(t.carbs),    unit: 'g',    color: 'text-yellow-600'  },
    { label: 'Fat',      value: Math.round(t.fat),      unit: 'g',    color: 'text-pink-500'    },
    { label: 'Fiber',    value: Math.round(t.fiber),    unit: 'g',    color: 'text-emerald-600' },
  ]
  return (
    <div className="pt-4 pb-2 border-t border-gray-100">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Daily Totals</p>
      <div className="grid grid-cols-5 gap-2 text-center">
        {items.map(({ label, value, unit, color }) => (
          <div key={label}>
            <p className={`text-sm font-bold ${color}`}>
              {value}<span className="text-xs font-normal">{unit}</span>
            </p>
            <p className="text-xs text-gray-400 mt-0.5">{label}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ date }) {
  const isToday = toDateStr(date) === toDateStr(new Date())
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="text-5xl mb-4">🍽</div>
      <h2 className="text-lg font-semibold text-gray-800 mb-1">No meals logged</h2>
      <p className="text-sm text-gray-500 mb-6 max-w-xs">
        {isToday
          ? "Start logging your meals and they'll appear here with your macro breakdown."
          : 'No meals were logged on this day.'}
      </p>
      {isToday && (
        <Link to="/log-meal"
          className="bg-[#E8670A] text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#c45e09] transition-colors">
          Log a Meal
        </Link>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MealHistory() {
  const { getToken } = useAuth()

  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  })
  const [meals,       setMeals]       = useState([])
  const [goals,       setGoals]       = useState({})
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [showCopyDay, setShowCopyDay] = useState(false)

  useEffect(() => {
    async function loadGoals() {
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) setGoals(await res.json())
      } catch {}
    }
    loadGoals()
  }, [getToken])

  useEffect(() => {
    async function loadMeals() {
      setLoading(true)
      setError(null)
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/meals?date=${toDateStr(selectedDate)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        setMeals(await res.json())
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    loadMeals()
  }, [selectedDate, getToken])

  const updateMeal = useCallback(async (mealId, updates) => {
    const token = await getToken()
    const res   = await fetch(`${API_URL}/api/meals/${mealId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) throw new Error('Failed to update meal')
    const updated = await res.json()
    setMeals(prev => prev.map(m => m.id === mealId ? { ...m, ...updated } : m))
  }, [getToken])

  const deleteMeal = useCallback(async (mealId) => {
    const token = await getToken()
    const res   = await fetch(`${API_URL}/api/meals/${mealId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error('Failed to delete meal')
    setMeals(prev => prev.filter(m => m.id !== mealId))
  }, [getToken])

  const copyMeal = useCallback(async (mealId, date, slot) => {
    const token = await getToken()
    const res   = await fetch(`${API_URL}/api/meals/${mealId}/copy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, slot }),
    })
    if (!res.ok) throw new Error('Failed to copy meal')
    const newMeal = await res.json()
    if (date === toDateStr(selectedDate)) {
      setMeals(prev => [...prev, newMeal])
    }
  }, [getToken, selectedDate])

  const copyDay = useCallback(async (fromDate, toDate) => {
    const token = await getToken()
    const res   = await fetch(`${API_URL}/api/meals/copy-day`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_date: fromDate, to_date: toDate }),
    })
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}))
      throw new Error(error || 'Failed to copy day')
    }
    const { meals: newMeals } = await res.json()
    if (toDate === toDateStr(selectedDate)) {
      setMeals(prev => [...prev, ...newMeals])
    }
  }, [getToken, selectedDate])

  const grouped = groupBySlot(meals)

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Meal History</h1>
      <p className="text-sm text-gray-500 mb-4">Track your daily nutrition</p>

      <DateNav date={selectedDate} onChange={setSelectedDate} />

      {loading && <p className="text-sm text-gray-400 text-center py-16">Loading…</p>}
      {error   && <p className="text-sm text-red-500 text-center py-8">{error}</p>}

      {!loading && !error && (
        <>
          {meals.length > 0 && <DaySummary meals={meals} goals={goals} />}

          {/* Copy Day button */}
          {meals.length > 0 && (
            <div className="flex justify-end mb-2">
              <button
                onClick={() => setShowCopyDay(true)}
                className="text-xs font-medium text-[#E8670A] hover:text-[#a34506] transition-colors"
              >
                Copy Day →
              </button>
            </div>
          )}

          {meals.length === 0
            ? <EmptyState date={selectedDate} />
            : (
              <div className="bg-white rounded-xl border border-gray-200 px-5">
                {[...SLOT_ORDER, 'Other'].map(slotName => {
                  const slotMeals = grouped[slotName]
                  if (!slotMeals?.length) return null
                  return (
                    <div key={slotName} className="border-b border-gray-100 last:border-0">
                      <p className="pt-4 pb-1 text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
                        {slotName}
                      </p>
                      <div className="divide-y divide-gray-50">
                        {slotMeals.map(meal => (
                          <MealCard
                            key={meal.id}
                            meal={meal}
                            onUpdate={updateMeal}
                            onDelete={deleteMeal}
                            onCopy={copyMeal}
                          />
                        ))}
                      </div>
                      <SlotSubtotal meals={slotMeals} />
                    </div>
                  )
                })}
                <DailyTotals meals={meals} />
              </div>
            )
          }
        </>
      )}

      {showCopyDay && (
        <CopyDayModal
          fromDate={toDateStr(selectedDate)}
          mealCount={meals.length}
          onConfirm={copyDay}
          onClose={() => setShowCopyDay(false)}
        />
      )}
    </div>
  )
}
