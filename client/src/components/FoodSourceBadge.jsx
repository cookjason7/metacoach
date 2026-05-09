function getBadge(food) {
  if (!food) return null
  if (food.is_verified) {
    return {
      label: food.source_label || 'Verified USDA',
      title: 'USDA-backed verified food',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    }
  }
  if (food._source === 'custom') {
    return {
      label: food.source_label || (food.is_global ? 'Coach food' : 'My food'),
      title: food.is_global ? 'Coach-created food' : 'User-created custom food',
      className: food.is_global
        ? 'border-orange-200 bg-orange-50 text-[#E8670A]'
        : 'border-gray-200 bg-gray-50 text-gray-500',
    }
  }
  if (food._source === 'barcode') {
    return {
      label: food.source_label || 'Open Food Facts',
      title: 'Barcode result from Open Food Facts',
      className: 'border-sky-200 bg-sky-50 text-sky-700',
    }
  }
  if (food.source_label) {
    return {
      label: food.source_label,
      title: food.source_label,
      className: 'border-gray-200 bg-gray-50 text-gray-500',
    }
  }
  return null
}

export default function FoodSourceBadge({ food, className = '' }) {
  const badge = getBadge(food)
  if (!badge) return null

  return (
    <span
      title={badge.title}
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none ${badge.className} ${className}`}
    >
      {badge.label}
    </span>
  )
}
