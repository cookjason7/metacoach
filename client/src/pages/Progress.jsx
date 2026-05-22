import { useState, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

const RANGES = [
  { key: '30d', label: '30 Days' },
  { key: '90d', label: '90 Days' },
  { key: '6m',  label: '6 Months' },
]

function fmtSleep(mins) {
  if (mins == null) return '—'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function fmtNum(v, dec = 0) {
  if (v == null) return '—'
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: dec })
}

function Sparkline({ data, goalValue }) {
  if (!data || data.length < 2) return null

  const values = data.map(d => Number(d.value))
  const allVals = goalValue != null ? [...values, Number(goalValue)] : values
  const minV = Math.min(...allVals)
  const maxV = Math.max(...allVals)
  const span  = maxV - minV || 1

  const W = 400, H = 72, PX = 6, PY = 6
  const xs = i => PX + (i / (data.length - 1)) * (W - PX * 2)
  const ys = v => H - PY - ((Number(v) - minV) / span) * (H - PY * 2)

  const pts  = data.map((d, i) => `${xs(i)},${ys(d.value)}`).join(' ')
  const fill = `M${xs(0)},${ys(data[0].value)} ` +
    data.slice(1).map((d, i) => `L${xs(i + 1)},${ys(d.value)}`).join(' ') +
    ` L${xs(data.length - 1)},${H} L${xs(0)},${H} Z`
  const last = data[data.length - 1]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" aria-hidden="true">
      {goalValue != null && (
        <line
          x1={PX} y1={ys(goalValue)} x2={W - PX} y2={ys(goalValue)}
          stroke="#d1d5db" strokeWidth="1.5" strokeDasharray="5 3"
        />
      )}
      <path d={fill} fill="#E8670A" fillOpacity="0.08" />
      <polyline
        fill="none" stroke="#E8670A" strokeWidth="2.5"
        strokeLinejoin="round" strokeLinecap="round" points={pts}
      />
      <circle cx={xs(data.length - 1)} cy={ys(last.value)} r="4" fill="#E8670A" />
    </svg>
  )
}

