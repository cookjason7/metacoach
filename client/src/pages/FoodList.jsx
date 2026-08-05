const MAIN_COLS = [
  {
    category: 'PROTEIN',
    color: '#1B4F8C',
    bg: '#EBF2FA',
    items: [
      'Chicken Breast Skinless',
      'Bison Burger',
      'Venison',
      'Lean Turkey Breast',
      'Pork Tenderloin',
      'Salmon',
      '96/4 Ground Beef',
      'Fish/Shellfish',
      'Egg Whites',
      'Fat Free Cottage Cheese',
      'Fat Free Greek Yogurt',
      'Tuna',
      'Protein Powder',
    ],
  },
  {
    category: 'FATS',
    color: '#B8860B',
    bg: '#FFFBEB',
    items: [
      'Whole Egg',
      'Unsweetened Nut Butter',
      'Coconut Oil',
      'Grass Fed Butter',
      'Olive Oil',
      'Avocado Oil',
      'Avocado',
      '1/4 Cup Any Nuts',
    ],
    warning: 'Avoid Vegetable or Canola Oil',
  },
  {
    category: 'CARBS',
    color: '#CC0000',
    bg: '#FFF0F0',
    items: [
      'All Potatoes',
      'Any Bean/Legumes',
      'Brown Rice',
      'White Rice',
      'Ezekiel Bread',
      "Dave's Killer Bread",
      'Rolled Oats',
      'Quinoa',
      'Fruit',
    ],
  },
  {
    category: 'VEGGIES',
    color: '#2E7D32',
    bg: '#F0FFF0',
    items: [
      'Any Veggies',
      'Focus on Green and Leafy Veggies',
      'Eat The Rainbow',
    ],
  },
]

const BOTTOM_COLS = [
  {
    category: 'CONDIMENTS',
    items: ['Mustard', 'Soy Sauce', 'Lemon Juice', 'Balsamic', 'Hot Sauces', 'Stevia/Splenda'],
  },
  {
    category: 'SPICES',
    items: ['Dry Spices', 'Dry Seasoning', 'Dry Rubs', 'Salt', 'Pepper', 'Mrs. Dash Spices'],
  },
  {
    category: 'BEVERAGES',
    items: ['Unsweetened Nut Milk', 'Green Tea', 'Black Coffee', 'Zero Sugar Iced Tea'],
  },
]

function Column({ category, color, bg, items, warning }) {
  return (
    <div
      className="flex flex-col rounded-xl overflow-hidden"
      style={{ border: `2px solid ${color}` }}
    >
      {/* Header — white bg, colored bold text */}
      <div className="px-4 py-3 text-center bg-white" style={{ borderBottom: `2px solid ${color}` }}>
        <span className="text-base font-bold tracking-wide" style={{ color }}>{category}</span>
      </div>

      {/* Food list */}
      <div className="flex-1 px-4 py-4 space-y-2" style={{ backgroundColor: bg }}>
        {items.map(item => (
          <p key={item} className="text-sm text-gray-900 leading-snug">{item}</p>
        ))}
      </div>

      {/* Warning */}
      {warning && (
        <div className="px-4 py-3 bg-white" style={{ borderTop: `1px solid ${color}33` }}>
          <p className="text-xs font-medium text-red-600 flex items-start gap-1">
            <span className="shrink-0">⚠</span>
            <span>{warning}</span>
          </p>
        </div>
      )}
    </div>
  )
}

function BottomColumn({ category, items }) {
  const color = '#E8670A'
  const bg    = '#FFF5EE'
  return (
    <div
      className="flex flex-col rounded-xl overflow-hidden"
      style={{ border: `2px solid ${color}` }}
    >
      <div className="px-4 py-3 text-center bg-white" style={{ borderBottom: `2px solid ${color}` }}>
        <span className="text-base font-bold tracking-wide" style={{ color }}>{category}</span>
      </div>
      <div className="flex-1 px-4 py-4 space-y-2" style={{ backgroundColor: bg }}>
        {items.map(item => (
          <p key={item} className="text-sm text-gray-900 leading-snug">{item}</p>
        ))}
      </div>
    </div>
  )
}

export default function FoodList() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Warrior Food List</h1>
      <p className="text-sm text-gray-500 mb-6">
        Whole, clean foods that fuel your transformation. Eat from this list at every meal.
      </p>

      {/* Main 4-column grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {MAIN_COLS.map(col => <Column key={col.category} {...col} />)}
      </div>

      {/* Bottom 3-column grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {BOTTOM_COLS.map(col => <BottomColumn key={col.category} {...col} />)}
      </div>

      {/* Pro Tip */}
      <p className="text-sm italic text-center mb-6" style={{ color: '#E8670A' }}>
        "You are not a bad cook — you are just not using enough seasoning on your food."
      </p>

      {/* Printable Food List */}
      <div className="text-center">
        <a
          href="https://drive.google.com/file/d/1EGWScDT8_8w-Rx9IFtKRwPUy3NTAE1BJ/view?usp=drive_link"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold underline"
          style={{ color: '#E8670A' }}
        >
          Printable Food List
        </a>
      </div>
    </div>
  )
}
