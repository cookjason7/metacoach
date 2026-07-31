import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@clerk/clerk-react'
import Layout from './components/Layout'
import SignInPage from './pages/SignIn'
import SignUpPage from './pages/SignUp'
import Onboarding from './pages/Onboarding'
import Payment from './pages/Payment'
import Dashboard from './pages/Dashboard'
import LogMeal from './pages/LogMeal'
import MealHistory from './pages/MealHistory'
import AICoach from './pages/AICoach'
import Community from './pages/Community'
import Settings from './pages/Settings'
import FoodList from './pages/FoodList'
import Admin from './pages/Admin'
import Workouts from './pages/Workouts'
import WorkoutBuilderPreview from './pages/WorkoutBuilderPreview'
import Journal from './pages/Journal'
import Calendar from './pages/Calendar'
import Badges from './pages/Badges'
import HealthAssessment from './pages/HealthAssessment'
import PendingAccess from './pages/PendingAccess'
import Messages from './pages/Messages'
import ClientList from './pages/admin/ClientList'
import ClientProfile from './pages/admin/ClientProfile'
import UsageAnalytics from './pages/admin/UsageAnalytics'
import KatieCorrections from './pages/admin/KatieCorrections'
import WorkoutBuilderTest from './pages/admin/WorkoutBuilderTest'
import InviteAccept from './pages/InviteAccept'
import StaffInviteAccept from './pages/StaffInviteAccept'
import AiWelcome from './pages/AiWelcome'
import FormsList from './pages/admin/FormsList'
import FormBuilder from './pages/admin/FormBuilder'
import FormFill from './pages/FormFill'
import Terms from './pages/Terms'
import Privacy from './pages/Privacy'
import About from './pages/About'
import Progress from './pages/Progress'
import StaffChat from './pages/StaffChat'
import Organizations from './pages/admin/Organizations'
import OrgDashboard from './pages/org/OrgDashboard'
import OrgSetup from './pages/org/OrgSetup'
import { OrgBrandingProvider } from './context/OrgBrandingContext'
import { API_URL } from './config.js'

// Mirrors ADMIN_EMAILS in server/db.js — route gating only, the real gate is
// isAdminEmail() on every /api/organizations route.
const SUPER_ADMIN_EMAILS = ['jason@lwcvip.com', 'jason@efcfit.com']

// Module-level cache: null | { onboardingComplete: bool, paid: bool }
// Persists across React re-renders; resets on hard page refresh.
let userStateCache = null

function AuthStateWatcher() {
  const { userId, isSignedIn } = useAuth()
  const prevUserId    = useRef(userId)
  const prevSignedIn  = useRef(isSignedIn)
  useEffect(() => {
    const userChanged = userId !== prevUserId.current
    // A fresh sign-in — even by the SAME Clerk userId (e.g. sign out then back
    // in with the same account, or a session silently resuming) — must also
    // invalidate the cache. The server-side role for that userId may have
    // changed since userStateCache was populated; only keying off userId
    // change let a previous session's stale role (e.g. 'client') keep being
    // served after the account was promoted to an org admin.
    const freshSignIn = isSignedIn === true && prevSignedIn.current !== true
    if (userChanged || freshSignIn) {
      userStateCache = null
      delete window.__userState
    }
    prevUserId.current   = userId
    prevSignedIn.current = isSignedIn
  }, [userId, isSignedIn])
  return null
}

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <span className="text-sm text-gray-400">Loading…</span>
    </div>
  )
}

