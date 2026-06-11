import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth, useClerk } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

export default function StaffInviteAccept() {
  const { token }                          = useParams()
  const navigate                           = useNavigate()
  const { isSignedIn, isLoaded, getToken } = useAuth()
  const { signOut }                        = useClerk()

  const [invite,      setInvite]      = useState(null)
  const [inviteError, setInviteError] = useState(null)
  const [accepting,   setAccepting]   = useState(false)
  const [acceptError, setAcceptError] = useState(null)
  const [accepted,    setAccepted]    = useState(false)
  const [retryNonce,  setRetryNonce]  = useState(0)
  const acceptRunningRef              = useRef(false)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_URL}/api/staff-invites/staff/${token}`)
        if (res.status === 404) { setInviteError('This invite link is invalid or has expired.'); return }
        if (res.status === 410) { const d = await res.json(); setInviteError(d.error); return }
        if (!res.ok)            { setInviteError('Unable to load invite. Please try again later.'); return }
        setInvite(await res.json())
      } catch {
        setInviteError('Network error. Check your connection and try again.')
      }
    }
    load()
  }, [token])

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !invite) return
    if (acceptRunningRef.current) return

    acceptRunningRef.current = true
    setAccepting(true)
    setAcceptError(null)

    async function runAccept() {
      try {
        const authToken = await getToken()
        const res = await fetch(`${API_URL}/api/staff-invites/staff/${token}/accept`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        })
        const data = await res.json()
        if (!res.ok) {
          setAcceptError(data.error ?? 'Something went wrong. Please try again.')
          return
        }
        setAccepted(true)
        setTimeout(() => { window.location.replace(data.redirect_to ?? '/admin/clients') }, 1500)
      } catch {
        setAcceptError('Network error. Please try again.')
      } finally {
        acceptRunningRef.current = false
        setAccepting(false)
      }
    }

    runAccept()
  }, [isLoaded, isSignedIn, invite, token, getToken, retryNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleRetry() {
    acceptRunningRef.current = false
    setAcceptError(null)
    setRetryNonce(n => n + 1)
  }

  async function handleSignOut() {
    acceptRunningRef.current = false
    setAcceptError(null)
    await signOut()
  }

  const isMismatchError = acceptError?.includes('sign out')
  const currentUrl      = window.location.href

  const roleLabel = invite?.role === 'admin' ? 'Admin' : 'Coach'

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-8 text-center">
        <div className="w-14 h-14 rounded-full bg-[#fff7ed] flex items-center justify-center mx-auto mb-4 text-2xl">
          🏆
        </div>
        <p className="text-xs font-bold text-[#E8670A] uppercase tracking-widest mb-1">
          WarriorFIT AI
        </p>

        {!invite && !inviteError && (
          <div className="py-6">
            <p className="text-sm text-gray-400">Loading your invite…</p>
          </div>
        )}

        {inviteError && (
          <div className="py-4">
            <p className="text-base font-bold text-gray-900 mb-2">Invite Unavailable</p>
            <p className="text-sm text-gray-500 mb-6">{inviteError}</p>
            <a href="mailto:support@lwcvip.com" className="text-sm text-[#E8670A] hover:underline">
              Contact support →
            </a>
          </div>
        )}

        {invite && !inviteError && (
          <>
            <h1 className="text-xl font-bold text-gray-900 mb-1 mt-2">
              Welcome, {invite.first_name}!
            </h1>
            <p className="text-sm text-gray-500 mb-6">
              You've been invited to join WarriorFIT AI as a <strong>{roleLabel}</strong>.
              {invite.email && (
                <> Sign up or sign in with <strong>{invite.email}</strong> to get started.</>
              )}
            </p>

            {accepting && !acceptError && (
              <div className="py-4">
                <div className="w-10 h-10 rounded-full border-4 border-[#E8670A] border-t-transparent animate-spin mx-auto mb-3" />
                <p className="text-sm text-gray-500">Setting up your account…</p>
              </div>
            )}

            {accepted && (
              <div className="py-4">
                <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-3 text-2xl">✓</div>
                <p className="text-sm font-semibold text-emerald-700">Invite accepted!</p>
                <p className="text-xs text-gray-400 mt-1">Taking you to the dashboard…</p>
              </div>
            )}

            {acceptError && !accepting && (
              <div className="mb-4 text-left">
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-3">
                  <p className="text-xs font-semibold text-red-700 mb-1">
                    {isMismatchError ? 'Wrong account' : 'Unable to accept invite'}
                  </p>
                  <p className="text-xs text-red-600">{acceptError}</p>
                </div>
                {isMismatchError ? (
                  <button
                    onClick={handleSignOut}
                    className="w-full bg-[#E8670A] text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-[#c45e09] transition-colors"
                  >
                    Sign Out &amp; Use Different Account
                  </button>
                ) : (
                  <button
                    onClick={handleRetry}
                    className="w-full bg-[#E8670A] text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-[#c45e09] transition-colors"
                  >
                    Try Again
                  </button>
                )}
              </div>
            )}

            {isLoaded && !isSignedIn && !accepted && !accepting && (
              <div className="space-y-3">
                <button
                  onClick={() => {
                    const params = new URLSearchParams({
                      redirect_url: currentUrl,
                      ...(invite.email ? { email: invite.email } : {}),
                    })
                    navigate(`/sign-up?${params.toString()}`)
                  }}
                  className="w-full bg-[#E8670A] text-white py-3 rounded-xl text-sm font-bold hover:bg-[#c45e09] transition-colors"
                >
                  Create Account &amp; Accept
                </button>
                <button
                  onClick={() => {
                    const params = new URLSearchParams({ redirect_url: currentUrl })
                    navigate(`/sign-in?${params.toString()}`)
                  }}
                  className="w-full border border-gray-300 text-gray-700 py-3 rounded-xl text-sm font-semibold hover:bg-gray-50 transition-colors"
                >
                  I already have an account
                </button>
                <p className="text-[10px] text-gray-400 pt-1">
                  You must sign up with <strong>{invite.email}</strong> to accept this invite.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
