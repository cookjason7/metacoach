/**
 * server/services/appUrl.js
 *
 * Centralised app base-URL resolver.
 *
 * Priority order:
 *   1. APP_BASE_URL          — explicit override, set this in every environment
 *   2. RAILWAY_PUBLIC_DOMAIN — auto-provided by Railway per deployment
 *   3. Hardcoded production URL (logs a warning so accidental staging→production
 *      URL bleed-through is visible in the logs)
 *
 * Set APP_BASE_URL in Railway staging environment variables:
 *   APP_BASE_URL=https://metacoach-staging.up.railway.app
 */

export function getAppBaseUrl() {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL.replace(/\/+$/, '')
  }

  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN.replace(/\/+$/, '')
    return domain.startsWith('http') ? domain : `https://${domain}`
  }

  console.warn(
    '[appUrl] APP_BASE_URL is not set and RAILWAY_PUBLIC_DOMAIN is unavailable — ' +
    'falling back to production URL. Set APP_BASE_URL in your environment variables.',
  )
  return 'https://app.lwcvip.com'
}
