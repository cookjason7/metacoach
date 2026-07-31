import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { clerkMiddleware, getAuth } from '@clerk/express'
import { migrate, pool } from './db.js'
import orgContext from './middleware/orgContext.js'
import requireAssessmentComplete from './middleware/requireAssessmentComplete.js'
import mealsRouter from './routes/meals.js'
import dailyLogsRouter from './routes/dailyLogs.js'
import usersRouter from './routes/users.js'
import coachRouter from './routes/coach.js'
import communityRouter from './routes/community.js'
import progressPhotosRouter from './routes/progressPhotos.js'
import foodsRouter from './routes/foods.js'
import adminRouter from './routes/admin.js'
import recipesRouter from './routes/recipes.js'
import customFoodsRouter from './routes/customFoods.js'
import workoutsRouter from './routes/workouts.js'
import workoutBuilderRouter from './routes/workoutBuilder.js'
import gamificationRouter from './routes/gamification.js'
import healthAssessmentRouter from './routes/healthAssessment.js'
import coachAdminRouter from './routes/coachAdmin.js'
import clientHabitsRouter from './routes/clientHabits.js'
import clientWorkoutsRouter from './routes/clientWorkouts.js'
import messagesRouter from './routes/messages.js'
import invitesRouter from './routes/invites.js'
import weeklyCheckinsRouter from './routes/weeklyCheckins.js'
import formsRouter from './routes/forms.js'
import measurementsRouter from './routes/measurements.js'
import mindsetVideosRouter from './routes/mindsetVideos.js'
import brainMappingCommentsRouter from './routes/brainMappingComments.js'
import communityResourcesRouter from './routes/communityResources.js'
import stripeRouter from './routes/stripe.js'
import fitbitRouter from './routes/fitbit.js'
import appleHealthRouter from './routes/appleHealth.js'
import bloodworkRouter from './routes/bloodwork.js'
import pushRouter from './routes/push.js'
import staffChatRouter, { requireStaffMiddleware } from './routes/staffChat.js'
import organizationsRouter from './routes/organizations.js'
import { initPush } from './services/pushService.js'
import { runInactivityAlert } from './jobs/inactivityAlert.js'
import { processFormSchedules } from './jobs/formScheduler.js'
import { runPostgresBackup, runCloudinaryBackup, getBackupStatus } from './jobs/backup.js'
import { runHealthSync } from './jobs/healthSync.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://app.lwcvip.com',
    'https://metacoach-production.up.railway.app',
    'https://metacoach-staging.up.railway.app',
    'https://localhost',          // Capacitor Android WebView (androidScheme: https)
    'capacitor://localhost',      // Capacitor iOS WebView fallback (iosScheme default)
  ],
  credentials: true,
}))
// Stripe webhook MUST be mounted before express.json() — it needs the raw body
// for signature verification. express.raw() is applied only to this one route
// inside the stripe router.
app.use('/api/stripe', stripeRouter)

app.use(express.json())

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// Blocks any authenticated request from a deactivated client. Runs after
// clerkMiddleware() (which decorates req with auth) on every mounted API
// router below. Paired with the Clerk session revocation that happens at
// deactivation time (server/routes/coachAdmin.js) — that logs the client out
// immediately, this stops any session (including a freshly-issued one) from
// reaching the app while client_status stays 'deactivated'.
async function blockDeactivatedClients(req, res, next) {
  try {
    const { userId } = getAuth(req)
    if (!userId) return next()
    const { rows } = await pool.query('SELECT client_status FROM users WHERE clerk_user_id = $1', [userId])
    if (rows[0]?.client_status === 'deactivated') {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact your coach.' })
    }
    next()
  } catch (err) { next(err) }
}

