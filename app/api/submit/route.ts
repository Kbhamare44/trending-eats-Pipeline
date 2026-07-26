import { NextRequest, NextResponse } from 'next/server';
import { createRawSubmission } from '@/lib/supabase/queries';
import { processSubmission } from '@/lib/pipeline/processor';
import { aggregateRestaurantReviews } from '@/lib/pipeline/aggregator';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tiktokUrl, userId } = body;

    if (!tiktokUrl) {
      return NextResponse.json({ error: 'tiktokUrl is required' }, { status: 400 });
    }
    if (!tiktokUrl.includes('tiktok.com')) {
      return NextResponse.json({ error: 'URL must be a TikTok link' }, { status: 400 });
    }

    const submissionId = await createRawSubmission(tiktokUrl, userId || null);
    const result = await processSubmission(submissionId, tiktokUrl);

    if (result.success && result.restaurantId) {
      await aggregateRestaurantReviews(result.restaurantId);
    }

    return NextResponse.json({ submissionId, ...result });
  } catch (error: any) {
    console.error('[API/submit]', error.message);
    return NextResponse.json(
      { error: 'Internal server error', detail: error.message },
      { status: 500 }
    );
  }
}