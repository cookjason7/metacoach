import { useAuth, useClerk } from '@clerk/clerk-react'
import { Navigate, useNavigate } from 'react-router-dom'

const SUPPORT_EMAIL = 'support@lwcvip.com'

// Shown to accounts that signed up without a matching client invite and without
// a paid record (client_status = 'pending_access', set in getOrCreateUser).
// Deliberately outside <Layout> — no nav, no dashboard access, just the message
// and a way back out.
export default function PendingAccess() {
  const { isLoaded, isSignedIn } = useAuth()
  const { signOut } = useClerk()
  const navigate = useNavigate()

  if (!isLoaded) return null
  if (!isSignedIn) return <Navigate to="/sign-in" replace />

  return (
    <div className="min-h-screen bg-[#1e2a3a] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 sm:p-8 text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-orange-50 flex items-center justify-center mb-5">
          <svg className="w-7 h-7 text-[#f97316]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        <h1 className="text-xl sm:text-2xl font-bold text-[#1e2a3a] mb-3">
          Your account isn&apos;t active yet
        </h1>

        <p className="text-sm text-gray-600 leading-relaxed mb-6">
          Thanks for signing up! We couldn&apos;t find an active coaching plan or invitation
          for this email address, so your account is waiting on approval. Our team can get
          you set up right away.
        </p>

        <a
          href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Requesting account access')}`}
          className="flex items-center justify-center w-full min-h-[44px] px-5 py-3 bg-[#f97316] hover:bg-[#ea6a0c] text-white text-sm font-semibold rounded-xl transition-colors"
        >
          Email {SUPPORT_EMAIL} for access
        </a>

        <button
          type="button"
          onClick={() => signOut(() => navigate('/sign-in'))}
          className="flex items-center justify-center w-full min-h-[44px] mt-3 px-5 py-3 text-sm font-semibold text-gray-600 hover:text-[#1e2a3a] hover:bg-gray-50 rounded-xl transition-colors"
        >
          Sign out
        </button>

        <p className="mt-6 text-xs text-gray-400">
          Already purchased or received an invite? Sign in with that same email address.
        </p>
      </div>
    </div>
  )
}
