import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message)
      err.status = 504
      throw err
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const LABEL_TOOL = {
  name:        'parse_nutrition_label',
  description: 'Output the parsed nutrition label data as a custom food entry',
  input_schema: {
    type:     'object',
    required: ['is_nutrition_label', 'food_name', 'calories_per_serving'],
    properties: {
      is_nutrition_label: {
        type:        'boolean',
        description: 'true if this image is a Nutrition Facts or Supplement Facts panel; false if it is a recipe, food photo, menu, or other content',
      },
      food_name: {
        type:        'string',
        description: 'Product or food name. Use brand + product name if both visible (e.g. "Optimum Nutrition Gold Standard Whey Chocolate"). If only a generic label, infer a reasonable name.',
      },
      brand: {
        type:        'string',
        description: 'Brand name if clearly visible on the label',
      },
      serving_size: {
        type:        'number',
        description: 'Numeric serving size value (e.g. 30 for "30g", 1 for "1 scoop")',
      },
      serving_unit: {
        type:        'string',
        description: 'Unit for serving size (e.g. "g", "oz", "ml", "scoop", "tablet", "capsule", "cup")',
      },
      servings_per_container: {
        type:        'number',
        description: 'Servings per container if listed on the label',
      },
      calories_per_serving: {
        type:        'number',
        description: 'Calories per serving as shown on the label',
      },
      protein: {
        type:        'number',
        description: 'Protein in grams per serving',
      },
      carbs: {
        type:        'number',
        description: 'Total carbohydrates in grams per serving',
      },
      fat: {
        type:        'number',
        description: 'Total fat in grams per serving',
      },
      fiber: {
        type:        'number',
        description: 'Dietary fiber in grams per serving, if listed',
      },
    },
  },
}

const LABEL_SYSTEM = `You are a nutrition label parser for a health and fitness tracking app.

Given an image, decide first whether it is a Nutrition Facts panel, Supplement Facts panel, or food product label.

If it IS a nutrition/supplement label:
- Set is_nutrition_label to true
- Extract food_name: use product name + brand if visible. Examples: "Gold Standard Whey Chocolate", "Quest Protein Bar Cookies & Cream"
- Extract serving_size and serving_unit from the "Serving Size" line (e.g. "1 scoop (30g)" → size=1, unit="scoop" OR size=30, unit="g")
- Extract all visible macros per serving: calories, protein, total carbs, total fat, fiber if listed
- Only extract values clearly shown on the label — do not estimate or invent values
- All values must be per serving, not per 100g (unless the label explicitly uses per 100g)

If it is NOT a label (recipe, plated food photo, menu, unrelated image):
- Set is_nutrition_label to false
- food_name and calories_per_serving can be empty strings / 0`

function validateLabel(aiResult) {
  if (!aiResult.is_nutrition_label) {
    const err = new Error('NOT_A_LABEL')
    err.status  = 422
    err.code    = 'NOT_A_LABEL'
    throw err
  }

  const food_name = String(aiResult.food_name ?? '').trim()
  if (!food_name) {
    const err = new Error('Could not read a food name from the label. Try a clearer photo.')
    err.status = 422
    throw err
  }

  const calories = parseFloat(aiResult.calories_per_serving)
  if (!Number.isFinite(calories) || calories < 0) {
    const err = new Error('Could not read calorie information from the label. Try a clearer photo.')
    err.status = 422
    throw err
  }

  return {
    food_name,
    brand:                  aiResult.brand?.trim() || null,
    serving_size:           parseFloat(aiResult.serving_size)           || null,
    serving_unit:           String(aiResult.serving_unit ?? '').trim()  || 'serving',
    servings_per_container: parseFloat(aiResult.servings_per_container) || null,
    calories_per_serving:   Math.round(calories),
    protein:                parseFloat(aiResult.protein) || null,
    carbs:                  parseFloat(aiResult.carbs)   || null,
    fat:                    parseFloat(aiResult.fat)     || null,
    fiber:                  parseFloat(aiResult.fiber)   || null,
  }
}

export async function parseLabelFromImageWithAI(buffer, mediaType) {
  const base64 = buffer.toString('base64')

  const parsePromise = anthropic.messages.create({
    model:       'claude-sonnet-4-6',
    max_tokens:  2048,
    system:      LABEL_SYSTEM,
    tools:       [LABEL_TOOL],
    tool_choice: { type: 'tool', name: 'parse_nutrition_label' },
    messages: [{
      role:    'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text',  text: 'Parse the nutrition label in this image and extract the food data.' },
      ],
    }],
  })

  const response = await withTimeout(
    parsePromise,
    50000,
    'Label scan timed out. Please try again.',
  )

  const toolBlock = response.content.find(b => b.type === 'tool_use')
  if (!toolBlock?.input) {
    const err = new Error('Could not read the nutrition label from this image. Try a clearer, well-lit photo.')
    err.status = 422
    throw err
  }

  return validateLabel(toolBlock.input)
}
