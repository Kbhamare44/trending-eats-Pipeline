-- Apply before deploying concurrent submission protection.
-- Intentionally fails if historical duplicates exist; do not delete real reviews automatically.
begin;
create unique index if not exists te_one_open_submission_url
  on public.raw_submissions(tiktok_url) where status in ('pending', 'processing');
create unique index if not exists te_one_open_submission_video
  on public.raw_submissions(tiktok_video_id)
  where status in ('pending', 'processing') and tiktok_video_id is not null and tiktok_video_id <> '';
create unique index if not exists te_one_review_video
  on public.reviews(tiktok_video_id) where tiktok_video_id is not null and tiktok_video_id <> '';
create unique index if not exists te_one_review_submission
  on public.reviews(submission_id) where submission_id is not null;
commit;
