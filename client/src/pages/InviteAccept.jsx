import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth, SignInButton, SignUpButton } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

export default function InviteAccept() {
  const { token }   = useParams()
  const navigate    = useNavigate()
  const { isSignedIn, isLoaded, getToken } = useAuth()

  const [invite,      setInvite]      = useState(null)
  const [inviteError, setInviteError] = useState(null)
  const [accepting,   setAccepting]   = useState(false)
  const [acceptError, setAcceptError] = useState(null)
  const [accepted,    setAccepted]    = useState(false)

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

  // ── Auto-accept once signed in and invite is loaded ───────────────────────
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !invite || accepted || acceptError || accepting) return

    let cancelled = false
    async function accept() {
      setAccepting(true)
      try {
        const authToken = await getToken()
        const res = await fetch(`${API_URL}/api/client-invites/${token}/accept`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        })
        const data = await res.json()
        if (!res.ok) {
          if (!cancelled) setAcceptError(data.error ?? 'Something went wrong. Please try again.')
          return
        }
        if (!cancelled) {
          setAccepted(true)
          // Hard-navigate so ProtectedLayout re-fetches fresh user state
          setTimeout(() => { window.location.replace(data.redirect_to ?? '/health-assessment') }, 1500)
        }
      } catch {
        if (!cancelled) setAcceptError('Network error. Please try again.')
      } finally {
        if (!cancelled) setAccepting(false)
      }
    }
    accept()
    return () => { cancelled = true }
  }, [isLoaded, isSignedIn, invite, accepted, acceptError, accepting, token, getToken])

  // ── Shared invite URL so buttons can redirect back here ───────────────────
  const currentUrl = window.location.href

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-8 text-center">
        {/* Logo / branding */}
        <div className="w-14 h-14 rounded-full bg-[#fff7ed] flex items-center justify-center mx-auto mb-4 text-2xl">
          🏆
        </div>
        <p className="text-xs font-bold text-[#E8670A] uppercase tracking-widest mb-1">Life Warrior Coaching</p>

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
            <a
              href="mailto:support@lwcvip.com"
              className="text-sm text-[#E8670A] hover:underline"
            >
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

            {/* ── Accepting / accepted ── */}
            {(accepting || accepted) && (
              <div className="py-4">
                {accepted ? (
                  <>
                    <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-3 text-2xl">✓</div>
                    <p className="text-sm font-semibold text-emerald-700">Invite accepted!</p>
                    <p className="text-xs text-gray-400 mt-1">Setting up your profile…</p>
                  </>
                ) : (
                  <p className="text-sm text-gray-400">Setting up your account…</p>
                )}
              </div>
            )}

            {/* ── Accept error ── */}
            {acceptError && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4 text-left">
                <p className="text-xs font-semibold text-red-700 mb-1">Unable to accept invite</p>
                <p className="text-xs text-red-600">{acceptError}</p>
                {acceptError.includes('sign in with') && (
                  <p className="text-xs text-red-500 mt-2">
                    Sign out of your current account and sign in as <strong>{invite.email}</strong>.
                  </p>
                )}
              </div>
            )}

            {/* ── Not signed in — show auth buttons ── */}
            {isLoaded && !isSignedIn && !accepted && (
              <div className="space-y-3">
                <SignUpButton
                  mode="redirect"
                  forceRedirectUrl={currentUrl}
                  initialValues={{ emailAddress: invite.email }}
                >
                  <button className="w-full bg-[#E8670A] text-white py-3 rounded-xl text-sm font-bold hover:bg-[#c45e09] transition-colors">
                    Create Account &amp; Accept
                  </button>
                </SignUpButton>
                <SignInButton
                  mode="redirect"
                  forceRedirectUrl={currentUrl}
                >
                  <button className="w-full border border-gray-300 text-gray-700 py-3 rounded-xl text-sm font-semibold hover:bg-gray-50 transition-colors">
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
