import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase/client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { data, error } = await supabase
    .from('restaurants')
    .select(`
      *,
      reviews (
        id,
        tiktok_url,
        embed_html,
        sentiment,
        sentiment_score,
        dishes_mentioned,
        reviewer_summary,
        is_sponsored,
        created_at
      )
    `)
    .eq('id', id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 });
  }

  return NextResponse.json(data);
}