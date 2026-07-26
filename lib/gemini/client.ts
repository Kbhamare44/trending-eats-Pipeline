import { GoogleGenAI } from '@google/genai';

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY environment variable is required');
}

// One client for the whole pipeline.
export const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// All model IDs in one place.
export const MODELS = {
  classify: 'gemini-flash-latest',
  extract: 'gemini-flash-latest',
  summarize: 'gemini-flash-latest',
} as const;

// Shared helper: send a prompt, force JSON out, return it parsed.
// NOTE: gemini-flash-latest is a "thinking" model with thinking ON by default.
// Thinking tokens count against maxOutputTokens, so we set a HIGH ceiling
// (8192) to leave room for both the reasoning and the JSON answer. We do NOT
// set thinkingBudget:0 — 3.x flash models reject it with 400 INVALID_ARGUMENT.
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
      maxOutputTokens: opts.maxOutputTokens ?? 32768,
      responseMimeType: 'application/json',
    },
  });

  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');

  // Strip markdown fences and extract the first {...} block before parsing.
  let cleaned = text.trim();
  cleaned = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```$/, '')
    .trim();

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];

  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    throw new Error(`Bad JSON (len ${text.length}): ${text.slice(0, 300)}`);
  }
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
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
    },
  });
  return response.text ?? '';
}