import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config.js'
import { useOrgBranding } from '../context/OrgBrandingContext.jsx'
import { useViewMode } from '../context/ViewModeContext.jsx'
import CoachDashboard from './CoachDashboard'

// ── Stage colours ─────────────────────────────────────────────────────────────

const STAGE_COLORS = {
  'Starting Strong':     ['bg-sky-50',     'text-sky-700'],
  'Momentum Builder':    ['bg-violet-50',  'text-violet-700'],
  'Self-Trust Builder':  ['bg-blue-50',    'text-blue-700'],
  'Consistency Warrior': ['bg-emerald-50', 'text-emerald-700'],
  'Resilient Warrior':   ['bg-amber-50',   'text-amber-700'],
  'Life Warrior':        ['bg-orange-50',  'text-[#c45e09]'],
}

// ── Compact Identity / Momentum Card ─────────────────────────────────────────

function MomentumCard({ data, loading }) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 mb-4 p-4 animate-pulse">
        <div className="flex items-center justify-between mb-2">
          <div className="h-4 bg-gray-100 rounded w-36" />
          <div className="h-5 w-20 bg-gray-100 rounded-full" />
        </div>
        <div className="flex gap-1.5 mb-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-5 w-16 bg-gray-100 rounded-full" />)}
        </div>
        <div className="h-3 bg-gray-100 rounded w-52" />
      </div>
    )
  }
  if (!data) return null

  const stage = data.identity_stage ?? 'Starting Strong'
  const [stageBg, stageText] = STAGE_COLORS[stage] ?? ['bg-gray-50', 'text-gray-700']

  return (
    <div className="bg-white rounded-2xl border border-gray-200 mb-4 px-4 pt-3.5 pb-4">

      {/* Stage name + week badge */}
      <div className="flex items-start justify-between gap-2 mb-2.5">
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest leading-none mb-0.5">
            Identity Stage
          </p>
          <p className="text-sm font-bold text-gray-900">{stage}</p>
        </div>
        <span className={`shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full ${stageBg} ${stageText}`}>
          Week {data.active_weeks ?? 0}
        </span>
      </div>

      {/* Category badges */}
      {data.categories?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2.5">
          {data.categories.map(c => (
            <span
              key={c.key}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                c.active ? 'bg-[#fde8c8] text-[#c45e09]' : 'bg-gray-100 text-gray-400'
              }`}
            >
              {c.icon} {c.label}
            </span>
          ))}
        </div>
      )}

      {/* Coaching line — hide noisy auto-generated sentences */}
      {(() => {
        const FILTERED = new Set([
          "Coming back is a choice — and you made it. That's self-trust in action.",
          "Every Life Warrior starts with a single consistent week. This is yours.",
        ])
        const desc = data.stage_description ?? data.message
        if (desc && !FILTERED.has(desc)) {
          return <p className="text-xs text-gray-500 leading-relaxed">{desc}</p>
        }
        return null
      })()}
    </div>
  )
}

// ── Goal Progress Rings ───────────────────────────────────────────────────────

function fmtRingVal(n) {
  if (n == null) return '—'
  const v = Math.round(n)
  if (v >= 10000) return `${Math.round(v / 1000)}k`
  if (v >= 1000)  return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(v)
}

function GoalRing({ label, current, goal, color, unit, dim = 68 }) {
  const cx     = dim / 2
  const r      = cx - 7
  const sw     = 6
  const circ   = 2 * Math.PI * r
  const pct    = (goal > 0 && current != null) ? Math.min(current / goal, 1) : 0
  const offset = circ * (1 - pct)
  const done   = goal > 0 && current != null && current >= goal
  const hasGoal = goal > 0

  const valSize = dim <= 64 ? 11 : 12
  const lblSize = dim <= 64 ? 10 : 11

  return (
    <div className="flex flex-col items-center" style={{ gap: 4 }}>
      <div className="relative" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={cx} cy={cx} r={r} fill="none" stroke="#f3f4f6" strokeWidth={sw} />
          {hasGoal ? (
            <circle
              cx={cx} cy={cx} r={r} fill="none"
              stroke={done ? '#22c55e' : color}
              strokeWidth={sw} strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={offset}
              style={{ transition: 'stroke-dashoffset 0.6s ease' }}
            />
          ) : (
            <circle
              cx={cx} cy={cx} r={r} fill="none"
              stroke={color} strokeWidth={sw} strokeLinecap="round"
              strokeDasharray={`${circ * 0.25} ${circ}`} opacity="0.3"
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ gap: 2 }}>
          <span style={{ fontSize: valSize, fontWeight: 700, color: '#111827', lineHeight: 1 }}>
            {fmtRingVal(current)}
          </span>
          {unit && (
            <span style={{ fontSize: 8, color: '#9ca3af', lineHeight: 1 }}>{unit}</span>
          )}
        </div>
      </div>
      <div className="text-center">
        <p style={{ fontSize: lblSize, fontWeight: 600, color: '#4b5563', lineHeight: 1.3 }}>{label}</p>
        {hasGoal && (
          <p style={{ fontSize: 9, color: '#9ca3af', lineHeight: 1.2 }}>/ {fmtRingVal(goal)}</p>
        )}
      </div>
    </div>
  )
}

// Returns which nutrition-target mode is active based on set goals.
// Mirrors the 3 modes in the coach's Nutrition Targets card.
function nutritionMode(userProfile) {
  const hasProtein = (userProfile?.goal_protein ?? 0) > 0
  const hasCarbs   = (userProfile?.goal_carbs   ?? 0) > 0
  const hasFat     = (userProfile?.goal_fat     ?? 0) > 0
  if (hasCarbs || hasFat) return 'full_macros'
  if (hasProtein)         return 'calories_protein'
  return 'calories_only'
}

function TodayGoals({ userProfile, todayMeals, loading, label, onStepBack }) {
  const mode = nutritionMode(userProfile)

  const macroRings = {
    calories: { label: 'Calories', current: todayMeals?.total_calories ?? 0, goal: userProfile?.goal_calories ?? 0, color: '#f97316', unit: 'cal' },
    protein:  { label: 'Protein',  current: todayMeals?.total_protein  ?? 0, goal: userProfile?.goal_protein  ?? 0, color: '#3b82f6', unit: 'g'   },
    carbs:    { label: 'Carbs',    current: todayMeals?.total_carbs    ?? 0, goal: userProfile?.goal_carbs    ?? 0, color: '#eab308', unit: 'g'   },
    fat:      { label: 'Fat',      current: todayMeals?.total_fat      ?? 0, goal: userProfile?.goal_fat      ?? 0, color: '#ec4899', unit: 'g'   },
  }

  const rings =
    mode === 'full_macros'      ? [macroRings.calories, macroRings.protein, macroRings.carbs, macroRings.fat] :
    mode === 'calories_protein' ? [macroRings.calories, macroRings.protein] :
    /* calories_only */           [macroRings.calories]

  if (loading) {
    // Default skeleton: 2 circles while data loads
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 animate-pulse">
        <div className="h-4 bg-gray-100 rounded w-28 mb-4" />
        <div className="grid grid-cols-2 gap-3 max-w-[200px] mx-auto justify-items-center">
          {[0, 1].map(i => (
            <div key={i} className="flex flex-col items-center gap-1.5">
              <div className="rounded-full bg-gray-100" style={{ width: 80, height: 80 }} />
              <div className="h-2.5 bg-gray-100 rounded w-10" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 cursor-pointer active:opacity-80"
      onClick={onStepBack}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStepBack() } }}
      title="Tap to view the previous day"
    >
      <h2 className="text-sm font-bold text-gray-900 mb-4">{label}</h2>
      {rings.length === 1 ? (
        <div className="flex justify-center py-1">
          <GoalRing {...rings[0]} dim={92} />
        </div>
      ) : rings.length === 2 ? (
        <div className="grid grid-cols-2 gap-6 max-w-[220px] mx-auto justify-items-center">
          {rings.map(ring => <GoalRing key={ring.label} {...ring} dim={80} />)}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-y-5 gap-x-1 justify-items-center">
          {rings.map(ring => <GoalRing key={ring.label} {...ring} dim={68} />)}
        </div>
      )}
    </div>
  )
}

// ── AI Coach Banner ───────────────────────────────────────────────────────────

function KatieBanner({ message, onDismiss }) {
  const { aiCoachName, coachTitle } = useOrgBranding()
  if (!message) return null
  const coachInitial = (aiCoachName ?? '').replace(/^coach\s+/i, '').trim().charAt(0).toUpperCase() || 'C'
  return (
    <Link
      to="/ai-coach"
      className="flex items-start gap-3 bg-[#fff7ed] border border-[#fed7aa] rounded-xl px-4 py-3 mb-4 group hover:bg-[#ffedd5] transition-colors"
      onClick={onDismiss}
    >
      <div className="w-8 h-8 rounded-full bg-[#fde8c8] flex items-center justify-center text-[#E8670A] font-bold text-xs shrink-0 mt-0.5">
        {coachInitial}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-[#E8670A] mb-0.5">New message from {coachTitle}</p>
        <p className="text-sm text-gray-700 line-clamp-2">{message}</p>
      </div>
      <svg className="w-4 h-4 text-[#E8670A] shrink-0 mt-1 group-hover:translate-x-0.5 transition-transform" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  )
}

// ── Today's Stats Strip ───────────────────────────────────────────────────────
// Shows steps, sleep, and water when any of them have data.
// Appears between Today's Goals and Today's Habits so synced Apple Health data
// is immediately visible on the home screen.

function fmtSleepMins(mins) {
  if (mins == null) return null
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m > 0 ? m + 'm' : ''}`.trim() : `${m}m`
}

// Truncates a note for inline display under a metric value (static text, no interaction).
function truncateNote(note, max = 30) {
  const text = String(note ?? '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// `note`, when present, renders as small static italic text under the value —
// always visible, no click/interaction.
function StatPill({ icon, label, value, note }) {
  return (
    <div className="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2.5 min-w-0">
      <span className="text-base shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide leading-none mb-0.5">{label}</p>
        <p className="text-sm font-bold text-gray-800 leading-none truncate">{value}</p>
        {note && (
          <p className="text-[10px] text-gray-400 italic mt-1 truncate" title={note}>
            {truncateNote(note)}
          </p>
        )}
      </div>
    </div>
  )
}

function TodayStatsStrip({ todayLog, label, onStepBack }) {
  const steps    = todayLog?.steps           != null ? todayLog.steps           : null
  const sleep    = todayLog?.sleep_minutes   != null ? fmtSleepMins(todayLog.sleep_minutes) : null
  const water    = todayLog?.water_oz        != null ? `${todayLog.water_oz} oz` : null
  const weight   = todayLog?.weight_lbs      != null ? `${todayLog.weight_lbs} lb` : null
  const calories = todayLog?.calories_burned != null ? todayLog.calories_burned : null

  if (steps == null && sleep == null && water == null && weight == null && calories == null) return null

  return (
    <div
      className="bg-white rounded-2xl border border-gray-200 p-4 mb-4 cursor-pointer active:opacity-80"
      onClick={onStepBack}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStepBack() } }}
      title="Tap to view the previous day"
    >
      <h2 className="text-sm font-bold text-gray-900 mb-3">{label}</h2>
      <div className="flex flex-wrap gap-2">
        {steps    != null && <StatPill icon="👟" label="Steps"        value={steps.toLocaleString()} />}
        {calories != null && <StatPill icon="🔥" label="Cal Burned"   value={calories.toLocaleString()} />}
        {water    != null && <StatPill icon="💧" label="Water"        value={water} note={todayLog?.water_note} />}
        {weight   != null && <StatPill icon="⚖️" label="Weight"       value={weight} note={todayLog?.weight_note} />}
        {sleep    != null && <StatPill icon="😴" label="Sleep"        value={sleep} note={todayLog?.sleep_note} />}
      </div>
    </div>
  )
}

// Local (not UTC-shifted) YYYY-MM-DD for a given Date object.
function toLocalDateStr(d) {
  return d.toLocaleDateString('sv')
}

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + delta)
  return toLocalDateStr(d)
}

