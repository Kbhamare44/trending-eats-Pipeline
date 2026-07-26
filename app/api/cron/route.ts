import { NextRequest, NextResponse } from 'next/server';
import { getPendingSubmissions } from '@/lib/supabase/queries';
import { processSubmission } from '@/lib/pipeline/processor';
import { aggregateRestaurantReviews } from '@/lib/pipeline/aggregator';

// This route is called by Vercel Cron every 5 minutes
// Processes up to 5 pending submissions per run
export async function GET(request: NextRequest) {
  // Verify this is called by our cron, not random people
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.PIPELINE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const pending = await getPendingSubmissions(5);
    console.log(`[Cron] Processing ${pending.length} submissions`);

    const results = await Promise.allSettled(
      pending.map(async (submission: any) => {
        const result = await processSubmission(submission.id, submission.tiktok_url);
        if (result.success && result.restaurantId) {
          await aggregateRestaurantReviews(result.restaurantId);
        }
        return result;
      })
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    return NextResponse.json({
      processed: pending.length,
      succeeded,
      failed,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}