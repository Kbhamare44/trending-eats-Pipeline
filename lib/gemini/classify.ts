import { generateJSON, MODELS } from './client';
import { ClassificationResult } from '@/lib/types';

const CLASSIFICATION_PROMPT = `You are an expert content classifier for a food discovery app.

Analyze the provided TikTok caption and determine what type of content it is.

Content types:
- restaurant_review: The creator visited a specific restaurant and is sharing their experience
- recipe: Showing how to cook or make a dish at home
- cooking_tutorial: Teaching cooking techniques or methods
- travel_vlog: Travel content that may mention food incidentally
- unrelated: Not food related at all

Important rules:
- Only classify as restaurant_review if a specific restaurant or food establishment is being reviewed/visited
- Food hauls from grocery stores are NOT restaurant reviews
- Home cooking content is NOT a restaurant review
- Even if food looks amazing, if it's homemade it's not a restaurant review
- Captions may include long rating scales, scoring rubrics, or hashtags. Ignore these and focus on whether a specific restaurant/food establishment is being visited or reviewed.
- Many food reviewers include a long rating scale or scoring rubric in the caption (e.g. "9/10: loved it, 8/10: solid"). This rubric is NOT the content — ignore it completely.
- If the caption names a specific restaurant and mentions eating or visiting there, it IS a restaurant_review, even if most of the caption is a rating scale or hashtags.


Return ONLY valid JSON with no markdown, no explanation, just the JSON object.`;

export async function classifyContent(
  caption: string,
  creatorUsername: string
): Promise<ClassificationResult> {
  const userMessage = `Caption: "${caption}"
Creator: @${creatorUsername}

Classify this content and return JSON in exactly this format:
{
  "isRestaurantReview": boolean,
  "contentType": "restaurant_review" | "recipe" | "cooking_tutorial" | "travel_vlog" | "unrelated",
  "confidence": number between 0 and 1,
  "reasoning": "one sentence explanation"
}`;

  try {
    const result = await generateJSON<ClassificationResult>({
      model: MODELS.classify,
      systemInstruction: CLASSIFICATION_PROMPT,
      userMessage,
      temperature: 0,   // deterministic classification
      maxOutputTokens: 200,
    });

    // Validate the response has the required field
    if (typeof result.isRestaurantReview !== 'boolean') {
      throw new Error('Invalid classification response structure');
    }

    return result;
  } catch (error: any) {
    console.error('Classification error:', error.message);
    // Fail safe: treat as not-a-review on any error
    return {
      isRestaurantReview: false,
      contentType: 'unrelated',
      confidence: 0,
      reasoning: `Classification failed: ${error.message}`,
    };
  }
}