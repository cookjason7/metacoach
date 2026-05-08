import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { clerkMiddleware } from '@clerk/express'
import { migrate } from './db.js'
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
import { runInactivityAlert } from './jobs/inactivityAlert.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? true : 'http://localhost:5173',
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
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

// Serve React client in production — must come after all API routes
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')))
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'))
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
      // Run inactivity check at startup, then every 24 hours
      runInactivityAlert()
      setInterval(runInactivityAlert, 24 * 60 * 60 * 1000)
    })
  })
