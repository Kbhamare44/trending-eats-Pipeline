import axios from 'axios';
import { TikTokData } from '@/lib/types';

/**
 * Extract the video ID from any TikTok URL format.
 *
 * Exported because the submit route needs to deduplicate BEFORE doing any
 * network work: if we already hold a review for this video, there is no point
 * spending an oEmbed call, two Gemini calls and two Places calls to find that
 * out. Note that for vt./vm. short links this returns the short code, not the
 * real video ID — those can only be resolved by following the redirect, so a
 * short link submitted twice is not caught here. The reviews table still has
 * the real ID once processing completes, so the second one is caught in the
 * pipeline rather than at the door.
 */
export function extractVideoId(url: string): string | null {
  const patterns = [
    /tiktok\.com\/@[\w.]+\/video\/(\d+)/,
    /tiktok\.com\/v\/(\d+)/,
    /vm\.tiktok\.com\/(\w+)/,
    /vt\.tiktok\.com\/(\w+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** Remove tracking parameters so the same share link has one queue identity. */
export function canonicalTikTokUrl(value: string): string {
  const url = new URL(value.trim());
  url.search = '';
  url.hash = '';
  if (/(^|\.)tiktok\.com$/.test(url.hostname) && /\/@[^/]+\/video\/\d+/.test(url.pathname)) url.hostname = 'www.tiktok.com';
  return url.toString().replace(/\/$/, '');
}

/**
 * Is this a URL we are willing to accept from a user?
 *
 * Parses the host rather than substring-matching "tiktok.com". A substring
 * test also accepts https://tiktok.com.evil.test/x and https://nottiktok.com,
 * which is how an open redirect or SSRF target gets into a submission queue.
 * Requires https because the oEmbed call and the embed both need it.
 */
export function isSubmittableTikTokUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' && /(^|\.)tiktok\.com$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
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

// Short links (vt.tiktok.com / vm.tiktok.com) must be expanded to the full
// tiktok.com/@user/video/... URL before oEmbed will accept them.
// This follows the redirect without downloading the page.
async function expandShortUrl(url: string): Promise<string> {
  const isShort =
    url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com');
  if (!isShort) return url;

  try {
    const response = await axios.get(url, {
      maxRedirects: 5,
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      // We only care about the final URL, not the body
      validateStatus: () => true,
    });
    // axios exposes the final resolved URL here
    const finalUrl = response.request?.res?.responseUrl || url;
    return finalUrl;
  } catch {
    // If expansion fails, fall back to the original and let oEmbed try
    return url;
  }
}

// Fetch metadata from TikTok's official oEmbed endpoint
export async function fetchTikTokData(url: string): Promise<TikTokData> {
  if (!isValidTikTokUrl(url)) {
    throw new Error('Invalid TikTok URL');
  }

  // Expand short share links first
    // Expand short share links first
  const fullUrl = await expandShortUrl(url);

  // TikTok photo/slideshow posts aren't supported by oEmbed (videos only)
  if (fullUrl.includes('/photo/')) {
    throw new Error('TikTok photo posts aren\'t supported — please submit a video review instead');
  }

  const oEmbedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(fullUrl)}`;
  let response;
  try {
    response = await axios.get(oEmbedUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'TrendingEatsApp/1.0' },
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
  if (!data || data.type !== 'video' || typeof data.html !== 'string' || !data.html.trim()) {
    throw new Error('TikTok oEmbed returned no usable video metadata');
  }
  const videoId = extractVideoId(fullUrl) || data.video_id || '';

  return {
    videoId,
    url: fullUrl,
    // Missing title means metadata was omitted, not that the video lacks a caption.
    caption: typeof data.title === 'string' ? data.title.trim() : '',
    creatorUsername: data.author_name || new URL(fullUrl).pathname.match(/^\/@([^/]+)\//)?.[1] || '',
    thumbnailUrl: data.thumbnail_url || '',
    embedHtml: data.html || '',
    likes: 0,
    views: 0,
  };
}
