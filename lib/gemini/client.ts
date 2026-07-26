import { GoogleGenAI } from '@google/genai';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY environment variable is required');
}

// One client for the whole pipeline.
// Never expose this to the browser — it uses your secret API key.
export const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// All model IDs in one place. If Google renames a model, change it here only.
export const MODELS = {
  classify: 'gemini-flash-latest',
  extract: 'gemini-flash-latest',
  summarize: 'gemini-flash-latest',
} as const;

// Shared helper: send a prompt, force JSON out, return it parsed.
// Gemini's equivalent of OpenAI's response_format: { type: 'json_object' }
// is config.responseMimeType: 'application/json'.
export async function generateJSON<T>(opts: {
  model: string;
  systemInstruction: string;
  userMessage: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<T> {
  const response = await gemini.models.generateContent({
    model: opts.model,
    contents: opts.userMessage,
    config: {
      systemInstruction: opts.systemInstruction,
      temperature: opts.temperature ?? 0.1,
      maxOutputTokens: opts.maxOutputTokens ?? 4000,
      responseMimeType: 'application/json',
    },
  });

  // In @google/genai, response.text is a getter (not a function like the old SDK).
// In @google/genai, response.text is a getter (not a function like the old SDK).
const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');

  // Gemini sometimes wraps JSON in ```json ... ``` fences or adds stray text.
  // Strip fences and extract the JSON object before parsing.
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();

  // Fallback: grab the first {...} block if there's still surrounding text
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];

  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    throw new Error(`Failed to parse Gemini JSON. Raw response: ${text.slice(0, 200)}`);
  };
}

// Shared helper for plain-text generation (used by the aggregator's summary).
export async function generateText(opts: {
  model: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<string> {
  const response = await gemini.models.generateContent({
    model: opts.model,
    contents: opts.prompt,
    config: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxOutputTokens ?? 200,
    },
  });
  return response.text ?? '';
}