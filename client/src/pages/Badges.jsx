import { useEffect, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config.js'

const CATEGORY_ORDER = ['Logging', 'Protein', 'Water', 'Workouts', 'Ranks']

const RANK_META = {
  Recruit:       { icon: '⚔️',  color: '#6B7280', bg: '#F9FAFB', bar: '#9CA3AF' },
  Warrior:       { icon: '🏆',  color: '#E8670A', bg: '#FFF7ED', bar: '#E8670A' },
  'Elite Warrior': { icon: '⭐', color: '#7C3AED', bg: '#F5F3FF', bar: '#7C3AED' },
  'Life Warrior':  { icon: '💎', color: '#0284C7', bg: '#F0F9FF', bar: '#0284C7' },
}

function BadgeCard({ badge }) {
  const earned = badge.earned
  const dateStr = badge.earned_at
    ? new Date(badge.earned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null

  return (
    <div className={`relative rounded-2xl border p-4 flex flex-col items-center text-center gap-2 transition-all ${
      earned
        ? 'bg-white border-gray-200 shadow-sm'
        : 'bg-gray-50 border-gray-100 opacity-60'
    }`}>
      {earned && (
        <div className="absolute top-2.5 right-2.5 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}
      {!earned && (
        <div className="absolute top-2.5 right-2.5 w-5 h-5 bg-gray-300 rounded-full flex items-center justify-center">
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m0 0v2m0-2h2m-2 0H10M12 9V7m0 0V5m0 2h2m-2 0H10" />
          </svg>
        </div>
      )}

      <span className={`text-4xl leading-none ${!earned ? 'grayscale' : ''}`}>{badge.icon}</span>
      <p className={`text-sm font-bold leading-snug ${earned ? 'text-gray-900' : 'text-gray-500'}`}>
        {badge.name}
      </p>
      <p className="text-xs text-gray-400 leading-snug">{badge.desc}</p>
      {earned && dateStr && (
        <p className="text-[10px] font-semibold text-green-600 bg-green-50 rounded-full px-2 py-0.5">
          Earned {dateStr}
        </p>
      )}
      {!earned && (
        <p className="text-[10px] text-gray-400">Not yet earned</p>
      )}
    </div>
  )
}

export default function Badges() {
  const { getToken } = useAuth()
  const [badges,  setBadges]  = useState([])
  const [gamData, setGamData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const token   = await getToken()
        const headers = { Authorization: `Bearer ${token}` }
        const [r1, r2] = await Promise.all([
          fetch(`${API_URL}/api/gamification/badges`, { headers }),
          fetch(`${API_URL}/api/gamification/me`,     { headers }),
        ])
        if (r1.ok) setBadges(await r1.json())
        if (r2.ok) setGamData(await r2.json())
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [getToken])

  const byCategory = CATEGORY_ORDER.map(cat => ({
    cat,
    items: badges.filter(b => b.category === cat),
  }))

  const earnedCount = badges.filter(b => b.earned).length
  const rankMeta    = RANK_META[gamData?.rank] ?? RANK_META['Recruit']

  return (
    <div className="max-w-2xl mx-auto pb-24">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link to="/dashboard" className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors text-lg">
          ‹
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Achievements</h1>
          {!loading && (
            <p className="text-sm text-gray-500">{earnedCount} of {badges.length} earned</p>
          )}
        </div>
      </div>

      {/* Rank card */}
      {gamData && (
        <div className="rounded-2xl border border-gray-200 bg-white p-4 mb-6">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl shrink-0"
              style={{ backgroundColor: rankMeta.bg }}>
              {rankMeta.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-500 mb-0.5">Current Rank</p>
              <p className="text-xl font-bold leading-none" style={{ color: rankMeta.color }}>
                {gamData.rank}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                <span className="font-semibold text-gray-800">{gamData.total_xp.toLocaleString()} XP</span>
                {gamData.next_rank && (
                  <> · {gamData.xp_to_next_rank} XP to {gamData.next_rank}</>
                )}
              </p>
            </div>
          </div>

          {gamData.next_rank && (
            <div className="mt-3">
              <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${gamData.progress_pct}%`, backgroundColor: rankMeta.bar }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                <span>{gamData.rank}</span>
                <span>{gamData.next_rank}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Badge categories */}
      {loading ? (
        <div className="flex justify-center py-16">
          <span className="text-sm text-gray-400">Loading…</span>
        </div>
      ) : (
        byCategory.map(({ cat, items }) => (
          <div key={cat} className="mb-8">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {cat}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {items.map(b => (
                <BadgeCard key={b.badge_id} badge={b} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
