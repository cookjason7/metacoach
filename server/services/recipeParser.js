import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

// Shared tool schema for both text and image parsing
const RECIPE_TOOL = {
  name:        'create_recipe',
  description: 'Output the complete parsed recipe with ingredients and estimated nutrition',
  input_schema: {
    type:     'object',
    required: ['name', 'servings', 'ingredients'],
    properties: {
      name: {
        type:        'string',
        description: 'Recipe name',
      },
      servings: {
        type:        'number',
        description: 'Total servings this recipe makes (e.g. 4)',
      },
      notes: {
        type:        'string',
        description: 'Optional brief recipe notes or tips',
      },
      ingredients: {
        type:  'array',
        items: {
          type:     'object',
          required: ['food_name', 'amount'],
          properties: {
            food_name: {
              type:        'string',
              description: 'Ingredient name (e.g. "Chicken Breast", "Brown Rice")',
            },
            amount: {
              type:        'number',
              description: 'Numeric quantity (e.g. 200 for 200g, 1 for 1 cup)',
            },
            unit: {
              type:        'string',
              description: 'Unit string (e.g. "g", "oz", "cup", "tbsp", "piece")',
            },
            calories: {
              type:        'number',
              description: 'Estimated calories for this ingredient at the given amount',
            },
            protein: {
              type:        'number',
              description: 'Estimated protein in grams',
            },
            carbs: {
              type:        'number',
              description: 'Estimated carbohydrates in grams',
            },
            fat: {
              type:        'number',
              description: 'Estimated fat in grams',
            },
            fiber: {
              type:        'number',
              description: 'Estimated fiber in grams (optional)',
            },
          },
        },
      },
    },
  },
}

const TEXT_SYSTEM = `You are a recipe parser for a health and fitness nutrition tracking app. Given raw recipe text pasted by a user, extract a structured recipe with ingredients and estimated nutrition.

Extraction rules:
- Extract the recipe name from the title or heading
- Extract total servings (how many servings the recipe makes). If not specified, estimate based on typical yield or default to 4
- Extract each ingredient as a separate item with name, amount, and unit
- Estimate calories and macros (protein, carbs, fat) per ingredient based on standard nutritional data for 100g portions adjusted to the given amount. Be practical — use common knowledge.
- fiber is optional; include if clearly determinable
- amount should be the numeric quantity; unit should be the unit string (g, oz, cup, tbsp, tsp, piece, etc.)
- If an ingredient amount is ambiguous (e.g. "1 can of chickpeas"), use a reasonable gram equivalent
- notes: any brief recipe tips or notes worth preserving (keep under 200 chars, omit if nothing useful)
- All calorie/macro values are estimates — users will review before saving`

const IMAGE_SYSTEM = `You are a recipe parser for a health and fitness nutrition tracking app. Given a recipe image (screenshot, photo of a recipe card, cookbook page, handwritten recipe, etc.), extract a structured recipe with ingredients and estimated nutrition.

Extraction rules:
- Extract the recipe name from the title or heading visible in the image
- Extract total servings (how many servings the recipe makes). If not specified, estimate based on typical yield or default to 4
- Extract each ingredient visible in the image as a separate item with name, amount, and unit
- Estimate calories and macros (protein, carbs, fat) per ingredient based on standard nutritional data. Be practical — use common knowledge.
- fiber is optional; include if clearly determinable
- amount should be the numeric quantity; unit should be the unit string (g, oz, cup, tbsp, tsp, piece, etc.)
- If an ingredient amount is partially visible or ambiguous, use a reasonable estimate
- notes: any brief recipe tips or instructions visible in the image (keep under 200 chars, omit if nothing useful)
- All calorie/macro values are estimates — users will review before saving
- If the image is not clearly a recipe (e.g. a photo of plated food, a nutrition label, or unrelated content), still do your best — return what you can see, using "Unknown Recipe" as the name if no title is visible`

function validateAndNormalize(aiResult) {
  const name = aiResult.name?.trim()
  if (!name || name === 'Unknown Recipe' && (!Array.isArray(aiResult.ingredients) || !aiResult.ingredients.length)) {
    const err = new Error('AI could not determine a recipe from this image. Try a clearer photo or paste the text instead.')
    err.status = 422
    throw err
  }
  if (!name) {
    const err = new Error('AI could not determine a recipe name.')
    err.status = 422
    throw err
  }

  const servings = parseFloat(aiResult.servings)
  if (!Number.isFinite(servings) || servings <= 0) {
    const err = new Error('AI could not determine a valid serving count.')
    err.status = 422
    throw err
  }

  let ingredients = Array.isArray(aiResult.ingredients) ? aiResult.ingredients : []
  if (!ingredients.length) {
    const err = new Error('AI could not extract any ingredients. Try a clearer photo or paste the recipe text instead.')
    err.status = 422
    throw err
  }

  const normalized = ingredients.map(ing => {
    const food_name = String(ing.food_name ?? ing.name ?? '').trim()
    if (!food_name) return null

    const calories = parseFloat(ing.calories) || null
    const protein  = parseFloat(ing.protein)  || null
    const carbs    = parseFloat(ing.carbs)    || null
    const fat      = parseFloat(ing.fat)      || null
    const fiber    = parseFloat(ing.fiber)    || null
    const amount   = parseFloat(ing.amount)   || null
    const unit     = String(ing.unit ?? '').trim() || null

    return { food_name, calories, protein, carbs, fat, fiber, amount, unit }
  }).filter(Boolean)

  if (!normalized.length) {
    const err = new Error('AI could not extract valid ingredients. Try a clearer photo or paste the recipe text instead.')
    err.status = 422
    throw err
  }

  return {
    name,
    servings,
    notes: aiResult.notes?.trim() || null,
    ingredients: normalized,
  }
}

// Parse recipe from pasted text
export async function parseRecipeWithAI(recipeText) {
  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    system:     TEXT_SYSTEM,
    tools:      [RECIPE_TOOL],
    tool_choice: { type: 'tool', name: 'create_recipe' },
    messages:    [{ role: 'user', content: recipeText.slice(0, 15000) }],
  })

  const toolBlock = response.content.find(b => b.type === 'tool_use')
  if (!toolBlock?.input) {
    const err = new Error('AI did not return a structured recipe. Try simplifying or reformatting the input text.')
    err.status = 422
    throw err
  }

  return validateAndNormalize(toolBlock.input)
}

// Parse recipe from uploaded image (buffer + MIME type)
export async function parseRecipeFromImageWithAI(buffer, mediaType) {
  const base64 = buffer.toString('base64')

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    system:     IMAGE_SYSTEM,
    tools:      [RECIPE_TOOL],
    tool_choice: { type: 'tool', name: 'create_recipe' },
    messages: [{
      role:    'user',
      content: [
        {
          type:   'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: 'Extract the complete recipe from this image, including all visible ingredients with amounts, units, and estimated nutrition values.',
        },
      ],
    }],
  })

  const toolBlock = response.content.find(b => b.type === 'tool_use')
  if (!toolBlock?.input) {
    const err = new Error('AI could not read the recipe from this image. Try a clearer photo or paste the text instead.')
    err.status = 422
    throw err
  }

  return validateAndNormalize(toolBlock.input)
}
