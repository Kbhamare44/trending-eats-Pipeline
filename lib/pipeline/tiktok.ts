import axios from 'axios';
import { TikTokData } from '@/lib/types';

// Extract the video ID from any TikTok URL format
// Handles: tiktok.com/@user/video/123, vm.tiktok.com/abc, etc.
function extractVideoId(url: string): string | null {
  const patterns = [
    /tiktok\.com\/@[\w.]+\/video\/(\d+)/,
    /tiktok\.com\/v\/(\d+)/,
    /vm\.tiktok\.com\/(\w+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// Validate that the URL is actually a TikTok URL
function isValidTikTokUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('tiktok.com');
  } catch {
    return false;
  }
}

// Fetch metadata from TikTok's official oEmbed endpoint
// This is the only sanctioned way to get TikTok video data
export async function fetchTikTokData(url: string): Promise<TikTokData> {
  if (!isValidTikTokUrl(url)) {
    throw new Error('Invalid TikTok URL');
  }

  const oEmbedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;

  let response;
  try {
    response = await axios.get(oEmbedUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'TrendingEatsApp/1.0',
      },
    });
  } catch (error: any) {
    if (error.response?.status === 404) {
      throw new Error('TikTok video not found or has been deleted');
    }
    if (error.response?.status === 403) {
      throw new Error('TikTok video is private or restricted');
    }
    throw new Error(`Failed to fetch TikTok data: ${error.message}`);
  }

  const data = response.data;

  // oEmbed gives us: title (caption), author_name, thumbnail_url, html (embed)
  // Likes and views are NOT available via oEmbed — we default to 0
  // If you later get Research API access, you can populate these
  const videoId = extractVideoId(url) || data.video_id || '';

  return {
    videoId,
    url,
    caption: data.title || '',
    creatorUsername: data.author_name || '',
    thumbnailUrl: data.thumbnail_url || '',
    embedHtml: data.html || '',
    likes: 0,    // Not available via oEmbed
    views: 0,    // Not available via oEmbed
  };
}