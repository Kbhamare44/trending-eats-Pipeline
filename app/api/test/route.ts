import { NextResponse } from 'next/server';
import { fetchTikTokData } from '@/lib/pipeline/tiktok';

export async function GET() {
  try {
    const url = 'https://www.tiktok.com/@fifaworldcup/video/7664374143470685462?is_from_webapp=1&sender_device=pc';
    const data = await fetchTikTokData(url);
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
