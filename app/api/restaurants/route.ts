import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase/client';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get('city');
  const cuisine = searchParams.get('cuisine');
  const lat = searchParams.get('lat');
  const lng = searchParams.get('lng');
  const limit = parseInt(searchParams.get('limit') || '20');
  const sort = searchParams.get('sort') || 'authenticity';

  try {
    let query = supabase
      .from('restaurants')
      .select(`
        *,
        reviews (
          id,
          tiktok_url,
          thumbnail_url,
          sentiment,
          sentiment_score,
          dishes_mentioned,
          reviewer_summary,
          is_sponsored,
          created_at
        )
      `)
      
      .limit(limit);

    if (city) {
      query = query.ilike('city', `%${city}%`);
    }

    if (cuisine) {
      query = query.ilike('cuisine_type', `%${cuisine}%`);
    }

    if (sort === 'authenticity') {
      query = query.order('authenticity_score', { ascending: false });
    } else if (sort === 'reviews') {
      query = query.order('review_count', { ascending: false });
    } else if (sort === 'sentiment') {
      query = query.order('avg_sentiment', { ascending: false });
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json(data || []);
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}