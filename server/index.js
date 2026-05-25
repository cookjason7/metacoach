import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { clerkMiddleware, getAuth } from '@clerk/express'
import { migrate, pool } from './db.js'
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
import gamificationRouter from './routes/gamification.js'
import healthAssessmentRouter from './routes/healthAssessment.js'
import coachAdminRouter from './routes/coachAdmin.js'
import clientHabitsRouter from './routes/clientHabits.js'
import messagesRouter from './routes/messages.js'
import invitesRouter from './routes/invites.js'
import weeklyCheckinsRouter from './routes/weeklyCheckins.js'
import formsRouter from './routes/forms.js'
import measurementsRouter from './routes/measurements.js'
import mindsetVideosRouter from './routes/mindsetVideos.js'
import communityResourcesRouter from './routes/communityResources.js'
import stripeRouter from './routes/stripe.js'
import fitbitRouter from './routes/fitbit.js'
import bloodworkRouter from './routes/bloodwork.js'
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
  ],
  credentials: true,
}))
// Stripe webhook MUST be mounted before express.json() — it needs the raw body
// for signature verification. express.raw() is applied only to this one route
// inside the stripe router.
app.use('/api/stripe', stripeRouter)

app.use(express.json())

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

app.use('/api/users',      clerkMiddleware(), usersRouter)
app.use('/api/meals',      clerkMiddleware(), mealsRouter)
app.use('/api/daily-logs', clerkMiddleware(), dailyLogsRouter)
app.use('/api/coach',      clerkMiddleware(), coachRouter)
app.use('/api/community',       clerkMiddleware(), communityRouter)
app.use('/api/progress-photos', clerkMiddleware(), progressPhotosRouter)
app.use('/api/foods',           clerkMiddleware(), foodsRouter)
app.use('/api/admin',           clerkMiddleware(), adminRouter)
app.use('/api/recipes',         clerkMiddleware(), recipesRouter)
app.use('/api/custom-foods',    clerkMiddleware(), customFoodsRouter)
app.use('/api/workouts',        clerkMiddleware(), workoutsRouter)
app.use('/api/gamification',      clerkMiddleware(), gamificationRouter)
app.use('/api/health-assessment', clerkMiddleware(), healthAssessmentRouter)
app.use('/api/coach-admin',       clerkMiddleware(), coachAdminRouter)
app.use('/api/client-habits',     clerkMiddleware(), clientHabitsRouter)
app.use('/api/messages',          clerkMiddleware(), messagesRouter)
app.use('/api/client-invites',    clerkMiddleware(), invitesRouter)
app.use('/api/weekly-checkins',  clerkMiddleware(), weeklyCheckinsRouter)
app.use('/api/forms',            clerkMiddleware(), formsRouter)
app.use('/api/measurements',     clerkMiddleware(), measurementsRouter)
app.use('/api/mindset-videos',        clerkMiddleware(), mindsetVideosRouter)
app.use('/api/community-resources',   clerkMiddleware(), communityResourcesRouter)
app.use('/api/fitbit',                fitbitRouter)
app.use('/api/bloodwork',             clerkMiddleware(), bloodworkRouter)

// Demo seed endpoint — only mounted on staging / when explicitly allowed
if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_SEED === 'true') {
  import('./routes/demoSeed.js').then(({ default: demoSeedRouter }) => {
    app.use('/api/demo', demoSeedRouter)
    console.log('🌱 Demo seed endpoint mounted at /api/demo/seed')
  }).catch(err => console.error('Failed to load demoSeed router:', err.message))
}

// Admin backup status — admin-only, no sensitive data exposed
app.get('/api/admin/backup/status', clerkMiddleware(), async (req, res) => {
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
  app.use(express.static(distPath))
  app.get('*', (req, res) => {
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
      console.log(`MetaCoach server running on http://localhost:${PORT}`)
      if (process.env.DISABLE_BACKGROUND_JOBS === 'true') {
        console.log('Background jobs disabled by DISABLE_BACKGROUND_JOBS=true')
        return
      }
      // Run inactivity check at startup, then every 24 hours
      runInactivityAlert()
      setInterval(runInactivityAlert, 24 * 60 * 60 * 1000)
      // Run form schedule processor at startup, then every hour
      console.log('[formScheduler] Scheduler started; running at startup and every 60 minutes')
      processFormSchedules()
      setInterval(processFormSchedules, 60 * 60 * 1000)
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