function ProtectedLayout() {
  const { isSignedIn, isLoaded, getToken } = useAuth()

  if (window.__userState !== undefined) {
    userStateCache = window.__userState
    delete window.__userState
  }

  const [userState, setUserState] = useState(userStateCache)
  const [checking, setChecking] = useState(userStateCache === null)
  const [fetchError, setFetchError] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (!isLoaded) return
    if (!isSignedIn) {
      setChecking(false)
      return
    }
    if (userStateCache !== null) {
      setUserState(userStateCache)
      setChecking(false)
      return
    }

    let cancelled = false
    async function check() {
      try {
        const token = await getToken()
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 8000)
        const res = await fetch(`${API_URL}/api/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        if (!res.ok) throw new Error()
        const data = await res.json()
        const email = (data.email ?? '').toLowerCase()
        const isSuperAdminUser = SUPER_ADMIN_EMAILS.includes(email)
        // Org-level admin/owner: the org's own 'admin' role, or the org's
        // owner_user_id even when their role is 'coach' — never Jason (super
        // admin has his own admin views, not the gym-owner ones).
        const isOrgAdminUser = !isSuperAdminUser
          && (data.role === 'admin' || data.role === 'account_owner' || (data.role === 'coach' && !!data.is_org_owner))
        userStateCache = {
          onboardingComplete:  !!data.onboarding_complete,
          assessmentComplete:  !!data.assessment_complete,
          paid: !!data.paid,
          role: data.role ?? null,
          email: data.email ?? null,
          isOrgAdmin: isOrgAdminUser,
          clientStatus: data.client_status ?? null,
        }
        if (!cancelled) {
          setUserState(userStateCache)
          setChecking(false)
        }
      } catch {
        if (!cancelled) {
          setFetchError(true)
          setChecking(false)
        }
      }
    }
    check()
    return () => { cancelled = true }
  }, [isLoaded, isSignedIn, getToken, retryCount])

  if (!isLoaded) return <LoadingScreen />
  if (!isSignedIn) return <Navigate to="/sign-in" replace />
  if (checking) return <LoadingScreen />
  if (fetchError) return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4 p-6">
      <p className="text-sm text-gray-600 text-center">Unable to connect. Please check your connection and try again.</p>
      <button
        onClick={() => { userStateCache = null; setFetchError(false); setChecking(true); setRetryCount(c => c + 1) }}
        className="px-5 py-2.5 bg-[#E8670A] hover:bg-[#d45a08] text-white text-sm font-semibold rounded-xl transition-colors"
      >
        Try Again
      </button>
    </div>
  )
  const isPrivileged = ['admin', 'account_owner', 'staff', 'coach'].includes(userState?.role)
  // Signed up with no matching invite and no paid record — held at /pending-access
  // until an admin invites/activates them. Must come BEFORE the assessment check,
  // or a gated account would be sent through the Health Assessment first.
  if (!isPrivileged && userState?.clientStatus === 'pending_access') {
    return <Navigate to="/pending-access" replace />
  }
  if (!isPrivileged && !userState?.assessmentComplete) return <Navigate to="/health-assessment" replace />
  // Payment gate disabled — open access
  // if (!userState?.paid) return <Navigate to="/payment" replace />
  return (
    <OrgBrandingProvider>
      <Layout />
    </OrgBrandingProvider>
  )
}

function AdminRoute() {
  if (!['admin', 'account_owner', 'staff', 'coach'].includes(userStateCache?.role)) {
    return <Navigate to="/dashboard" replace />
  }
  return <Outlet />
}

// Jason only — not the generic 'admin' role, since under multi-tenancy every org
// gets its own 'admin' user too. See SUPER_ADMIN_EMAILS above / isAdminEmail() in db.js.
function SuperAdminRoute() {
  const email = (userStateCache?.email ?? '').toLowerCase()
  if (!SUPER_ADMIN_EMAILS.includes(email)) {
    return <Navigate to="/dashboard" replace />
  }
  return <Outlet />
}

// Org-level admins/owners only — never Jason (SuperAdminRoute), never clients.
// See isOrgAdminUser computation above where userStateCache is populated.
function OrgAdminRoute() {
  if (!userStateCache?.isOrgAdmin) {
    return <Navigate to="/dashboard" replace />
  }
  return <Outlet />
}

function OnboardingRoute() {
  const { isSignedIn, isLoaded } = useAuth()
  if (!isLoaded) return <LoadingScreen />
  if (!isSignedIn) return <Navigate to="/sign-in" replace />
  return <Onboarding />
}

function PaymentRoute() {
  const { isSignedIn, isLoaded } = useAuth()
  if (!isLoaded) return <LoadingScreen />
  if (!isSignedIn) return <Navigate to="/sign-in" replace />
  return <Payment />
}

// Health assessment is a client-only onboarding flow. Staff/org-admin roles are
// never shown it — if userStateCache is already populated (the common case,
// since this route is normally reached via ProtectedLayout's redirect) bounce
// them straight to their dashboard instead. HealthAssessment.jsx itself has a
// second check for the cold-navigation case where the cache isn't populated yet.
function HealthAssessmentRoute() {
  const { isSignedIn, isLoaded } = useAuth()
  if (!isLoaded) return <LoadingScreen />
  if (!isSignedIn) return <Navigate to="/sign-in" replace />
  if (userStateCache && userStateCache.role !== 'client') {
    return <Navigate to={userStateCache.isOrgAdmin ? '/org/dashboard' : '/dashboard'} replace />
  }
  // Gated signups must not slip into onboarding by navigating here directly.
  if (userStateCache?.clientStatus === 'pending_access') {
    return <Navigate to="/pending-access" replace />
  }
  return <HealthAssessment />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthStateWatcher />
      <Routes>
        <Route path="/sign-in/*"  element={<SignInPage />} />
        <Route path="/sign-up/*"  element={<SignUpPage />} />
        <Route path="/about"              element={<About />} />
        <Route path="/terms"              element={<Terms />} />
        <Route path="/privacy"            element={<Privacy />} />
        <Route path="/onboarding"         element={<OnboardingRoute />} />
        <Route path="/payment"            element={<PaymentRoute />} />
        <Route path="/health-assessment"  element={<HealthAssessmentRoute />} />
        <Route path="/pending-access"     element={<PendingAccess />} />
        <Route path="/invite/:token"       element={<InviteAccept />} />
        <Route path="/staff-invite/:token" element={<StaffInviteAccept />} />
        <Route path="/ai-welcome"         element={<AiWelcome />} />
        <Route element={<ProtectedLayout />}>
          <Route path="/"             element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard"    element={<Dashboard />} />
          <Route path="/log-meal"     element={<Navigate to="/journal" replace />} />
          <Route path="/meal-history" element={<Navigate to="/journal" replace />} />
          <Route path="/ai-coach"     element={<AICoach />} />
          <Route path="/community"    element={<Community />} />
          <Route path="/journal"      element={<Journal />} />
          <Route path="/food-list"    element={<FoodList />} />
          <Route path="/workouts"     element={<Workouts />} />
          <Route path="/workout-builder-preview" element={<WorkoutBuilderPreview />} />
          <Route path="/badges"       element={<Badges />} />
          <Route path="/settings"     element={<Settings />} />
          <Route path="/progress"     element={<Progress />} />
          <Route path="/calendar"     element={<Calendar />} />
          <Route path="/messages"     element={<Messages />} />
          <Route path="/weekly-checkin"      element={<Navigate to="/dashboard" replace />} />
          <Route path="/forms/:id/fill"        element={<FormFill />} />
          <Route element={<AdminRoute />}>
            <Route path="/admin"               element={<Admin />} />
            <Route path="/admin/clients"       element={<ClientList />} />
            <Route path="/admin/clients/:id"   element={<ClientProfile />} />
            <Route path="/admin/forms"         element={<FormsList />} />
            <Route path="/admin/forms/:id/edit" element={<FormBuilder />} />
            <Route path="/admin/usage"         element={<UsageAnalytics />} />
            <Route path="/admin/katie-corrections" element={<KatieCorrections />} />
            <Route path="/admin/workout-builder-test" element={<WorkoutBuilderTest />} />
            <Route path="/staff-chat"          element={<StaffChat />} />
          </Route>
          <Route element={<SuperAdminRoute />}>
            <Route path="/admin/organizations" element={<Organizations />} />
          </Route>
          <Route element={<OrgAdminRoute />}>
            <Route path="/org/dashboard" element={<OrgDashboard />} />
            <Route path="/org/setup"     element={<OrgSetup />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
