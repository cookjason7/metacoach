import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useAuth, useClerk, SignInButton, SignUpButton } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

export default function InviteAccept() {
  const { token }             = useParams()
  const { isSignedIn, isLoaded, getToken } = useAuth()
  const { signOut }           = useClerk()

  const [invite,      setInvite]      = useState(null)
  const [inviteError, setInviteError] = useState(null)
  const [accepting,   setAccepting]   = useState(false)
  const [acceptError, setAcceptError] = useState(null)
  const [accepted,    setAccepted]    = useState(false)

  // retryNonce lets the user trigger a retry without re-mounting the component.
  // It's the only value in the accept-effect deps that the user controls.
  const [retryNonce,  setRetryNonce]  = useState(0)

  // Ref guards against double-firing when deps change during the async call.
  // Using a ref (not state) means changing it never re-triggers the effect.
  const acceptRunningRef = useRef(false)

  // ── Load invite details on mount ──────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_URL}/api/client-invites/${token}`)
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

  // ── Auto-accept once signed in ────────────────────────────────────────────
  // IMPORTANT: `accepting`, `acceptError`, and `accepted` are intentionally
  // NOT in the deps array. Putting `accepting` in deps caused React to run the
  // effect cleanup the moment setAccepting(true) fired inside the effect body,
  // setting cancelled=true and preventing setAccepting(false) from ever running
  // — leaving the UI permanently stuck on "Setting up your account…".
  // The acceptRunningRef guards against concurrent calls instead.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !invite) return
    if (acceptRunningRef.current) return

    acceptRunningRef.current = true
    setAccepting(true)
    setAcceptError(null)

    async function runAccept() {
      try {
        const authToken = await getToken()
        const res = await fetch(`${API_URL}/api/client-invites/${token}/accept`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        })
        const data = await res.json()
        if (!res.ok) {
          setAcceptError(data.error ?? 'Something went wrong. Please try again.')
          return
        }
        setAccepted(true)
        // Hard-navigate so ProtectedLayout re-fetches fresh user state from the API.
        // assessment_complete is set to FALSE by the accept endpoint, so the user
        // lands on /health-assessment automatically via the ProtectedLayout guard.
        setTimeout(() => { window.location.replace(data.redirect_to ?? '/health-assessment') }, 1500)
      } catch {
        setAcceptError('Network error. Please try again.')
      } finally {
        acceptRunningRef.current = false
        setAccepting(false)
      }
    }

    runAccept()
  }, [isLoaded, isSignedIn, invite, token, getToken, retryNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Helpers ───────────────────────────────────────────────────────────────

  function handleRetry() {
    // Reset the ref so the effect is allowed to fire again, then bump nonce
    acceptRunningRef.current = false
    setAcceptError(null)
    setRetryNonce(n => n + 1)
  }

  async function handleSignOut() {
    acceptRunningRef.current = false
    setAcceptError(null)
    await signOut()
    // After sign-out Clerk reloads the page state; isSignedIn will flip to false
    // and the auth buttons will reappear automatically
  }

  // ── Derived flags ─────────────────────────────────────────────────────────

  const isMismatchError = acceptError?.includes('sign out')
  const currentUrl      = window.location.href

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-8 text-center">

        {/* Brand mark */}
        <div className="w-14 h-14 rounded-full bg-[#fff7ed] flex items-center justify-center mx-auto mb-4 text-2xl">
          🏆
        </div>
        <p className="text-xs font-bold text-[#E8670A] uppercase tracking-widest mb-1">
          Life Warrior Coaching
        </p>

        {/* ── Loading invite ── */}
        {!invite && !inviteError && (
          <div className="py-6">
            <p className="text-sm text-gray-400">Loading your invite…</p>
          </div>
        )}

        {/* ── Invite load error ── */}
        {inviteError && (
          <div className="py-4">
            <p className="text-base font-bold text-gray-900 mb-2">Invite Unavailable</p>
            <p className="text-sm text-gray-500 mb-6">{inviteError}</p>
            <a href="mailto:support@lwcvip.com" className="text-sm text-[#E8670A] hover:underline">
              Contact support →
            </a>
          </div>
        )}

        {/* ── Invite loaded ── */}
        {invite && !inviteError && (
          <>
            <h1 className="text-xl font-bold text-gray-900 mb-1 mt-2">
              Welcome, {invite.first_name}!
            </h1>
            <p className="text-sm text-gray-500 mb-6">
              You've been invited to join Life Warrior VIP Coaching.
              {invite.email && (
                <> Sign up or sign in with <strong>{invite.email}</strong> to get started.</>
              )}
            </p>

            {/* ── Accepting state ── */}
            {accepting && !acceptError && (
              <div className="py-4">
                <div className="w-10 h-10 rounded-full border-4 border-[#E8670A] border-t-transparent
                                animate-spin mx-auto mb-3" />
                <p className="text-sm text-gray-500">Setting up your account…</p>
              </div>
            )}

            {/* ── Accepted / success state ── */}
            {accepted && (
              <div className="py-4">
                <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center
                                justify-center mx-auto mb-3 text-2xl">✓</div>
                <p className="text-sm font-semibold text-emerald-700">Invite accepted!</p>
                <p className="text-xs text-gray-400 mt-1">Setting up your profile…</p>
              </div>
            )}

            {/* ── Accept error ── */}
            {acceptError && !accepting && (
              <div className="mb-4 text-left">
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-3">
                  <p className="text-xs font-semibold text-red-700 mb-1">
                    {isMismatchError ? 'Wrong account' : 'Unable to accept invite'}
                  </p>
                  <p className="text-xs text-red-600">{acceptError}</p>
                </div>

                {isMismatchError ? (
                  /* Email mismatch — offer sign-out so they can sign in as the right email */
                  <button
                    onClick={handleSignOut}
                    className="w-full bg-[#E8670A] text-white py-2.5 rounded-xl text-sm font-semibold
                               hover:bg-[#c45e09] transition-colors"
                  >
                    Sign Out &amp; Use Different Account
                  </button>
                ) : (
                  /* Other errors — allow retry */
                  <button
                    onClick={handleRetry}
                    className="w-full bg-[#E8670A] text-white py-2.5 rounded-xl text-sm font-semibold
                               hover:bg-[#c45e09] transition-colors"
                  >
                    Try Again
                  </button>
                )}
              </div>
            )}

            {/* ── Not signed in — show auth buttons ── */}
            {isLoaded && !isSignedIn && !accepted && !accepting && (
              <div className="space-y-3">
                <SignUpButton
                  mode="redirect"
                  forceRedirectUrl={currentUrl}
                  initialValues={{ emailAddress: invite.email }}
                >
                  <button className="w-full bg-[#E8670A] text-white py-3 rounded-xl text-sm font-bold
                                     hover:bg-[#c45e09] transition-colors">
                    Create Account &amp; Accept
                  </button>
                </SignUpButton>
                <SignInButton
                  mode="redirect"
                  forceRedirectUrl={currentUrl}
                >
                  <button className="w-full border border-gray-300 text-gray-700 py-3 rounded-xl
                                     text-sm font-semibold hover:bg-gray-50 transition-colors">
                    I already have an account
                  </button>
                </SignInButton>
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
