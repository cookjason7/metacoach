import { useState } from 'react'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

export default function Calendar() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [viewDate, setViewDate]   = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [tappedDay, setTappedDay] = useState(null)

  const year  = viewDate.getFullYear()
  const month = viewDate.getMonth()

  const firstDow   = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  function prevMonth() { setViewDate(new Date(year, month - 1, 1)); setTappedDay(null) }
  function nextMonth() { setViewDate(new Date(year, month + 1, 1)); setTappedDay(null) }

  function isToday(d) {
    const dt = new Date(year, month, d)
    return dt.toDateString() === today.toDateString()
  }

  function isTapped(d) { return tappedDay === d }

  const cells = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <div className="max-w-lg pb-24">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Calendar</h1>
      <p className="text-sm text-gray-500 mb-6">Habit tracking coming soon</p>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {/* Month nav */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <button onClick={prevMonth} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-500 transition-colors text-lg">‹</button>
          <p className="text-sm font-semibold text-gray-900">{MONTHS[month]} {year}</p>
          <button onClick={nextMonth} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-500 transition-colors text-lg">›</button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-gray-100">
          {DAYS.map(d => (
            <div key={d} className="py-2 text-center text-xs font-semibold text-gray-400">{d}</div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {cells.map((d, i) => (
            <div key={i} className="aspect-square border-b border-r border-gray-50 last:border-r-0">
              {d != null && (
                <button
                  onClick={() => setTappedDay(isTapped(d) ? null : d)}
                  className={`w-full h-full flex items-center justify-center text-sm transition-colors ${
                    isTapped(d)
                      ? 'bg-[#E8670A] text-white font-semibold'
                      : isToday(d)
                        ? 'bg-orange-50 text-[#E8670A] font-bold'
                        : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {d}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {tappedDay != null && (
        <div className="mt-4 bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm font-semibold text-gray-900 mb-1">
            {MONTHS[month]} {tappedDay}, {year}
          </p>
          <p className="text-sm text-gray-500">Habit tracking coming soon.</p>
        </div>
      )}
    </div>
  )
}
