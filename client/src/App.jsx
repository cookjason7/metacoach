import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
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
import Journal from './pages/Journal'

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

  // window.__userState is set by Onboarding (after submit) and Payment (after
  // activate/skip). It overrides the module cache so the next guard check
  // reflects the freshest state without an extra API round-trip.
  if (window.__userState !== undefined) {
    userStateCache = window.__userState
    delete window.__userState
  }

  const [userState, setUserState] = useState(userStateCache)
  const [checking,  setChecking]  = useState(userStateCache === null)

  useEffect(() => {
    if (!isLoaded || !isSignedIn || userStateCache !== null) return
    let cancelled = false
    async function check() {
      try {
        const token = await getToken()
        const res = await fetch('/api/users/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error()
        const data = await res.json()
        userStateCache = {
          onboardingComplete: !!data.onboarding_complete,
          paid: !!data.paid,
        }
      } catch {
        // On error assume complete + paid so a network blip doesn't lock users out
        userStateCache = { onboardingComplete: true, paid: true }
      } finally {
        if (!cancelled) {
          setUserState(userStateCache)
          setChecking(false)
        }
      }
    }
    check()
    return () => { cancelled = true }
  }, [isLoaded, isSignedIn, getToken])

  if (!isLoaded || checking)           return <LoadingScreen />
  if (!isSignedIn)                     return <Navigate to="/sign-in" replace />
  if (!userState?.onboardingComplete)  return <Navigate to="/onboarding" replace />
  if (!userState?.paid)                return <Navigate to="/payment" replace />
  return <Layout />
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

export default function App() {
  return (
    <BrowserRouter>
      <AuthStateWatcher />
      <Routes>
        <Route path="/sign-in/*"  element={<SignInPage />} />
        <Route path="/sign-up/*"  element={<SignUpPage />} />
        <Route path="/onboarding" element={<OnboardingRoute />} />
        <Route path="/payment"    element={<PaymentRoute />} />
        <Route element={<ProtectedLayout />}>
          <Route path="/"             element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard"    element={<Dashboard />} />
          <Route path="/log-meal"     element={<LogMeal />} />
          <Route path="/meal-history" element={<MealHistory />} />
          <Route path="/ai-coach"     element={<AICoach />} />
          <Route path="/community"    element={<Community />} />
          <Route path="/journal"      element={<Journal />} />
          <Route path="/food-list"    element={<FoodList />} />
          <Route path="/workouts"     element={<Workouts />} />
          <Route path="/settings"     element={<Settings />} />
          <Route path="/admin"        element={<Admin />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
