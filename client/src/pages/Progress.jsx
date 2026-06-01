import { useState, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

const RANGES = [
  { key: '30d', label: '30 Days', summaryLabel: '30-day' },
  { key: '90d', label: '90 Days', summaryLabel: '90-day' },
  { key: '6m',  label: '6 Months', summaryLabel: '6-month' },
  { key: 'custom', label: 'Custom', summaryLabel: 'custom range' },
]

const MEASUREMENT_FIELDS = [
  { key: 'waist', label: 'Waist' },
  { key: 'hips',  label: 'Hips' },
  { key: 'chest', label: 'Chest' },
]

function localIso(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function todayIso() {
  return localIso()
}

function daysAgoIso(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return localIso(d)
}

function fmtSleep(mins) {
  if (mins == null) return '-'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function fmtNum(v, dec = 0) {
  if (v == null) return '-'
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: dec })
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
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

function ChartCard({ title, data, goalValue, goalLabel, fmtVal }) {
  const cleanData = data?.filter(d => d.value != null && Number.isFinite(Number(d.value))) ?? []
  const values = cleanData.map(d => Number(d.value))
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
          <Sparkline data={cleanData} goalValue={goalValue} />
        </>
      ) : (
        <div className="flex items-center justify-center h-14 text-xs text-gray-400 italic">
          Need 2+ entries to chart progress.
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, sub, valueClass }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-col gap-0.5">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-xl font-bold truncate ${valueClass ?? 'text-gray-900'}`}>{value ?? '-'}</span>
      {sub && <span className="text-xs text-gray-400 leading-tight">{sub}</span>}
    </div>
  )
}

