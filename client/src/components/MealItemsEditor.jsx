import { useRef } from 'react'
import { rescaleItem, sumMealItems } from '../utils/mealItemsApi.js'

function fmt1(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(1) : '0.0'
}

function ItemRow({ item, base, onChange, onDelete }) {
  const canScale = Number.isFinite(Number(base.weight_g)) && Number(base.weight_g) > 0

  function handleWeightChange(e) {
    const val = e.target.value
    if (val === '') { onChange({ ...item, weight_g: null }); return }
    const n = parseFloat(val)
    if (isNaN(n)) return
    onChange({ ...item, ...rescaleItem(base, n) })
  }

  function handlePortionChange(e) {
    onChange({ ...item, portion: e.target.value })
  }

  function handleMacroChange(field, e) {
    const val = e.target.value
    onChange({ ...item, [field]: val === '' ? null : Number(val) })
  }

  return (
    <div className="bg-gray-50 rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-gray-800 leading-snug break-words min-w-0">{item.item}</p>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Remove ${item.item}`}
          className="shrink-0 min-h-[44px] min-w-[44px] -my-2 -mr-1 flex items-center justify-center text-gray-300 hover:text-red-400 text-lg transition-colors"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-[100px]">
          <label className="block text-[10px] text-gray-400 mb-0.5">Portion</label>
          <input
            type="text"
            value={item.portion ?? ''}
            onChange={handlePortionChange}
            className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#E8670A]"
          />
        </div>
        {canScale && (
          <div className="w-24 shrink-0">
            <label className="block text-[10px] text-gray-400 mb-0.5">Weight (g)</label>
            <input
              type="number"
              min="0"
              step="any"
              value={item.weight_g ?? ''}
              onChange={handleWeightChange}
              className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#E8670A]"
            />
          </div>
        )}
      </div>

      {canScale ? (
        <div className="flex gap-3 text-xs text-gray-500 flex-wrap pt-1">
          <span><span className="font-semibold text-orange-500">{Math.round(Number(item.calories) || 0)}</span> cal</span>
          <span><span className="font-semibold text-blue-600">{fmt1(item.protein)}g</span> protein</span>
          <span><span className="font-semibold text-yellow-600">{fmt1(item.carbs)}g</span> carbs</span>
          <span><span className="font-semibold text-pink-500">{fmt1(item.fat)}g</span> fat</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5 pt-1">
          {[['Calories', 'calories'], ['Protein (g)', 'protein'], ['Carbs (g)', 'carbs'], ['Fat (g)', 'fat']].map(([lbl, field]) => (
            <div key={field}>
              <label className="block text-[10px] text-gray-400 mb-0.5">{lbl}</label>
              <input
                type="number"
                min="0"
                value={item[field] ?? ''}
                onChange={e => handleMacroChange(field, e)}
                className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#E8670A]"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Per-ingredient edit list for a logged meal. Shown in place of the
// collapsed calories/protein/carbs/fat fields whenever a meal has
// meal_items rows (currently: Photo and Text Entry logging). Editing an
// item's weight rescales its macros proportionally from that item's
// original baseline; deleting an item removes it from the list entirely.
// The parent is responsible for persisting `items` on save (via
// saveMealItemEdits) — this component only manages the in-progress list.
export default function MealItemsEditor({ items, onChange }) {
  // Captured once at mount so repeated weight edits always scale from the
  // original AI-estimated values, not from the last edit (which would
  // compound rounding error across successive changes).
  const baseRef = useRef(new Map(items.map(i => [
    i.id,
    { weight_g: i.weight_g, calories: i.calories, protein: i.protein, carbs: i.carbs, fat: i.fat },
  ])))

  function updateItem(idx, updated) {
    const next = items.slice()
    next[idx] = updated
    onChange(next)
  }

  function removeItem(idx) {
    onChange(items.filter((_, i) => i !== idx))
  }

  const totals = sumMealItems(items)

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Ingredients</p>

      <div className="space-y-2">
        {items.map((item, idx) => (
          <ItemRow
            key={item.id}
            item={item}
            base={baseRef.current.get(item.id) ?? item}
            onChange={updated => updateItem(idx, updated)}
            onDelete={() => removeItem(idx)}
          />
        ))}
      </div>

      {items.length === 0 && (
        <p className="text-xs text-gray-400 italic">All ingredients removed — meal totals will be zero.</p>
      )}

      <div className="bg-orange-50 border border-orange-100 rounded-xl p-3">
        <p className="text-xs font-semibold text-gray-600 mb-1">Meal Total</p>
        <div className="flex gap-4 text-xs text-gray-600 flex-wrap">
          <span><span className="font-bold text-orange-500">{Math.round(totals.calories)}</span> cal</span>
          <span><span className="font-bold text-blue-600">{fmt1(totals.protein)}g</span> protein</span>
          <span><span className="font-bold text-yellow-600">{fmt1(totals.carbs)}g</span> carbs</span>
          <span><span className="font-bold text-pink-500">{fmt1(totals.fat)}g</span> fat</span>
        </div>
      </div>
    </div>
  )
}
