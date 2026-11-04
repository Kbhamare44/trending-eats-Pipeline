/**
 * Small response helpers so every route returns the same error shape and the
 * mobile client can rely on `{ error: string }` being present on failures.
 */

import { NextResponse } from 'next/server';

export interface ErrorBody {
  error: string;
  detail?: string;
}

export function ok<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, { status: 200, ...init });
}

export function created<T>(body: T): NextResponse {
  return NextResponse.json(body, { status: 201 });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

export function badRequest(message: string, detail?: string): NextResponse {
  return NextResponse.json<ErrorBody>(
    { error: message, ...(detail ? { detail } : {}) },
    { status: 400 }
  );
}

export function unauthorized(
  message = 'Sign in to do that'
): NextResponse {
  return NextResponse.json<ErrorBody>({ error: message }, { status: 401 });
}

export function notFound(message = 'Not found'): NextResponse {
  return NextResponse.json<ErrorBody>({ error: message }, { status: 404 });
}

export function serverError(err: unknown, context: string): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${context}]`, message);
  return NextResponse.json<ErrorBody>(
    {
      error: 'Something went wrong',
      // Surfaced only outside production — avoids leaking internals to users
      // while keeping local debugging usable.
      ...(process.env.NODE_ENV !== 'production' ? { detail: message } : {}),
    },
    { status: 500 }
  );
}

/** Parse a positive integer query param with a cap and a default. */
export function intParam(
  value: string | null,
  fallback: number,
  max: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
