import { fetchTikTokData } from './lib/pipeline/tiktok';

async function test() {
  const url = 'https://www.tiktok.com/@gordonramsay/video/7023289477462441222';

  try {
    const data = await fetchTikTokData(url);
    console.log('Success!');
    console.log('Video ID:', data.videoId);
    console.log('Creator:', data.creatorUsername);
    console.log('Caption:', data.caption);
    console.log('Thumbnail:', data.thumbnailUrl);
  } catch (error: any) {
    console.log('Failed:', error.message);
  }
}

test();
