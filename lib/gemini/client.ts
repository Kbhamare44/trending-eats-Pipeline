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
  classify: 'gemini-2.5-flash',
  extract: 'gemini-2.5-flash',
  summarize: 'gemini-2.5-flash',
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
      maxOutputTokens: opts.maxOutputTokens ?? 800,
      responseMimeType: 'application/json',
    },
  });

  // In @google/genai, response.text is a getter (not a function like the old SDK).
  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');

  return JSON.parse(text) as T;
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