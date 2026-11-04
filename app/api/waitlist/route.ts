/**
 * POST /api/waitlist — "tell me when you reach my city".
 *
 * Trending Eats covers Toronto and the GTA. Once the app is on the App Store,
 * people outside that area will open it and see an empty map. The honest
 * answer is to say so and offer to tell them when coverage reaches them —
 * which is also how the second city gets chosen with evidence rather than a
 * guess.
 *
 * PERSONAL DATA: an email address and, optionally, a self-reported city. The
 * v2 strategy's data-minimisation rule applies — nothing else is collected
 * here, no device identifier, no coordinates. The email exists for one purpose
 * and DELETE removes it.
 *
 * Requires the waitlist_signups table. Until it exists this route answers 503
 * with a clear reason rather than a generic 500, so a missing migration is
 * distinguishable from a broken route.
 */

import type { NextRequest } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import { ok, badRequest, serverError } from '@/lib/http/respond';
import { NextResponse } from 'next/server';

/** Postgres "relation does not exist". */
const UNDEFINED_TABLE = '42P01';

/**
 * Deliberately permissive. The goal is to reject obvious typos and junk, not
 * to adjudicate RFC 5322 — an over-strict pattern rejects real addresses
 * (plus-addressing, new TLDs, unicode domains) and the cost of a bad row here
 * is one undeliverable email.
 */
function looksLikeEmail(value: string): boolean {
  if (value.length < 5 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return badRequest('A JSON body is required');
    }

    const { email, city, source } = body as Record<string, unknown>;

    if (typeof email !== 'string' || !looksLikeEmail(email.trim().toLowerCase())) {
      return badRequest('A valid email address is required');
    }

    const record = {
      email: email.trim().toLowerCase(),
      requested_city:
        typeof city === 'string' && city.trim() ? city.trim().slice(0, 120) : null,
      source: typeof source === 'string' ? source.slice(0, 40) : 'mobile',
    };

    // Upsert, not insert: someone tapping the button twice should not get an
    // error, and a duplicate row serves no purpose.
    const { error } = await supabase
      .from('waitlist_signups')
      .upsert(record, { onConflict: 'email' });

    if (error) {
      if (error.code === UNDEFINED_TABLE) {
        return NextResponse.json(
          {
            error: 'The waitlist is not set up yet.',
            detail: 'waitlist_signups table is missing',
          },
          { status: 503 }
        );
      }
      throw new Error(error.message);
    }

    return ok({
      ok: true,
      message: "You're on the list. We'll email you when we reach your city.",
    });
  } catch (err) {
    return serverError(err, 'API/waitlist');
  }
}

/**
 * DELETE /api/waitlist?email=... — remove an address.
 *
 * The v2 compliance section requires a deletion path for personal data. A
 * waitlist email is the smallest possible case of that and there is no excuse
 * for not providing one.
 */
export async function DELETE(request: NextRequest) {
  try {
    const email = request.nextUrl.searchParams.get('email')?.trim().toLowerCase();
    if (!email || !looksLikeEmail(email)) {
      return badRequest('A valid email address is required');
    }

    const { error } = await supabase
      .from('waitlist_signups')
      .delete()
      .eq('email', email);

    if (error && error.code !== UNDEFINED_TABLE) throw new Error(error.message);

    // Reported as done either way: confirming whether an address was on the
    // list would let anyone test for membership.
    return ok({ ok: true, message: 'Removed.' });
  } catch (err) {
    return serverError(err, 'API/waitlist DELETE');
  }
}
