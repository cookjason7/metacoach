// OrgBrandingContext.jsx — fetches the signed-in user's org branding (if any)
// and exposes it app-wide, falling back to LWC/WarriorFIT AI defaults for
// client users or any fetch failure.
import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { API_URL } from '../config.js'

const DEFAULTS = {
  primaryColor: '#E8670A',
  sidebarColor: '#0F1E35',
  logoUrl: '/brand/warriorfit-logo-full-sidebar.png',
  brandName: 'Life Warrior Coaching',
  aiCoachName: 'Katie',
}

function darken(hex, percent) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return hex
  const num = parseInt(m[1], 16)
  const channel = (shift) => {
    const c = (num >> shift) & 0xff
    return Math.max(0, Math.round(c * (1 - percent)))
  }
  const r = channel(16), g = channel(8), b = channel(0)
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

// "Coach <name>" without doubling the word when the org already stored the title
// as part of the name (org 2 had ai_coach_name = "Coach Alex", which a naive
// template rendered as "Coach Coach Alex").
export function coachTitleFor(name) {
  const n = String(name ?? '').trim() || DEFAULTS.aiCoachName
  return /^coach\b/i.test(n) ? n : `Coach ${n}`
}

const OrgBrandingContext = createContext({
  ...DEFAULTS,
  coachTitle: coachTitleFor(DEFAULTS.aiCoachName),
  refreshBranding: () => {},
})

export function OrgBrandingProvider({ children }) {
  const { getToken } = useAuth()
  const [branding, setBranding] = useState(DEFAULTS)

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_URL}/api/organizations/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const org = await res.json()
      if (!org) return
      setBranding({
        primaryColor: org.primary_color || DEFAULTS.primaryColor,
        sidebarColor: DEFAULTS.sidebarColor,
        logoUrl: org.logo_url || DEFAULTS.logoUrl,
        brandName: org.brand_name || DEFAULTS.brandName,
        aiCoachName: org.ai_coach_name || DEFAULTS.aiCoachName,
      })
    } catch {
      // Silent — keep defaults for any client user or network failure
    }
  }, [getToken])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--color-accent', branding.primaryColor)
    root.style.setProperty('--color-accent-hover', darken(branding.primaryColor, 0.15))
    root.style.setProperty('--color-sidebar', branding.sidebarColor)
  }, [branding])

  return (
    <OrgBrandingContext.Provider
      value={{ ...branding, coachTitle: coachTitleFor(branding.aiCoachName), refreshBranding: load }}
    >
      {children}
    </OrgBrandingContext.Provider>
  )
}

export function useOrgBranding() {
  return useContext(OrgBrandingContext)
}
