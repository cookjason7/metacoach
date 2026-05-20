import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { getAuth } from '@clerk/express'

const keyGenerator = (req) => getAuth(req).userId ?? ipKeyGenerator(req)

export const chatLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many coach chat messages. Please wait a bit and try again.' },
})

export const mealAnalyzeLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many meal photo analyses. Please wait a bit and try again.' },
})

export const mealTextLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many meal text logs. Please wait a bit and try again.' },
})

export const workoutGenLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 5,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many workout plan generations today. Please try again later.' },
})

export const photoUploadLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many photo uploads. Please wait a bit and try again.' },
})

export const recipeImportLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many recipe imports. Please wait a bit and try again.' },
})
