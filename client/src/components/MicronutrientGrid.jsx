const MICRONUTRIENTS = [
  { key: 'fiber_g', label: 'Fiber', unit: 'g', decimals: 1 },
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg', decimals: 0 },
  { key: 'potassium_mg', label: 'Potassium', unit: 'mg', decimals: 0 },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', decimals: 0 },
  { key: 'iron_mg', label: 'Iron', unit: 'mg', decimals: 1 },
  { key: 'vitamin_d_mcg', label: 'Vitamin D', unit: 'mcg', decimals: 1 },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', decimals: 0 },
]

function formatValue(value, decimals) {
  if (value == null || Number.isNaN(Number(value))) return null
  const rounded = decimals === 0 ? Math.round(value) : Number(value).toFixed(decimals)
  return String(rounded).replace(/\.0$/, '')
}

export default function MicronutrientGrid({ food, grams, title = 'Micronutrients' }) {
  if (!food || !grams || grams <= 0) return null

  const ratio = grams / 100
  const nutrients = MICRONUTRIENTS
    .map(({ key, label, unit, decimals }) => {
      const raw = food[key]
      if (raw == null || Number(raw) <= 0) return null
      const value = formatValue(Number(raw) * ratio, decimals)
      if (value == null) return null
      return { key, label, unit, value }
    })
    .filter(Boolean)

  if (nutrients.length === 0) return null

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {nutrients.map(n => (
          <div key={n.key} className="rounded-lg bg-white px-3 py-2">
            <p className="text-[11px] text-gray-400">{n.label}</p>
            <p className="text-sm font-semibold text-gray-800">
              {n.value}<span className="ml-0.5 text-[11px] font-medium text-gray-400">{n.unit}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
