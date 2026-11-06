-- Content reports are an operator moderation queue, never a public feed.
create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  content_type text not null check (content_type in ('review', 'feedback')),
  content_id uuid not null,
  reason text not null check (reason in ('abuse', 'spam', 'rights', 'other')),
  reported_by uuid references auth.users(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'reviewed', 'actioned', 'dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists content_reports_open_created_idx on public.content_reports(status, created_at);
alter table public.content_reports enable row level security;
revoke all on public.content_reports from anon, authenticated;
grant all on public.content_reports to service_role;
comment on table public.content_reports is 'Service-only moderation queue. Review open reports in Supabase; reporting alone does not claim a takedown occurred.';
