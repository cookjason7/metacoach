import { useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useNavigate } from 'react-router-dom'
import { API_URL } from '../config.js'

const STRIPE_URL = 'https://buy.stripe.com/14A00j6qpdwPcnN4zGes00D'

export default function Payment() {
  const { getToken } = useAuth()
  const navigate = useNavigate()

  const [activating, setActivating] = useState(false)
  const [error,      setError]      = useState(null)

  async function activate() {
    setActivating(true)
    setError(null)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_URL}/api/users/me/activate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Could not activate account. Please contact support.')
      window.__userState = { onboardingComplete: true, paid: true }
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err.message)
      setActivating(false)
    }
  }

  function skip() {
    window.__userState = { onboardingComplete: true, paid: true }
    navigate('/dashboard', { replace: true })
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-10 text-center">

        {/* Logo */}
        <div className="mb-8 flex justify-center">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-6 py-3 inline-block">
            <img
              src="/logo.png"
              alt="Life Warrior Coaching"
              className="h-12 object-contain"
              onError={e => { e.currentTarget.style.display = 'none' }}
            />
          </div>
        </div>

        {/* Headline */}
        <h1 className="text-2xl font-bold text-gray-900 mb-3">
          Start Your Transformation
        </h1>

        {/* Subheading */}
        <p className="text-sm text-gray-500 leading-relaxed mb-8 max-w-xs mx-auto">
          Get unlimited access to Coach Katie, meal tracking, and the Life Warrior community.
        </p>

        {/* CTA */}
        <a
          href={STRIPE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full bg-[#E8670A] text-white py-3.5 rounded-xl text-sm font-bold hover:bg-[#c45e09] transition-colors mb-5"
        >
          Get Started
        </a>

        {/* Already paid */}
        {error && (
          <p className="text-xs text-red-500 mb-3">{error}</p>
        )}
        <button
          onClick={activate}
          disabled={activating}
          className="text-sm text-[#E8670A] hover:text-[#c45e09] font-medium transition-colors disabled:opacity-60"
        >
          {activating ? 'Activating…' : 'Already paid? Click here to activate your account'}
        </button>

        {/* Dev bypass */}
        <div className="mt-8 pt-6 border-t border-gray-100">
          <button
            onClick={skip}
            className="text-xs text-gray-300 hover:text-gray-400 transition-colors"
          >
            Skip for testing
          </button>
        </div>

      </div>
    </div>
  )
}
