import { CapacitorConfig } from '@capacitor/cli'

/**
 * Production (default):
 *   npx cap sync ios
 *   → server.url = https://app.lwcvip.com  (loads live site, ignores local dist)
 *
 * Local HealthKit / iOS testing:
 *   CAP_LOCAL=1 npx cap sync ios
 *   → no server.url  (loads client/dist from the iOS bundle — shows local changes)
 *
 * Never commit with CAP_LOCAL set. The .ts file itself is always safe to commit.
 */

const isLocal = process.env.CAP_LOCAL === '1'

const config: CapacitorConfig = {
  appId: 'com.warriorfitai.app',
  appName: 'WarriorFIT AI',
  webDir: 'client/dist',
  ...(isLocal
    ? {}
    : {
        server: {
          url: 'https://app.lwcvip.com',
          cleartext: false,
          androidScheme: 'https',
          iosScheme: 'https',
        },
      }),
}

export default config