// ── Date Picker Sheet ─────────────────────────────────────────────────────────
// Compact calendar restricted to [minDate, maxDate]. Bottom sheet on mobile,
// centered modal on desktop — matches the app's existing modal pattern
// (see Calendar.jsx / MealHistory.jsx / Settings.jsx).

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function DatePickerSheet({ selectedDate, minDate, maxDate, onSelect, onClose }) {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date(`${selectedDate}T00:00:00`)
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  const monthLabel = viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const firstWeekday = viewMonth.getDay()
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate()

  const cells = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]

  function cellDateStr(day) {
    return toLocalDateStr(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day))
  }

  const minMonthKey = minDate.slice(0, 7)
  const maxMonthKey = maxDate.slice(0, 7)
  const viewMonthKey = `${viewMonth.getFullYear()}-${String(viewMonth.getMonth() + 1).padStart(2, '0')}`
  const prevDisabled = viewMonthKey <= minMonthKey
  const nextDisabled = viewMonthKey >= maxMonthKey

  function goPrevMonth() { if (!prevDisabled) setViewMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1)) }
  function goNextMonth() { if (!nextDisabled) setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1)) }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm max-h-[92vh] flex flex-col overflow-hidden shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <p className="text-sm font-semibold text-gray-900">Jump to a date</p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 -mr-2 flex items-center justify-center text-gray-400 hover:text-gray-600 text-lg leading-none shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-4">
          {/* Month nav */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={goPrevMonth}
              disabled={prevDisabled}
              aria-label="Previous month"
              className={`w-11 h-11 flex items-center justify-center rounded-lg transition-colors ${
                prevDisabled ? 'text-gray-200 cursor-not-allowed' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <p className="text-sm font-semibold text-gray-900">{monthLabel}</p>
            <button
              onClick={goNextMonth}
              disabled={nextDisabled}
              aria-label="Next month"
              className={`w-11 h-11 flex items-center justify-center rounded-lg transition-colors ${
                nextDisabled ? 'text-gray-200 cursor-not-allowed' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAY_LABELS.map((w, i) => (
              <div key={i} className="h-8 flex items-center justify-center text-[11px] font-semibold text-gray-400">
                {w}
              </div>
            ))}
          </div>

          {/* Day grid — each cell is a 44px+ tap target */}
          <div className="grid grid-cols-7 gap-y-1">
            {cells.map((day, i) => {
              if (day == null) return <div key={i} className="h-11" />
              const ds = cellDateStr(day)
              const disabled = ds < minDate || ds > maxDate
              const isSelected = ds === selectedDate
              return (
                <div key={i} className="h-11 flex items-center justify-center">
                  <button
                    onClick={() => { if (!disabled) onSelect(ds) }}
                    disabled={disabled}
                    className={`w-9 h-9 flex items-center justify-center rounded-full text-sm font-medium transition-colors ${
                      disabled
                        ? 'text-gray-200 cursor-not-allowed'
                        : isSelected
                          ? 'bg-[#f97316] text-white'
                          : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    {day}
                  </button>
                </div>
              )
            })}
          </div>

          <p className="text-[11px] text-gray-400 mt-3 text-center">
            You can view up to 30 days of history.
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { getToken } = useAuth()
  const { viewing, viewedClient } = useViewMode()

  const todayStr = toLocalDateStr(new Date())
  const minPickerDate = addDays(todayStr, -30)

  const [selectedDate, setSelectedDate] = useState(todayStr)
  const [pickerOpen,  setPickerOpen]  = useState(false)
  const [todayMeals,  setTodayMeals]  = useState(null)
  const [todayLog,    setTodayLog]    = useState(null)
  const [userProfile, setUserProfile] = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [katieBanner, setKatieBanner] = useState(null)
  const [gamData,     setGamData]     = useState(null)
  const [gamLoading,  setGamLoading]  = useState(true)

  const isToday = selectedDate === todayStr

  // Loads user profile, Katie banner, and gamification momentum — these are
  // always "today" concepts and don't vary with the selected date.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }

        fetch(`${API_URL}/api/coach/check-proactive`, { method: 'POST', headers }).catch(() => {})

        const [r3, r4, r5] = await Promise.all([
          fetch(`${API_URL}/api/users/me`,               { headers }),  // userProfile
          fetch(`${API_URL}/api/coach/latest-proactive`, { headers }),  // katie banner
          fetch(`${API_URL}/api/gamification/momentum`,  { headers }),  // gamData
        ])

        if (!r3.ok) throw new Error('Failed to load dashboard data')

        if (!cancelled) {
          const profile = await r3.json()
          // /api/users/me is never view-as aware (Build A deliberately excluded
          // it — see server-side Settings.jsx audit), so it always returns the
          // STAFF member's own row here, not the viewed client's. Their goal_*
          // fields would otherwise show empty rings for a client who has real
          // goals set. viewedClient carries a same-session snapshot captured
          // when "View as this client" was clicked (see ClientProfile.jsx).
          setUserProfile(viewing && viewedClient ? { ...profile, ...viewedClient } : profile)
          if (r4.ok) setKatieBanner((await r4.json()).message ?? null)
          if (r5.ok) setGamData(await r5.json())
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setGamLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [getToken])

  // Loads meals + daily log for the selected date. Re-runs on date navigation
  // (tap-through tiles, forward/back-to-today, or the calendar picker).
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        setLoading(true)
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }

        const [r1, r2] = await Promise.all([
          fetch(`${API_URL}/api/meals/today?date=${selectedDate}`,      { headers }),  // todayMeals
          fetch(`${API_URL}/api/daily-logs/today?date=${selectedDate}`, { headers }),  // todayLog
        ])

        if (!r1.ok || !r2.ok) throw new Error('Failed to load dashboard data')

        if (!cancelled) {
          const [m, l] = await Promise.all([r1.json(), r2.json()])
          setTodayMeals(m)
          setTodayLog(l)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [getToken, selectedDate])

  useEffect(() => {
    // Merge the incoming fields — never replace the whole object, or we lose
    // water_oz / weight_lbs that weren't part of the Apple Health sync payload.
    // Only applies to the live "today" view — past-date views must not be
    // overwritten by updates meant for today.
    function onUpdate(e) {
      if (!isToday) return
      if (e.detail) setTodayLog(prev => prev ? { ...prev, ...e.detail } : e.detail)
    }
    window.addEventListener('daily-log-updated', onUpdate)
    return () => window.removeEventListener('daily-log-updated', onUpdate)
  }, [isToday])

  function stepBack() { setSelectedDate(d => addDays(d, -1)) }
  function stepForward() { setSelectedDate(d => (d < todayStr ? addDays(d, 1) : d)) }
  function backToToday() { setSelectedDate(todayStr) }

  const selectedDateObj = new Date(`${selectedDate}T00:00:00`)
  const headerLabel = isToday
    ? 'Today'
    : selectedDateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const selectedDayOfWeek = selectedDateObj.getDay()
  const isWeekend = selectedDayOfWeek === 0 || selectedDayOfWeek === 6
  const weekdayAbbrev = selectedDateObj.toLocaleDateString('en-US', { weekday: 'short' })
  const numericDate = selectedDateObj.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })

  // Staff → coaching dashboard (also covers 'va', a scoped onboarding-only role).
  // Skipped entirely while viewing — a staff member "viewing as" a client must
  // see the client dashboard below, not their own coaching view.
  if (!viewing && !loading && (userProfile?.role === 'admin' || userProfile?.role === 'account_owner' || userProfile?.role === 'coach' || userProfile?.role === 'staff' || userProfile?.role === 'va')) {
    return <CoachDashboard getToken={getToken} userRole={userProfile.role} />
  }

  return (
    <div>

      {/* Header — date label + tap-through nav + calendar picker, with shortcut buttons */}
      <div className="mb-4 flex justify-between items-start">
        <div>
          <div className="flex items-center gap-1">
            <button
              onClick={stepBack}
              aria-label="Previous day"
              className="w-11 h-11 -ml-2 flex items-center justify-center text-gray-400 hover:text-gray-700 active:opacity-70 transition-colors shrink-0"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-2xl font-bold text-gray-900">{headerLabel}</h1>
            <button
              onClick={() => setPickerOpen(true)}
              aria-label="Pick a date"
              className="w-11 h-11 flex items-center justify-center text-gray-400 hover:text-gray-700 active:opacity-70 transition-colors shrink-0"
            >
              <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <rect x="3" y="5" width="18" height="16" rx="2" strokeLinecap="round" strokeLinejoin="round" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M8 3v4M16 3v4" />
              </svg>
            </button>
            {!isToday && (
              <button
                onClick={stepForward}
                aria-label="Next day"
                className="w-11 h-11 flex items-center justify-center text-gray-400 hover:text-gray-700 active:opacity-70 transition-colors shrink-0"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
          <p className="text-sm mt-0.5">
            <span className={`block font-semibold ${isWeekend ? 'text-[#f97316]' : 'text-gray-500'}`}>
              {weekdayAbbrev}
            </span>
            <span className="text-gray-400">{numericDate}</span>
          </p>
          {!isToday && (
            <button
              onClick={backToToday}
              className="text-sm font-medium text-[#f97316] mt-0.5 hover:underline"
            >
              Back to Today
            </button>
          )}
        </div>

        {/* Shortcut buttons */}
        <div className="flex gap-5">
          {/* Supps button */}
          <button
            onClick={() => window.open('https://store.lwcvip.com', '_blank')}
            className="w-12 flex flex-col items-center justify-center gap-1.5 cursor-pointer hover:opacity-75 transition-opacity"
          >
            <span style={{ fontSize: '20px', lineHeight: 1 }}>💊</span>
            <span className="text-[10px] text-gray-500 font-medium leading-none">Supps</span>
          </button>

          {/* Wellness button */}
          <button
            onClick={() => window.open('https://altroapp.com/lifewarrior', '_blank')}
            className="w-12 flex flex-col items-center justify-center gap-1.5 cursor-pointer hover:opacity-75 transition-opacity"
          >
            <span style={{ fontSize: '20px', lineHeight: 1 }}>🩺</span>
            <span className="text-[10px] text-gray-500 font-medium leading-none">Wellness</span>
          </button>
        </div>
      </div>

      {/* Identity card */}
      <MomentumCard data={gamData} loading={gamLoading} />

      {/* Coach Katie banner */}
      <KatieBanner message={katieBanner} onDismiss={() => setKatieBanner(null)} />

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          Could not load data: {error}
        </div>
      )}

      {/* Circular goal progress rings — nutrition targets only.
          Tap the card to step back a day (matches TodayStatsStrip below). */}
      <TodayGoals
        userProfile={userProfile}
        todayMeals={todayMeals}
        loading={loading}
        label={isToday ? "Today's Goals" : `${headerLabel}'s Goals`}
        onStepBack={stepBack}
      />

      {/* Steps / water / weight / sleep strip — visible when any metric has data.
          Driven by todayLog; live-synced only while viewing today.
          Tap the card to step back a day. */}
      <TodayStatsStrip todayLog={todayLog} label={headerLabel} onStepBack={stepBack} />

      {pickerOpen && (
        <DatePickerSheet
          selectedDate={selectedDate}
          minDate={minPickerDate}
          maxDate={todayStr}
          onSelect={ds => { setSelectedDate(ds); setPickerOpen(false) }}
          onClose={() => setPickerOpen(false)}
        />
      )}

    </div>
  )
}
