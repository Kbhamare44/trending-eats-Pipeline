-- Keep correction inputs with the queue row, so cron/restarts do not lose them.
-- raw_submissions remains service-only under migration 007.
alter table public.raw_submissions
  add column if not exists user_hint jsonb,
  add column if not exists resolution jsonb,
  add column if not exists caption_source text,
  add column if not exists caption_fetch_status text
    check (caption_fetch_status in ('pending', 'ok', 'unavailable', 'failed')),
  add column if not exists caption_fetched_at timestamptz;

comment on column public.raw_submissions.user_hint is 'User-confirmed restaurant name, city or selected Google place ID. Never caption text.';
comment on column public.raw_submissions.resolution is 'Detected name/source evidence and public place options when clarification is needed.';
comment on column public.raw_submissions.caption_fetch_status is 'Retrieval status, not a claim that a visible caption is absent. A pending/failed metadata attempt is not automatically billed again.';