app.use('/api/users',      clerkMiddleware(), blockDeactivatedClients, orgContext, usersRouter)
app.use('/api/meals',      clerkMiddleware(), blockDeactivatedClients, orgContext, requireAssessmentComplete, mealsRouter)
app.use('/api/daily-logs', clerkMiddleware(), blockDeactivatedClients, orgContext, requireAssessmentComplete, dailyLogsRouter)
app.use('/api/coach',      clerkMiddleware(), blockDeactivatedClients, orgContext, coachRouter)
app.use('/api/community',       clerkMiddleware(), blockDeactivatedClients, orgContext, requireAssessmentComplete, communityRouter)
app.use('/api/progress-photos', clerkMiddleware(), blockDeactivatedClients, orgContext, requireAssessmentComplete, progressPhotosRouter)
app.use('/api/foods',           clerkMiddleware(), blockDeactivatedClients, orgContext, foodsRouter)
app.use('/api/admin',           clerkMiddleware(), blockDeactivatedClients, orgContext, adminRouter)
app.use('/api/recipes',         clerkMiddleware(), blockDeactivatedClients, orgContext, recipesRouter)
app.use('/api/custom-foods',    clerkMiddleware(), blockDeactivatedClients, orgContext, customFoodsRouter)
app.use('/api/workouts',        clerkMiddleware(), blockDeactivatedClients, orgContext, requireAssessmentComplete, workoutsRouter)
app.use('/api/workout-builder',   clerkMiddleware(), blockDeactivatedClients, orgContext, workoutBuilderRouter)
app.use('/api/gamification',      clerkMiddleware(), blockDeactivatedClients, orgContext, gamificationRouter)
app.use('/api/health-assessment', clerkMiddleware(), blockDeactivatedClients, orgContext, healthAssessmentRouter)
app.use('/api/coach-admin',       clerkMiddleware(), blockDeactivatedClients, orgContext, coachAdminRouter)
app.use('/api/client-habits',     clerkMiddleware(), blockDeactivatedClients, orgContext, requireAssessmentComplete, clientHabitsRouter)
app.use('/api/client-workouts',   clerkMiddleware(), blockDeactivatedClients, orgContext, clientWorkoutsRouter)
app.use('/api/messages',          clerkMiddleware(), blockDeactivatedClients, orgContext, messagesRouter)
app.use('/api/client-invites',    clerkMiddleware(), blockDeactivatedClients, orgContext, invitesRouter)
app.use('/api/staff-invites',     clerkMiddleware(), blockDeactivatedClients, orgContext, invitesRouter)
app.use('/api/weekly-checkins',  clerkMiddleware(), blockDeactivatedClients, orgContext, weeklyCheckinsRouter)
app.use('/api/forms',            clerkMiddleware(), blockDeactivatedClients, orgContext, formsRouter)
app.use('/api/measurements',     clerkMiddleware(), blockDeactivatedClients, orgContext, measurementsRouter)
app.use('/api/mindset-videos',        clerkMiddleware(), blockDeactivatedClients, orgContext, mindsetVideosRouter)
app.use('/api/brain-mapping-comments', clerkMiddleware(), blockDeactivatedClients, orgContext, brainMappingCommentsRouter)
app.use('/api/community-resources',   clerkMiddleware(), blockDeactivatedClients, orgContext, communityResourcesRouter)
app.use('/api/fitbit',                clerkMiddleware(), blockDeactivatedClients, orgContext, fitbitRouter)
app.use('/api/apple-health',          clerkMiddleware(), blockDeactivatedClients, orgContext, appleHealthRouter)
app.use('/api/bloodwork',             clerkMiddleware(), blockDeactivatedClients, orgContext, bloodworkRouter)
app.use('/api/push',                  clerkMiddleware(), blockDeactivatedClients, orgContext, pushRouter)
app.use('/api/staff-chat',            clerkMiddleware(), blockDeactivatedClients, orgContext, requireStaffMiddleware, staffChatRouter)
app.use('/api/organizations',         clerkMiddleware(), blockDeactivatedClients, orgContext, organizationsRouter)

// Demo seed endpoint — only mounted on staging / when explicitly allowed
if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_SEED === 'true') {
  import('./routes/demoSeed.js').then(({ default: demoSeedRouter }) => {
    app.use('/api/demo', demoSeedRouter)
    console.log('🌱 Demo seed endpoint mounted at /api/demo/seed')
  }).catch(err => console.error('Failed to load demoSeed router:', err.message))
}

// Admin backup status — admin-only, no sensitive data exposed
app.get('/api/admin/backup/status', clerkMiddleware(), blockDeactivatedClients, async (req, res) => {
  try {
    const { userId } = getAuth(req)
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const { rows } = await pool.query('SELECT role FROM users WHERE clerk_user_id = $1', [userId])
    if (!rows[0] || rows[0].role !== 'admin') return res.status(403).json({ error: 'Forbidden' })
    res.json(getBackupStatus())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


// Serve React client if dist exists — must come after all API routes
const distPath = path.join(__dirname, '../client/dist')
if (existsSync(distPath)) {
  app.use(express.static(distPath, {
    setHeaders(res, filePath) {
      if (path.basename(filePath) === 'index.html') {
        // Never cache the HTML entry point. The Android WebView (and some desktop
        // browsers) will otherwise serve a stale index.html that references an old
        // JS bundle hash, causing the app to run old code after a deploy.
        res.set('Cache-Control', 'no-store')
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        // Vite content-hashes every asset filename, so they can be cached forever.
        res.set('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  }))
  // SPA fallback — any path not matched by a static file serves index.html.
  // Also marked no-store so React Router deep-links always get the latest shell.
  app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

// Global JSON error handler — must be last, must have 4 params
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message)
  res.status(err.status ?? err.statusCode ?? 500).json({ error: err.message ?? 'Internal server error' })
})

migrate()
  .catch((err) => {
    console.warn('⚠ DB migration failed:', err.message)
    console.warn('Set DATABASE_URL in server/.env to enable meal persistence.')
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`WarriorFIT AI server running on http://localhost:${PORT}`)

      initPush()
      if (process.env.DISABLE_BACKGROUND_JOBS === 'true') {
        console.log('Background jobs disabled by DISABLE_BACKGROUND_JOBS=true')
        return
      }
      // Run inactivity check at startup, then every 24 hours
      runInactivityAlert()
      setInterval(runInactivityAlert, 24 * 60 * 60 * 1000)
      // Run form schedule processor at startup, then every 5 minutes
      console.log('[formScheduler] Scheduler started; running at startup and every 5 minutes')
      processFormSchedules()
      setInterval(processFormSchedules, 5 * 60 * 1000)
      // Postgres backup: daily (job_lock prevents duplicate runs across instances)
      runPostgresBackup()
      setInterval(runPostgresBackup, 24 * 60 * 60 * 1000)
      // Cloudinary metadata backup: weekly
      runCloudinaryBackup()
      setInterval(runCloudinaryBackup, 7 * 24 * 60 * 60 * 1000)
      // Google Health sync: hourly (job_lock prevents duplicate runs across instances)
      runHealthSync()
      setInterval(runHealthSync, 60 * 60 * 1000)
    })
  })
