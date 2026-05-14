export const MICRONUTRIENT_FIELDS = [
  { key: 'fiber_g', label: 'Fiber', unit: 'g', decimals: 1 },
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg', decimals: 0 },
  { key: 'potassium_mg', label: 'Potassium', unit: 'mg', decimals: 0 },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', decimals: 0 },
  { key: 'iron_mg', label: 'Iron', unit: 'mg', decimals: 1 },
  { key: 'vitamin_d_mcg', label: 'Vitamin D', unit: 'mcg', decimals: 1 },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', decimals: 0 },
]

function parseMicronutrients(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

export function calculateMicronutrientTotals(meals = []) {
  const totals = Object.fromEntries(MICRONUTRIENT_FIELDS.map(n => [n.key, 0]))
  const counts = Object.fromEntries(MICRONUTRIENT_FIELDS.map(n => [n.key, 0]))

  for (const meal of meals) {
    const micronutrients = parseMicronutrients(meal?.micronutrients)
    if (!micronutrients) continue

    for (const { key } of MICRONUTRIENT_FIELDS) {
      const value = micronutrients[key]
      if (value == null || value === '') continue
      const numeric = Number(value)
      if (Number.isNaN(numeric)) continue
      totals[key] += numeric
      counts[key] += 1
    }
  }

  return MICRONUTRIENT_FIELDS
    .filter(({ key }) => counts[key] > 0)
    .map(({ key, label, unit, decimals }) => ({
      key,
      label,
      unit,
      decimals,
      value: totals[key],
      count: counts[key],
    }))
}

function formatValue(value, decimals) {
  const rounded = decimals === 0 ? Math.round(value) : Number(value).toFixed(decimals)
  return String(rounded).replace(/\.0$/, '')
}

export default function MicronutrientTotals({ meals, loading = false, title = 'Micronutrient Totals', periodLabel = 'Selected day', exclude = [] }) {
  const nutrients = loading ? [] : calculateMicronutrientTotals(meals).filter(n => !exclude.includes(n.key))

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
        {!loading && nutrients.length > 0 && (
          <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{periodLabel}</span>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading micronutrients...</p>
      ) : nutrients.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {nutrients.map(n => (
            <div key={n.key} className="rounded-lg bg-gray-50 px-3 py-2">
              <p className="text-[11px] text-gray-400">{n.label}</p>
              <p className="text-sm font-semibold text-gray-900">
                {formatValue(n.value, n.decimals)}
                <span className="ml-0.5 text-[11px] font-medium text-gray-400">{n.unit}</span>
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400">No micronutrient data available for this day yet.</p>
      )}
    </section>
  )
}
