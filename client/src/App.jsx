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
import { API_URL } from './config.js'

// Module-level cache: null | { onboardingComplete: bool, paid: bool }
// Persists across React re-renders; resets on hard page refresh.
let userStateCache = null

function AuthStateWatcher() {
  const { userId } = useAuth()
  const prevUserId = useRef(userId)
  useEffect(() => {
    if (userId !== prevUserId.current) {
      userStateCache = null
      delete window.__userState
      prevUserId.current = userId
    }
  }, [userId])
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
        userStateCache = {
          onboardingComplete:  !!data.onboarding_complete,
          assessmentComplete:  !!data.assessment_complete,
          paid: !!data.paid,
          role: data.role ?? null,
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
  if (!isPrivileged && !userState?.assessmentComplete) return <Navigate to="/health-assessment" replace />
  // Payment gate disabled — open access
  // if (!userState?.paid) return <Navigate to="/payment" replace />
  return <Layout />
}

function AdminRoute() {
  if (!['admin', 'account_owner', 'staff', 'coach'].includes(userStateCache?.role)) {
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

function HealthAssessmentRoute() {
  const { isSignedIn, isLoaded } = useAuth()
  if (!isLoaded) return <LoadingScreen />
  if (!isSignedIn) return <Navigate to="/sign-in" replace />
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
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
