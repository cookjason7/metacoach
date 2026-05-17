import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { API_URL } from '../config.js'

export default function AiWelcome() {
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session_id')

  const [setupUrl, setSetupUrl] = useState(null)
  const [loading, setLoading] = useState(!!sessionId)
  const [fetchError, setFetchError] = useState(null)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    async function fetchSetupUrl() {
      try {
        const res  = await fetch(`${API_URL}/api/stripe/session-setup-link?session_id=${encodeURIComponent(sessionId)}`)
        const data = await res.json()
        if (!cancelled) {
          if (res.ok) setSetupUrl(data.setupUrl)
          else setFetchError(data.error ?? 'Could not load setup link.')
        }
      } catch {
        if (!cancelled) setFetchError('Could not load setup link.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchSetupUrl()
    return () => { cancelled = true }
  }, [sessionId])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-8 text-center">

        <div className="w-14 h-14 rounded-full bg-[#fff7ed] flex items-center justify-center mx-auto mb-4 text-3xl">
          🎉
        </div>

        <p className="text-xs font-bold text-[#E8670A] uppercase tracking-widest mb-1">
          Life Warrior Coaching
        </p>

        <h1 className="text-xl font-bold text-gray-900 mb-3 mt-2">
          Payment confirmed!
        </h1>

        {loading && (
          <div className="my-5 text-sm text-gray-400">Loading your setup link…</div>
        )}

        {!loading && setupUrl && (
          <a
            href={setupUrl}
            className="block w-full bg-[#f97316] text-white text-sm font-bold py-3 px-6 rounded-xl mb-5 hover:bg-[#ea6c0a] transition-colors"
          >
            Set up your account →
          </a>
        )}

        {!loading && fetchError && (
          <p className="text-xs text-red-500 mb-4">{fetchError}</p>
        )}

        <p className="text-sm text-gray-600 leading-relaxed mb-2">
          Check your email for a setup link to create your account and get started.
        </p>

        <p className="text-xs text-gray-400 leading-relaxed mb-7">
          The email comes from Life Warrior Coaching. If you don't see it in a minute or two, check your spam folder.
        </p>

        <div className="bg-[#fff7ed] rounded-xl p-4 text-left mb-6">
          <p className="text-xs font-semibold text-[#E8670A] mb-2">What you get:</p>
          <ul className="space-y-1.5 text-xs text-gray-600">
            <li>✓ AI-powered coaching</li>
            <li>✓ Personalized food & nutrition tracking</li>
            <li>✓ Brain Mapping & VIP resources</li>
            <li>✓ Community chat for support, wins, and accountability</li>
          </ul>
        </div>

        <p className="text-xs text-gray-400">
          Questions?{' '}
          <a href="mailto:info@lwcvip.com" className="text-[#E8670A] hover:underline">
            info@lwcvip.com
          </a>
        </p>
      </div>
    </div>
  )
}