function ChartCard({ title, data, goalValue, goalLabel, emptyMsg, fmtVal }) {
  const values  = data?.filter(d => d.value != null).map(d => Number(d.value)) ?? []
  const hasData = values.length >= 2

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        {goalValue != null && (
          <span className="text-xs text-gray-400">Goal: {goalLabel ?? fmtNum(goalValue)}</span>
        )}
      </div>
      {hasData ? (
        <>
          <div className="flex justify-between text-[10px] text-gray-400 mb-0.5">
            <span>{fmtVal ? fmtVal(Math.min(...values)) : fmtNum(Math.min(...values))}</span>
            <span>{fmtVal ? fmtVal(Math.max(...values)) : fmtNum(Math.max(...values))}</span>
          </div>
          <Sparkline data={data} goalValue={goalValue} />
        </>
      ) : (
        <div className="flex items-center justify-center h-14 text-xs text-gray-400 italic">
          {emptyMsg ?? 'Log more data to see your trend'}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, sub, valueClass }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-col gap-0.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-xl font-bold truncate ${valueClass ?? 'text-gray-900'}`}>{value ?? '—'}</span>
      {sub && <span className="text-xs text-gray-400 leading-tight">{sub}</span>}
    </div>
  )
}

export default function Progress() {
  const { getToken } = useAuth()
  const [range,   setRange]   = useState('30d')
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const token = await getToken()
        const res   = await fetch(`${API_URL}/api/daily-logs/progress?range=${range}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error()
        const json = await res.json()
        if (!cancelled) setData(json)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [range, getToken])

  const s = data?.summary ?? {}

  const rangeLabel = range === '90d' ? '90-day' : range === '6m' ? '6-month' : '30-day'

  const wtChange = s.weight_change
  const wtChangeStr = wtChange != null
    ? `${wtChange > 0 ? '+' : ''}${wtChange} lbs this ${rangeLabel.replace('-', ' ')}`
    : null
  const wtChangeClass = wtChange != null && wtChange < 0
    ? 'text-green-600'
    : wtChange != null && wtChange > 0
      ? 'text-amber-600'
      : 'text-gray-500'

  const hasSodium = Number(s.total_sodium_mg) > 0 || Number(s.avg_sodium_7d) > 0
  const sodiumSeries = data?.macro_series?.some(d => Number(d.sodium_mg) > 0)
    ? data.macro_series.map(d => ({ date: d.date, value: d.sodium_mg }))
    : null

  return (
    <div className="w-full max-w-2xl mx-auto pb-8">

      {/* Header + range picker */}
      <div className="flex items-start sm:items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold text-gray-900">My Progress</h1>
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 shrink-0">
          {RANGES.map(r => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors min-h-[36px] ${
                range === r.key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <span className="text-sm text-gray-400">Loading…</span>
        </div>
      )}

      {error && !loading && (
        <div className="text-sm text-red-500 text-center py-8">
          Could not load progress data. Please try again.
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* ── Summary cards ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            <StatCard
              label="Current Weight"
              value={s.weight_current ? `${s.weight_current} lbs` : '—'}
              sub={wtChangeStr ?? 'No weight logged'}
              valueClass={s.weight_change < 0 ? 'text-green-600' : 'text-gray-900'}
            />
            <StatCard
              label="Avg Steps"
              value={s.avg_steps ? fmtNum(s.avg_steps) : '—'}
              sub="per day"
            />
            <StatCard
              label="Avg Sleep"
              value={s.avg_sleep_minutes ? fmtSleep(Number(s.avg_sleep_minutes)) : '—'}
              sub="per night"
            />
            <StatCard
              label="Avg Calories"
              value={s.avg_calories ? fmtNum(s.avg_calories) : '—'}
              sub={s.goal_calories ? `Goal: ${fmtNum(s.goal_calories)}` : 'per day'}
            />
            <StatCard
              label="Avg Protein"
              value={s.avg_protein ? `${s.avg_protein}g` : '—'}
              sub={s.goal_protein ? `Goal: ${s.goal_protein}g` : 'per day'}
            />
            <StatCard
              label="Workouts & Activity"
              value={s.total_activity ?? '—'}
              sub={`over ${rangeLabel}`}
            />
            <StatCard
              label="Sodium (7-day avg)"
              value={s.avg_sodium_7d ? `${fmtNum(s.avg_sodium_7d)} mg` : '—'}
              sub="daily average"
            />
            {Number(s.total_sodium_mg) > 0 && (
              <StatCard
                label={`Total Sodium (${rangeLabel})`}
                value={`${fmtNum(s.total_sodium_mg)} mg`}
                sub="from logged meals"
              />
            )}
          </div>

          {/* ── Charts ────────────────────────────────────────────────────── */}
          <div className="space-y-4 mb-6">
            <ChartCard
              title="Weight (lbs)"
              data={data.weight_series}
              fmtVal={v => `${v} lbs`}
              emptyMsg="Log your weight to see your trend"
            />
            <ChartCard
              title="Daily Steps"
              data={data.step_series}
              fmtVal={v => fmtNum(v)}
              emptyMsg="Log steps to see your trend"
            />
            <ChartCard
              title="Sleep"
              data={data.sleep_series}
              fmtVal={v => fmtSleep(v)}
              emptyMsg="Log sleep to see your trend"
            />
            <ChartCard
              title="Calories"
              data={data.macro_series?.map(d => ({ date: d.date, value: d.calories }))}
              goalValue={s.goal_calories || null}
              goalLabel={s.goal_calories ? `${fmtNum(s.goal_calories)} kcal` : null}
              fmtVal={v => fmtNum(v)}
              emptyMsg="Log meals to see calorie trend"
            />
            <ChartCard
              title="Protein (g)"
              data={data.macro_series?.map(d => ({ date: d.date, value: d.protein }))}
              goalValue={s.goal_protein || null}
              goalLabel={s.goal_protein ? `${s.goal_protein}g` : null}
              fmtVal={v => `${v}g`}
              emptyMsg="Log meals to see protein trend"
            />
            {sodiumSeries && (
              <ChartCard
                title="Sodium (mg)"
                data={sodiumSeries}
                fmtVal={v => `${fmtNum(v)} mg`}
                emptyMsg="No sodium data in logged meals"
              />
            )}
          </div>

          {/* ── Progress photos ───────────────────────────────────────────── */}
          <div>
            <h2 className="text-base font-semibold text-gray-800 mb-3">Progress Photos</h2>
            {!data.progress_photos?.length ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
                <p className="text-3xl mb-2">📸</p>
                <p className="text-sm font-semibold text-gray-700 mb-1">No photos yet</p>
                <p className="text-xs text-gray-400">
                  Use the + Log button to upload a progress photo
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {data.progress_photos.map(session => {
                  const photo = session.photos.front ?? session.photos.side ?? session.photos.back
                  if (!photo) return null
                  return (
                    <div key={session.session_id} className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
                      <img
                        src={photo.photo_url}
                        alt="Progress"
                        className="w-full aspect-[3/4] object-contain bg-gray-50"
                        loading="lazy"
                      />
                      <div className="px-2 py-2">
                        <p className="text-xs text-gray-500">
                          {new Date(session.session_date).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                          })}
                        </p>
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {['front', 'side', 'back'].map(angle =>
                            session.photos[angle] ? (
                              <span key={angle} className="text-[10px] bg-gray-100 text-gray-500 rounded px-1.5 py-0.5 capitalize">
                                {angle}
                              </span>
                            ) : null
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