function MeasurementCard({ field, measurements }) {
  const withValue = measurements
    .filter(m => m[field.key] != null && m[field.key] !== '')
    .sort((a, b) => String(a.measurement_date).localeCompare(String(b.measurement_date)))
  const first = withValue[0]
  const latest = withValue[withValue.length - 1]
  const delta = first && latest && first.id !== latest.id
    ? +(Number(latest[field.key]) - Number(first[field.key])).toFixed(1)
    : null
  const trend = withValue.map(m => ({ date: m.measurement_date, value: Number(m[field.key]) }))

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">{field.label}</h3>
          <p className="text-xs text-gray-400">
            {latest ? `Latest: ${fmtDate(latest.measurement_date)}` : 'No entry yet'}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold text-gray-900">
            {latest ? `${Number(latest[field.key]).toFixed(1)}"` : '-'}
          </p>
          {delta != null && (
            <p className={`text-xs font-semibold ${delta < 0 ? 'text-green-600' : delta > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
              {delta > 0 ? '+' : ''}{delta}"
            </p>
          )}
        </div>
      </div>
      {trend.length >= 2 ? (
        <Sparkline data={trend} />
      ) : (
        <div className="flex items-center justify-center h-14 text-xs text-gray-400 italic">
          Need 2+ entries to chart progress.
        </div>
      )}
    </div>
  )
}

function MeasurementsSection({ measurements, rangeLabel, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ measurement_date: '', chest: '', waist: '', hips: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function startEdit(m) {
    setEditing(m.id)
    setError('')
    setForm({
      measurement_date: String(m.measurement_date).slice(0, 10),
      chest: m.chest ?? '',
      waist: m.waist ?? '',
      hips: m.hips ?? '',
    })
  }

  async function saveEdit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await onUpdate(editing, {
        measurement_date: form.measurement_date,
        chest: form.chest !== '' ? Number(form.chest) : null,
        waist: form.waist !== '' ? Number(form.waist) : null,
        hips:  form.hips  !== '' ? Number(form.hips)  : null,
      })
      setEditing(null)
    } catch {
      setError('Could not save measurement.')
    } finally {
      setSaving(false)
    }
  }

  if (!measurements.length) {
    return (
      <div className="mb-6">
        <h2 className="text-base font-semibold text-gray-800 mb-3">Measurements</h2>
        <div className="bg-white rounded-2xl border border-gray-200 p-6 text-center">
          <p className="text-sm font-semibold text-gray-700 mb-1">No measurements yet</p>
          <p className="text-xs text-gray-400">Add waist, hips, and chest measurements in Settings.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-base font-semibold text-gray-800">Measurements</h2>
        <span className="text-xs text-gray-400">{rangeLabel}</span>
      </div>
      <div className="grid gap-3">
        {MEASUREMENT_FIELDS.map(field => (
          <MeasurementCard key={field.key} field={field} measurements={measurements} />
        ))}
      </div>
      <div className="bg-white rounded-2xl border border-gray-200 mt-3 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-800">Measurement History</p>
        </div>
        <div className="divide-y divide-gray-100">
          {measurements
            .slice()
            .sort((a, b) => String(b.measurement_date).localeCompare(String(a.measurement_date)))
            .map(m => (
              <div key={m.id} className="p-4">
                {editing === m.id ? (
                  <form onSubmit={saveEdit} className="space-y-3">
                    <input
                      type="date"
                      value={form.measurement_date}
                      onChange={e => setForm(f => ({ ...f, measurement_date: e.target.value }))}
                      className="min-h-10 rounded-lg border border-gray-200 px-3 text-sm"
                    />
                    <div className="grid grid-cols-3 gap-2">
                      {MEASUREMENT_FIELDS.map(field => (
                        <label key={field.key} className="text-xs text-gray-500">
                          {field.label}
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={form[field.key]}
                            onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                            className="mt-1 w-full min-h-10 rounded-lg border border-gray-200 px-2 text-sm text-gray-800"
                          />
                        </label>
                      ))}
                    </div>
                    {error && <p className="text-xs text-red-500">{error}</p>}
                    <div className="flex gap-2">
                      <button type="submit" disabled={saving} className="min-h-10 px-4 rounded-lg bg-[#E8670A] text-white text-xs font-semibold disabled:opacity-60">
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button type="button" onClick={() => setEditing(null)} className="min-h-10 px-4 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600">
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{fmtDate(m.measurement_date)}</p>
                      <p className="text-xs text-gray-500">
                        Chest {m.chest ? `${Number(m.chest).toFixed(1)}"` : '-'} · Waist {m.waist ? `${Number(m.waist).toFixed(1)}"` : '-'} · Hips {m.hips ? `${Number(m.hips).toFixed(1)}"` : '-'}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button type="button" onClick={() => startEdit(m)} className="min-h-9 px-3 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600">
                        Edit
                      </button>
                      <button type="button" onClick={() => onDelete(m.id)} className="min-h-9 px-3 rounded-lg border border-red-100 text-xs font-semibold text-red-600">
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

export default function Progress() {
  const { getToken } = useAuth()
  const [range,   setRange]   = useState('30d')
  const [startDate, setStartDate] = useState(daysAgoIso(30))
  const [endDate,   setEndDate]   = useState(todayIso())
  const [data,    setData]    = useState(null)
  const [measurements, setMeasurements] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const token = await getToken()
        const params = new URLSearchParams({ range })
        if (range === 'custom') {
          params.set('start_date', startDate)
          params.set('end_date', endDate)
        }
        const headers = { Authorization: `Bearer ${token}` }
        const [progressRes, measurementsRes] = await Promise.all([
          fetch(`${API_URL}/api/daily-logs/progress?${params.toString()}`, { headers }),
          fetch(`${API_URL}/api/measurements`, { headers }),
        ])
        if (!progressRes.ok) throw new Error()
        const progressJson = await progressRes.json()
        const measurementsJson = measurementsRes.ok ? await measurementsRes.json() : []
        if (!cancelled) {
          setData(progressJson)
          setMeasurements(Array.isArray(measurementsJson) ? measurementsJson : [])
        }
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [range, startDate, endDate, getToken])

  const s = data?.summary ?? {}
  const effectiveStart = data?.start_date ?? startDate
  const effectiveEnd = data?.end_date ?? endDate
  const rangeMeta = RANGES.find(r => r.key === range) ?? RANGES[0]
  const rangeLabel = range === 'custom'
    ? `${fmtDate(effectiveStart)} to ${fmtDate(effectiveEnd)}`
    : rangeMeta.summaryLabel
  const rangeLabelPlain = rangeLabel.replace('-', ' ')
  const selectedMeasurements = measurements.filter(m => {
    const d = String(m.measurement_date).slice(0, 10)
    return d >= effectiveStart && d <= effectiveEnd
  })

  const wtChange = s.weight_change
  const wtChangeStr = wtChange != null
    ? `${wtChange > 0 ? '+' : ''}${wtChange} lbs this ${rangeLabelPlain}`
    : null

  const sodiumSeries = data?.macro_series?.some(d => Number(d.sodium_mg) > 0)
    ? data.macro_series.map(d => ({ date: d.date, value: d.sodium_mg }))
    : null

  async function updateMeasurement(id, payload) {
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/measurements/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error('Failed to update measurement')
    const updated = await res.json()
    setMeasurements(prev => prev
      .map(m => m.id === id ? updated : m)
      .sort((a, b) => String(b.measurement_date).localeCompare(String(a.measurement_date))))
  }

  async function deleteMeasurement(id) {
    if (!window.confirm('Delete this measurement entry? This cannot be undone.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/measurements/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setMeasurements(prev => prev.filter(m => m.id !== id))
  }

  async function deleteProgressPhoto(photoId) {
    if (!window.confirm('Delete this progress photo? This cannot be undone.')) return
    const token = await getToken()
    const res = await fetch(`${API_URL}/api/progress-photos/${photoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return
    setData(prev => {
      if (!prev) return prev
      const progress_photos = (prev.progress_photos ?? [])
        .map(session => {
          const photos = { ...session.photos }
          for (const angle of ['front', 'side', 'back']) {
            if (photos[angle]?.id === photoId) photos[angle] = null
          }
          return { ...session, photos }
        })
        .filter(session => ['front', 'side', 'back'].some(angle => session.photos[angle]))
      return { ...prev, progress_photos }
    })
  }

  return (
    <div className="w-full max-w-2xl mx-auto pb-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold text-gray-900">My Progress</h1>
        <div className="flex flex-col items-stretch sm:items-end gap-2">
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1 shrink-0 overflow-x-auto">
            {RANGES.map(r => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors min-h-[36px] whitespace-nowrap ${
                  range === r.key
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1 text-gray-500">
              <span className="sr-only sm:not-sr-only">Start</span>
              <input
                type="date"
                aria-label="Start date"
                value={startDate}
                onChange={e => { setStartDate(e.target.value); setRange('custom') }}
                max={endDate}
                className="min-h-10 rounded-lg border border-gray-200 px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </label>
            <label className="flex items-center gap-1 text-gray-500">
              <span className="sr-only sm:not-sr-only">End</span>
              <input
                type="date"
                aria-label="End date"
                value={endDate}
                onChange={e => { setEndDate(e.target.value); setRange('custom') }}
                min={startDate}
                max={todayIso()}
                className="min-h-10 rounded-lg border border-gray-200 px-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#E8670A]"
              />
            </label>
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <span className="text-sm text-gray-400">Loading...</span>
        </div>
      )}

      {error && !loading && (
        <div className="text-sm text-red-500 text-center py-8">
          Could not load progress data. Please try again.
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            <StatCard
              label="Avg Steps"
              value={s.avg_steps ? fmtNum(s.avg_steps) : '-'}
              sub="per day"
            />
            <StatCard
              label="Avg Sleep"
              value={s.avg_sleep_minutes ? fmtSleep(Number(s.avg_sleep_minutes)) : '-'}
              sub="per night"
            />
            <StatCard
              label="Avg Calories"
              value={s.avg_calories ? fmtNum(s.avg_calories) : '-'}
              sub={s.goal_calories ? `Goal: ${fmtNum(s.goal_calories)}` : 'per day'}
            />
            <StatCard
              label="Avg Protein"
              value={s.avg_protein ? `${s.avg_protein}g` : '-'}
              sub={s.goal_protein ? `Goal: ${s.goal_protein}g` : 'per day'}
            />
            <StatCard
              label="Workouts & Activity"
              value={s.total_activity ?? '-'}
              sub={`over ${rangeLabel}`}
            />
            <StatCard
              label="Sodium (7-day avg)"
              value={s.avg_sodium_7d ? `${fmtNum(s.avg_sodium_7d)} mg` : '-'}
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

          <div className="space-y-4 mb-6">
            <ChartCard
              title="Weight (lbs)"
              data={data.weight_series}
              fmtVal={v => `${v} lbs`}
            />
            <ChartCard
              title="Daily Steps"
              data={data.step_series}
              fmtVal={v => fmtNum(v)}
            />
            <ChartCard
              title="Sleep"
              data={data.sleep_series}
              fmtVal={v => fmtSleep(v)}
            />
            <ChartCard
              title="Calories"
              data={data.macro_series?.map(d => ({ date: d.date, value: d.calories }))}
              goalValue={s.goal_calories || null}
              goalLabel={s.goal_calories ? `${fmtNum(s.goal_calories)} kcal` : null}
              fmtVal={v => fmtNum(v)}
            />
            <ChartCard
              title="Protein (g)"
              data={data.macro_series?.map(d => ({ date: d.date, value: d.protein }))}
              goalValue={s.goal_protein || null}
              goalLabel={s.goal_protein ? `${s.goal_protein}g` : null}
              fmtVal={v => `${v}g`}
            />
            {sodiumSeries && (
              <ChartCard
                title="Sodium (mg)"
                data={sodiumSeries}
                fmtVal={v => `${fmtNum(v)} mg`}
              />
            )}
          </div>

          <MeasurementsSection
            measurements={selectedMeasurements}
            rangeLabel={rangeLabel}
            onUpdate={updateMeasurement}
            onDelete={deleteMeasurement}
          />

          <div>
            <h2 className="text-base font-semibold text-gray-800 mb-3">Progress Photos</h2>
            {!data.progress_photos?.length ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
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
                          {fmtDate(session.session_date)}
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
                        <button
                          type="button"
                          onClick={() => deleteProgressPhoto(photo.id)}
                          className="mt-2 min-h-[44px] w-full rounded-lg border border-red-100 text-[10px] font-semibold text-red-600"
                        >
                          Delete Photo
                        </button>
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
