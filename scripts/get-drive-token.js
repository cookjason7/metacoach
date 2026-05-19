/**
 * Local/dev-only helper to obtain a Google Drive OAuth refresh token.
 *
 * Use a Google OAuth Client with:
 *   Application type: Desktop app
 *
 * PowerShell command:
 *   $env:GOOGLE_DRIVE_CLIENT_ID="paste-your-desktop-client-id-here"
 *   $env:GOOGLE_DRIVE_CLIENT_SECRET="paste-your-desktop-client-secret-here"
 *   node scripts/get-drive-token.js
 *
 * macOS/Linux command:
 *   GOOGLE_DRIVE_CLIENT_ID="paste-your-desktop-client-id-here" \
 *   GOOGLE_DRIVE_CLIENT_SECRET="paste-your-desktop-client-secret-here" \
 *   node scripts/get-drive-token.js
 *
 * The script starts a temporary localhost callback server, prints a Google
 * authorization URL, captures the returned code, and prints Railway env vars.
 */

import http from 'http'
import { google } from 'googleapis'
import * as readline from 'readline'

const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.CLIENT_SECRET
const PORT = Number(process.env.GOOGLE_DRIVE_TOKEN_PORT || 53682)
const REDIRECT_PATH = '/oauth2callback'
const REDIRECT_URI = `http://127.0.0.1:${PORT}${REDIRECT_PATH}`
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

function printUsageAndExit() {
  console.log('\nMissing Google Drive Desktop OAuth credentials.\n')
  console.log('Use credentials from Google Cloud Console > APIs & Services > Credentials.')
  console.log('The OAuth Client type must be: Desktop app\n')
  console.log('PowerShell:')
  console.log('  $env:GOOGLE_DRIVE_CLIENT_ID="paste-your-desktop-client-id-here"')
  console.log('  $env:GOOGLE_DRIVE_CLIENT_SECRET="paste-your-desktop-client-secret-here"')
  console.log('  node scripts/get-drive-token.js\n')
  console.log('macOS/Linux:')
  console.log('  GOOGLE_DRIVE_CLIENT_ID="paste-your-desktop-client-id-here" \\')
  console.log('  GOOGLE_DRIVE_CLIENT_SECRET="paste-your-desktop-client-secret-here" \\')
  console.log('  node scripts/get-drive-token.js\n')
  process.exit(1)
}

if (!CLIENT_ID || !CLIENT_SECRET) printUsageAndExit()

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [DRIVE_SCOPE],
})

function createReadline() {
  return readline.createInterface({ input: process.stdin, output: process.stdout })
}

let manualRl = null

function waitForManualCode() {
  manualRl = createReadline()
  return new Promise(resolve => {
    manualRl.question('\nIf the browser does not show "Token captured", paste the code or full redirected URL here:\n> ', answer => {
      manualRl.close()
      manualRl = null
      const trimmed = answer.trim()
      if (!trimmed) return resolve(null)
      try {
        const parsed = new URL(trimmed)
        resolve(parsed.searchParams.get('code') || trimmed)
      } catch {
        resolve(trimmed)
      }
    })
  })
}

function waitForLocalCallback(server) {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url, REDIRECT_URI)
        if (url.pathname !== REDIRECT_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not found')
          return
        }

        const error = url.searchParams.get('error')
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<h1>Google Drive token failed</h1><p>You can close this tab and rerun the script.</p>')
          reject(new Error(error))
          return
        }

        const code = url.searchParams.get('code')
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<h1>Missing authorization code</h1><p>You can close this tab and rerun the script.</p>')
          reject(new Error('Missing authorization code'))
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Token captured</h1><p>You can close this tab and return to the terminal.</p>')
        resolve(code)
      } catch (err) {
        reject(err)
      }
    })
    server.on('error', reject)
  })
}

async function exchangeAndPrint(code) {
  const { tokens } = await oauth2.getToken(code)
  if (!tokens.refresh_token) {
    console.log('\nToken exchange worked, but Google did not return a refresh token.')
    console.log('Fix: remove this app from https://myaccount.google.com/permissions, then rerun the script.\n')
    process.exit(1)
  }

  console.log('\nToken exchange successful.\n')
  console.log('Set these Railway environment variables exactly:\n')
  console.log(`GOOGLE_DRIVE_CLIENT_ID=${CLIENT_ID}`)
  console.log(`GOOGLE_DRIVE_CLIENT_SECRET=${CLIENT_SECRET}`)
  console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}`)
  console.log('\nKeep GOOGLE_DRIVE_BACKUP_FOLDER_ID set to your backup folder ID.')
}

const server = http.createServer()

server.listen(PORT, '127.0.0.1', async () => {
  console.log('\nGoogle Drive refresh-token helper')
  console.log('--------------------------------')
  console.log('Using Desktop OAuth Client credentials.')
  console.log(`Local redirect URI: ${REDIRECT_URI}`)
  console.log('\nExact command to run next time:\n')
  console.log('PowerShell:')
  console.log(`  $env:GOOGLE_DRIVE_CLIENT_ID="${CLIENT_ID}"`)
  console.log(`  $env:GOOGLE_DRIVE_CLIENT_SECRET="${CLIENT_SECRET}"`)
  console.log('  node scripts/get-drive-token.js\n')
  console.log('1. Open this URL in your browser:\n')
  console.log(authUrl)
  console.log('\n2. Sign in as the Google account that can access the backup Shared Drive/folder.')
  console.log('3. Approve Google Drive access.')
  console.log('4. The browser should redirect to localhost and show "Token captured".')
  console.log('5. If it does not, paste the returned code or full localhost URL into this terminal.\n')
})

try {
  const callbackPromise = waitForLocalCallback(server)
  const manualPromise = waitForManualCode()
  const code = await Promise.race([callbackPromise, manualPromise])
  if (!code) throw new Error('No authorization code provided')
  await exchangeAndPrint(code)
} catch (err) {
  console.error('\nToken helper failed:', err.message)
  process.exitCode = 1
} finally {
  if (manualRl) manualRl.close()
  server.close()
}
