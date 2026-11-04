/**
 * DELETE /api/account — delete the signed-in user and their personal data.
 *
 * WHY THIS EXISTS RATHER THAN THE EDGE FUNCTION: the app called a Supabase
 * edge function named `delete-user`. That function is deployed (it answers
 * 401 for a bad token rather than 404), but it cannot be deleting the right
 * rows: `restaurant_saves`, `restaurant_feedback` and `engagement_events`
 * were created in the v2 migrations, after it was written, and none of them
 * has a foreign key to `auth.users` — their `user_id` is a bare uuid. So
 * deleting the auth row cascades NOTHING.
 *
 * Left as it was, a person could delete their account and their ratings would
 * keep feeding the public experience score of real restaurants forever. That
 * is both an Apple problem and a straightforward privacy failure.
 *
 * ── DELETE vs ANONYMISE ──
 *
 * Hard-deleted, because it is personal activity and nobody else depends on it:
 *   restaurant_saves       what they bookmarked
 *   restaurant_feedback    their ratings and comments
 *   engagement_events      their views, saves and searches
 *
 * Anonymised rather than deleted:
 *   raw_submissions.submitted_by -> null
 *
 * A submission produced a restaurant and a review that other people now rely
 * on, and that content is public and about a business, not about the
 * submitter. Deleting it would remove restaurants from the map because an
 * unrelated person closed their account. Dropping the link to the person
 * removes the personal data while leaving the public record intact.
 *
 * The auth user is deleted last, so a failure partway through leaves an
 * account that can retry rather than orphaned rows with no owner.
 */

import type { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import { getAuthedUser } from '@/lib/auth/verify';
import { ok, unauthorized, serverError } from '@/lib/http/respond';

export async function DELETE(request: NextRequest) {
  try {
    const user = await getAuthedUser(request);
    if (!user) {
      return unauthorized('Sign in to delete your account');
    }

    const deleted: Record<string, number> = {};

    // Count before deleting so the response can state what actually went,
    // which is what makes this verifiable rather than merely plausible.
    for (const table of [
      'restaurant_saves',
      'restaurant_feedback',
      'engagement_events',
    ] as const) {
      const { data, error } = await supabase
        .from(table)
        .delete()
        .eq('user_id', user.id)
        .select('id');

      if (error) {
        // engagement_events is the one that can be large; a failure here
        // must not leave the auth user deleted with rows still pointing at
        // it, so stop before touching auth.
        return serverError(
          new Error(`Could not clear ${table}: ${error.message}`),
          'API/account'
        );
      }
      deleted[table] = data?.length ?? 0;
    }

    const { data: anonymised, error: anonError } = await supabase
      .from('raw_submissions')
      .update({ submitted_by: null })
      .eq('submitted_by', user.id)
      .select('id');

    if (anonError) {
      return serverError(
        new Error(`Could not anonymise submissions: ${anonError.message}`),
        'API/account'
      );
    }
    deleted['raw_submissions_anonymised'] = anonymised?.length ?? 0;

    // Finally the auth row. This needs the service key and the admin client;
    // the shared client is created without the auth options admin calls want.
    const admin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_KEY as string,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { error: authError } = await admin.auth.admin.deleteUser(user.id);
    if (authError) {
      return serverError(
        new Error(`Data removed but the account could not be deleted: ${authError.message}`),
        'API/account'
      );
    }

    console.log(`[Account] deleted ${user.id}:`, JSON.stringify(deleted));

    return ok({
      ok: true,
      deleted,
      message: 'Your account and your data have been deleted.',
    });
  } catch (err) {
    return serverError(err, 'API/account');
  }
}
