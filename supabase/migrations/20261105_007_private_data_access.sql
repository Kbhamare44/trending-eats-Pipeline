-- Legacy private tables were omitted from 004. Mobile uses the verified APIs;
-- both backends use the service role, which bypasses these client policies.
-- Keep the queue service-only so clients cannot bypass submission validation.
begin;

alter table public.profiles        enable row level security;
alter table public.saves           enable row level security;
alter table public.raw_submissions enable row level security;

-- Remove unused client privileges too: RLS does not constrain TRUNCATE.
-- The signup trigger is SECURITY DEFINER and still creates the profile.
revoke all on public.profiles, public.saves, public.raw_submissions
  from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, delete on public.saves to authenticated;

drop policy if exists "Profiles are publicly readable" on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;
drop policy if exists "Own profile readable" on public.profiles;
create policy "Own profile readable" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "Own profile updatable" on public.profiles;
create policy "Own profile updatable" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "Own legacy saves readable" on public.saves;
create policy "Own legacy saves readable" on public.saves
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Own legacy saves insertable" on public.saves;
create policy "Own legacy saves insertable" on public.saves
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Own legacy saves deletable" on public.saves;
create policy "Own legacy saves deletable" on public.saves
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Public polling goes through /api/submissions/:id and exposes no raw content.
drop policy if exists "Users can see own submissions" on public.raw_submissions;
drop policy if exists "Users can submit" on public.raw_submissions;

commit;
