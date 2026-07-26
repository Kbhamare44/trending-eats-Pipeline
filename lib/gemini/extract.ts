import { generateJSON, MODELS } from './client';
import { ExtractionResult } from '@/lib/types';

const EXTRACTION_PROMPT = `You are a restaurant review analyst for a food discovery app that values authenticity.

Your job is to extract structured information from TikTok restaurant review captions.

SPONSORSHIP DETECTION — this is critical:
Look carefully for ANY of these signals:
- Hashtags: #ad, #sponsored, #gifted, #partner, #collab, #paidpartnership
- Phrases: "invited by", "hosted by", "gifted by", "thanks to [restaurant]", "in partnership with"
- Promo codes: any mention of a discount code or affiliate link
- Overly promotional language: no negatives mentioned, sounds like marketing copy
- Disclosure phrases: "paid post", "sponsored content", "brand partnership"

Authentic reviews typically:
- Mention at least one negative or criticism
- Use casual, personal language
- Share specific personal experience details
- Don't use promotional call-to-actions

Return ONLY valid JSON with no markdown formatting.`;

export async function extractRestaurantData(
  caption: string,
  creatorUsername: string,
  city?: string
): Promise<ExtractionResult> {
  const cityContext = city ? `The video appears to be from ${city}.` : '';

  const userMessage = `Caption: "${caption}"
Creator: @${creatorUsername}
${cityContext}

Extract restaurant information and return JSON in exactly this format:
{
  "restaurantName": "exact restaurant name or null if not mentioned",
  "city": "city name or null",
  "cuisine": "cuisine type (Italian, Japanese, etc.) or null",
  "dishesMentioned": ["array", "of", "specific", "dishes"],
  "sentiment": "positive" | "neutral" | "negative",
  "sentimentScore": number from -1.0 (very negative) to 1.0 (very positive),
  "pros": ["array of positive things mentioned"],
  "cons": ["array of negative things mentioned"],
  "atmosphere": "description of vibe/atmosphere or null",
  "priceRange": "$" | "$$" | "$$$" | "$$$$" | null,
  "goodFor": ["date night", "family", "brunch", "groups", "solo", "quick lunch"],
  "reviewerSummary": "one sentence summary of the reviewer's overall take",
  "isSponsored": boolean,
  "sponsorshipConfidence": number from 0 to 1,
  "sponsorshipSignals": ["list any specific signals found, empty array if none"]
}`;

  try {
    const result = await generateJSON<any>({
      model: MODELS.extract,
      systemInstruction: EXTRACTION_PROMPT,
      userMessage,
      temperature: 0.1,
      maxOutputTokens: 800,
    });

    // Normalize into the ExtractionResult shape with safe defaults.
    return {
      restaurantName: result.restaurantName || null,
      city: result.city || null,
      cuisine: result.cuisine || null,
      dishesMentioned: result.dishesMentioned || [],
      sentiment: result.sentiment || 'neutral',
      sentimentScore: result.sentimentScore ?? 0,
      pros: result.pros || [],
      cons: result.cons || [],
      atmosphere: result.atmosphere || null,
      priceRange: result.priceRange || null,
      goodFor: result.goodFor || [],
      reviewerSummary: result.reviewerSummary || '',
      isSponsored: result.isSponsored || false,
      sponsorshipConfidence: result.sponsorshipConfidence ?? 0,
      sponsorshipSignals: result.sponsorshipSignals || [],
    } as ExtractionResult;
  } catch (error: any) {
    throw new Error(`Extraction failed: ${error.message}`);
  }
}