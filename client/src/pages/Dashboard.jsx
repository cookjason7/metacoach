import { useEffect, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config.js'
import MicronutrientTotals from '../components/MicronutrientTotals.jsx'

// ── Gamification Banner (compact, tappable) ───────────────────────────────────

const STREAK_ITEMS = [
  { icon: '🔥', key: 'food_log' },
  { icon: '💧', key: 'water_goal' },
  { icon: '💪', key: 'protein_goal' },
  { icon: '🏋️', key: 'workout' },
]

function GamificationCard({ data, loading }) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 mb-5 animate-pulse">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-6 h-6 bg-gray-100 rounded" />
          <div className="h-3.5 bg-gray-100 rounded w-20" />
          <div className="ml-auto flex gap-3">
            {[...Array(4)].map((_, i) => <div key={i} className="w-8 h-3.5 bg-gray-100 rounded" />)}
          </div>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full" />
      </div>
    )
  }
  if (!data) return null

  return (
    <Link
      to="/badges"
      className="block bg-white rounded-2xl border border-gray-200 px-4 py-3 mb-5 hover:border-gray-300 active:bg-gray-50 transition-colors group"
    >
      {/* Row 1 — rank icon · rank name · XP · streaks · chevron */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg leading-none shrink-0">{data.rank_icon}</span>
        <span className="text-sm font-bold leading-none shrink-0" style={{ color: data.rank_color }}>
          {data.rank}
        </span>
        <span className="text-xs text-gray-400 leading-none shrink-0">
          {data.total_xp.toLocaleString()} XP
        </span>

        {/* Streaks pushed to the right */}
        <div className="ml-auto flex items-center gap-3">
          {STREAK_ITEMS.map(s => {
            const count = data.streaks[s.key] ?? 0
            const hot   = count >= 3
            return (
              <span key={s.key}
                className={`text-xs font-bold leading-none tabular-nums ${hot ? 'text-[#E8670A]' : 'text-gray-400'}`}>
                {s.icon} {count}
              </span>
            )
          })}
          <svg className="w-3.5 h-3.5 text-gray-300 group-hover:text-gray-500 transition-colors shrink-0"
            fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </div>

      {/* Row 2 — XP progress bar */}
      <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${data.next_rank ? data.progress_pct : 100}%`,
            backgroundColor: data.rank_color,
          }}
        />
      </div>
      {data.next_rank && (
        <p className="text-[10px] text-gray-400 mt-0.5 text-right leading-none">
          {data.xp_to_next_rank} XP to {data.next_rank}
        </p>
      )}
    </Link>
  )
}

function KatieBanner({ message, onDismiss }) {
  if (!message) return null
  return (
    <Link
      to="/ai-coach"
      className="flex items-start gap-3 bg-[#fff7ed] border border-[#fed7aa] rounded-xl px-4 py-3 mb-6 group hover:bg-[#ffedd5] transition-colors"
      onClick={onDismiss}
    >
      <div className="w-8 h-8 rounded-full bg-[#fde8c8] flex items-center justify-center text-[#E8670A] font-bold text-xs shrink-0 mt-0.5">
        K
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-[#E8670A] mb-0.5">New message from Coach Katie</p>
        <p className="text-sm text-gray-700 line-clamp-2">{message}</p>
      </div>
      <svg className="w-4 h-4 text-[#E8670A] shrink-0 mt-1 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  )
}

function StatCard({ label, value, sub, color = 'text-gray-900' }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function TrackerCard({ label, unit, field, currentValue, onSave }) {
  const [editing, setEditing] = useState(false)
  const [input,   setInput]   = useState('')
  const [saving,  setSaving]  = useState(false)

  function openEdit() {
    setInput(currentValue != null ? String(currentValue) : '')
    setEditing(true)
  }

  function cancel() { setEditing(false) }

  async function handleSave() {
    const num = parseFloat(input)
    if (isNaN(num) || num < 0) return
    setSaving(true)
    try {
      await onSave(field, num)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="bg-white rounded-xl border border-gray-200 p-3 flex flex-col items-center text-center cursor-pointer select-none"
      onClick={!editing ? openEdit : undefined}
    >
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      {editing ? (
        <div className="w-full" onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            type="number"
            min="0"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') cancel() }}
            className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-[#E8670A] mb-2"
          />
          <div className="flex gap-1.5 justify-center">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 bg-[#E8670A] text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-60"
            >
              {saving ? '…' : '✓'}
            </button>
            <button
              onClick={cancel}
              className="flex-1 bg-gray-100 text-gray-600 text-xs font-medium py-1.5 rounded-lg"
            >
              ✕
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-2xl font-bold text-gray-900 leading-none">
            {currentValue != null ? currentValue : <span className="text-gray-300">—</span>}
          </p>
          <p className="text-xs text-gray-400 mt-1">{unit}</p>
        </>
      )}
    </div>
  )
}

export default function Dashboard() {
  const { getToken } = useAuth()

  const [todayMeals,   setTodayMeals]   = useState(null)
  const [mealRows,     setMealRows]     = useState([])
  const [todayLog,     setTodayLog]     = useState(null)
  const [weekMeals,    setWeekMeals]    = useState(null)
  const [weekLog,      setWeekLog]      = useState(null)
  const [userProfile,  setUserProfile]  = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [katieBanner,  setKatieBanner]  = useState(null)
  const [gamData,      setGamData]      = useState(null)
  const [gamLoading,   setGamLoading]   = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }
        const today   = new Date().toLocaleDateString('sv')

        // Fire proactive check non-blocking, then fetch latest banner
        fetch(`${API_URL}/api/coach/check-proactive`, { method: 'POST', headers }).catch(() => {})

        const [r1, r2, r3, r4, r5, r6, r7, r8] = await Promise.all([
          fetch(`${API_URL}/api/meals/today?date=${today}`, { headers }),
          fetch(`${API_URL}/api/daily-logs/today`, { headers }),
          fetch(`${API_URL}/api/meals/week`,       { headers }),
          fetch(`${API_URL}/api/daily-logs/week`,  { headers }),
          fetch(`${API_URL}/api/users/me`,         { headers }),
          fetch(`${API_URL}/api/meals?date=${today}`, { headers }),
          fetch(`${API_URL}/api/coach/latest-proactive`, { headers }),
          fetch(`${API_URL}/api/gamification/me`,  { headers }),
        ])

        if (!r1.ok || !r2.ok || !r3.ok || !r4.ok || !r5.ok || !r6.ok) throw new Error('Failed to load dashboard data')

        if (!cancelled) {
          const [m, l, wm, wl, u, rows] = await Promise.all([r1.json(), r2.json(), r3.json(), r4.json(), r5.json(), r6.json()])
          setTodayMeals(m)
          setMealRows(rows)
          setTodayLog(l)
          setWeekMeals(wm)
          setWeekLog(wl)
          setUserProfile(u)
          if (r7.ok) {
            const bannerData = await r7.json()
            setKatieBanner(bannerData.message ?? null)
          }
          if (r8.ok) setGamData(await r8.json())
          setGamLoading(false)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) { setLoading(false); setGamLoading(false) }
      }
    }
    load()
    return () => { cancelled = true }
  }, [getToken])

  async function saveTracker(field, value) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/daily-logs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    })
    if (!res.ok) throw new Error('Failed to save')
    setTodayLog(await res.json())
  }

  const fmt   = (n) => n != null ? n.toLocaleString() : '—'
  const fmtG  = (n) => n != null ? `${n}g` : '—'
  const fmtLb = (n) => n != null ? `${n} lbs` : '—'

  const todayStats = [
    { label: 'Calories',  value: fmt(todayMeals?.total_calories), color: 'text-orange-500' },
    { label: 'Protein',   value: fmtG(todayMeals?.total_protein), color: 'text-blue-600' },
    { label: 'Carbs',     value: fmtG(todayMeals?.total_carbs),   color: 'text-yellow-500' },
    { label: 'Fat',       value: fmtG(todayMeals?.total_fat),     color: 'text-pink-500' },
    { label: 'Fiber',     value: fmtG(todayMeals?.total_fiber),   color: 'text-[#E8670A]' },
    { label: 'Water',     value: todayLog?.water_oz != null ? `${todayLog.water_oz} oz` : '—', color: 'text-cyan-500' },
    { label: 'Steps',     value: fmt(todayLog?.steps),            color: 'text-purple-500' },
  ]

  const weekStats = [
    { label: 'Avg Cal / day',     value: fmt(weekMeals?.avg_calories),                   color: 'text-orange-500' },
    { label: 'Avg Protein / day', value: fmtG(weekMeals?.avg_protein),                   color: 'text-blue-600' },
    { label: 'Avg Carbs / day',   value: fmtG(weekMeals?.avg_carbs),                     color: 'text-yellow-500' },
    { label: 'Avg Fat / day',     value: fmtG(weekMeals?.avg_fat),                       color: 'text-pink-500' },
    { label: 'Meals this week',   value: fmt(weekMeals?.meals_this_week),                color: 'text-[#E8670A]' },
    { label: 'Avg Water / day',   value: weekLog?.avg_water_oz != null ? `${weekLog.avg_water_oz} oz` : '—', color: 'text-cyan-500' },
    { label: 'Avg Steps / day',   value: fmt(weekLog?.avg_steps),                        color: 'text-purple-500' },
    { label: 'Avg Weight',        value: fmtLb(weekLog?.avg_weight),                     color: 'text-gray-700' },
  ]

  const trackers = [
    { label: 'Water',  unit: 'oz',    field: 'water_oz',   currentValue: todayLog?.water_oz },
    { label: 'Steps',  unit: 'steps', field: 'steps',      currentValue: todayLog?.steps },
    { label: 'Weight', unit: 'lbs',   field: 'weight_lbs', currentValue: todayLog?.weight_lbs },
  ]

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Dashboard</h1>
      <p className="text-sm text-gray-500 mb-4">Today's overview</p>

      {/* Gamification — compact rank/XP/streak bar */}
      <GamificationCard data={gamData} loading={gamLoading} />

      <KatieBanner message={katieBanner} onDismiss={() => setKatieBanner(null)} />

      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          Could not load data: {error}
        </div>
      )}

      {/* Daily Totals */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Today's Totals</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {todayStats.map((s) => (
          <StatCard key={s.label} label={s.label} value={loading ? '…' : s.value} color={s.color} />
        ))}
      </div>

      <div className="mb-8">
        <MicronutrientTotals meals={mealRows} loading={loading} title="Today's Micronutrients" periodLabel="Today" exclude={['fiber_g']} />
      </div>

      {!loading && todayMeals?.meal_count === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 text-center mb-8">
          <p className="text-gray-500 text-sm mb-4">No meals logged yet today.</p>
          <Link
            to="/log-meal"
            className="inline-block bg-[#E8670A] text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-[#c45e09] transition-colors"
          >
            Log your first meal
          </Link>
        </div>
      )}

      {/* Weight Journey */}
      {!loading && userProfile?.starting_weight_lbs != null && (
        <>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Weight Journey</h2>
          <div className="grid grid-cols-3 gap-3 mb-8">
            <StatCard
              label="Starting Weight"
              value={`${userProfile.starting_weight_lbs} lbs`}
              color="text-gray-700"
            />
            <StatCard
              label="Current Weight"
              value={
                todayLog?.weight_lbs != null
                  ? `${todayLog.weight_lbs} lbs`
                  : weekLog?.avg_weight != null
                    ? `${weekLog.avg_weight} lbs`
                    : '—'
              }
              color="text-purple-500"
            />
            <StatCard
              label="Total Lost"
              value={(() => {
                const current = todayLog?.weight_lbs ?? weekLog?.avg_weight
                if (current == null) return '—'
                const lost = (userProfile.starting_weight_lbs - current).toFixed(1)
                return `${lost} lbs`
              })()}
              color="text-[#E8670A]"
            />
          </div>
        </>
      )}

      {/* Goals */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Your Goals</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Goal Calories', value: userProfile?.goal_calories != null ? userProfile.goal_calories.toLocaleString() : '—', color: 'text-orange-500' },
          { label: 'Goal Protein',  value: userProfile?.goal_protein  != null ? `${userProfile.goal_protein}g`  : '—', color: 'text-blue-600' },
          { label: 'Goal Carbs',    value: userProfile?.goal_carbs    != null ? `${userProfile.goal_carbs}g`    : '—', color: 'text-yellow-500' },
          { label: 'Goal Fat',      value: userProfile?.goal_fat      != null ? `${userProfile.goal_fat}g`      : '—', color: 'text-pink-500' },
        ].map(s => (
          <StatCard key={s.label} label={s.label} value={loading ? '…' : s.value} color={s.color} sub="set by coach" />
        ))}
      </div>

      {/* Daily Tracking inputs */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Log Today</h2>
      <div className="grid grid-cols-3 gap-3 mb-10">
        {trackers.map((t) => (
          <TrackerCard
            key={t.field}
            label={t.label}
            unit={t.unit}
            field={t.field}
            currentValue={loading ? null : t.currentValue}
            onSave={saveTracker}
          />
        ))}
      </div>

      {/* Weekly Summary */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">This Week</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {weekStats.map((s) => (
          <StatCard key={s.label} label={s.label} value={loading ? '…' : s.value} color={s.color} />
        ))}
      </div>
    </div>
  )
}
