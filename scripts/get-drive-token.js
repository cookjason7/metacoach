/**
 * One-time helper to obtain a Google Drive OAuth refresh token.
 *
 * Prerequisites
 * ─────────────
 * 1. Go to console.cloud.google.com → APIs & Services → Credentials.
 * 2. Create an OAuth 2.0 Client ID:
 *      Application type: Desktop app  (or "Web application" — Desktop is simpler)
 *      Name: MetaCoach Drive Backup (or anything)
 * 3. Download the JSON, or copy the Client ID and Client Secret.
 * 4. Make sure "Google Drive API" is enabled for the project.
 *
 * Usage
 * ─────
 *   CLIENT_ID=<your-client-id> \
 *   CLIENT_SECRET=<your-client-secret> \
 *   node scripts/get-drive-token.js
 *
 * What it does
 * ────────────
 * 1. Prints an authorization URL. Open it in the browser while signed in
 *    as the Google account that owns the backup Drive folder.
 * 2. Grant access when prompted.
 * 3. Google redirects to localhost (or shows a code). Paste the code here.
 * 4. Prints the refresh_token. Copy it into Railway as:
 *      GOOGLE_DRIVE_REFRESH_TOKEN=<value>
 *    along with:
 *      GOOGLE_DRIVE_CLIENT_ID=<your-client-id>
 *      GOOGLE_DRIVE_CLIENT_SECRET=<your-client-secret>
 *
 * The refresh token does not expire unless the OAuth consent screen is set to
 * "Testing" with a short expiry, or the user revokes access. Re-run this
 * script if uploads ever fail with an "invalid_grant" error.
 */

import { google } from 'googleapis'
import * as readline from 'readline'

const CLIENT_ID     = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: CLIENT_ID=... CLIENT_SECRET=... node scripts/get-drive-token.js')
  process.exit(1)
}

// 'urn:ietf:wg:oauth:2.0:oob' is the "copy the code" redirect — no local server needed.
const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'urn:ietf:wg:oauth:2.0:oob')

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive.file'],
  prompt: 'consent',   // forces refresh_token to always be returned
})

console.log('\n1. Open this URL in the browser signed in as the Drive folder owner:\n')
console.log('   ' + authUrl)
console.log('\n2. Grant access, then paste the authorization code below.\n')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.question('Authorization code: ', async (code) => {
  rl.close()
  try {
    const { tokens } = await oauth2.getToken(code.trim())
    console.log('\n✓ Token exchange successful.\n')
    console.log('Set these Railway environment variables:\n')
    console.log(`  GOOGLE_DRIVE_CLIENT_ID     = ${CLIENT_ID}`)
    console.log(`  GOOGLE_DRIVE_CLIENT_SECRET = ${CLIENT_SECRET}`)
    console.log(`  GOOGLE_DRIVE_REFRESH_TOKEN = ${tokens.refresh_token}`)
    if (!tokens.refresh_token) {
      console.warn('\n⚠ No refresh_token returned. This usually means the account already')
      console.warn('  granted access without "prompt: consent". Revoke access at')
      console.warn('  https://myaccount.google.com/permissions and re-run this script.')
    }
  } catch (err) {
    console.error('\n✗ Token exchange failed:', err.message)
    process.exit(1)
  }
})
