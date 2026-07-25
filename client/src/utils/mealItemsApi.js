import { API_URL } from '../config.js'

// Recalculates one item's macros proportionally against its original
// baseline (weight_g/calories/protein/carbs/fat as loaded), so repeated
// weight edits scale from the original AI estimate rather than the last
// edit — avoids compounding rounding error across successive changes.
// Falls back to leaving macros untouched when there's no weight to scale
// from (AI didn't estimate one for this ingredient).
export function rescaleItem(base, newWeightG) {
  const baseWeight = Number(base.weight_g)
  if (!Number.isFinite(baseWeight) || baseWeight <= 0 || newWeightG == null || newWeightG <= 0) {
    return { weight_g: newWeightG }
  }
  const ratio = newWeightG / baseWeight
  const scale = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n * ratio : null
  }
  return {
    weight_g: newWeightG,
    calories: scale(base.calories) != null ? Math.round(scale(base.calories)) : null,
    protein:  scale(base.protein)  != null ? +scale(base.protein).toFixed(1)  : null,
    carbs:    scale(base.carbs)    != null ? +scale(base.carbs).toFixed(1)    : null,
    fat:      scale(base.fat)      != null ? +scale(base.fat).toFixed(1)      : null,
  }
}

export function sumMealItems(items) {
  return items.reduce((acc, it) => ({
    calories: acc.calories + (Number(it.calories) || 0),
    protein:  acc.protein  + (Number(it.protein)  || 0),
    carbs:    acc.carbs    + (Number(it.carbs)    || 0),
    fat:      acc.fat      + (Number(it.fat)      || 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 })
}

// Persists an ingredient-editor save: scalar fields (name/slot/fiber/notes —
// never calories/protein/carbs/fat, which are derived server-side from the
// items sum) via the existing meal PATCH, then the items themselves via the
// meal_items PATCH, which recomputes and returns the authoritative rollup.
// Returns the final meal object (with its updated .items array) from the
// items call, since it's computed last and is always the freshest state.
export async function saveMealItemEdits({ getToken, mealId, scalarFields, items }) {
  const token = await getToken()

  const cleanScalar = scalarFields
    ? Object.fromEntries(Object.entries(scalarFields).filter(([, v]) => v !== undefined))
    : {}
  if (Object.keys(cleanScalar).length) {
    const res = await fetch(`${API_URL}/api/meals/${mealId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanScalar),
    })
    if (!res.ok) throw new Error('Failed to save meal')
  }

  const res = await fetch(`${API_URL}/api/meals/${mealId}/items`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: items.map(it => ({
        id: it.id, portion: it.portion, weight_g: it.weight_g,
        calories: it.calories, protein: it.protein, carbs: it.carbs, fat: it.fat,
      })),
    }),
  })
  if (!res.ok) throw new Error('Failed to save ingredients')
  return res.json()
}
