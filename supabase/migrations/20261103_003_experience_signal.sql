-- ============================================================================
-- 003 — Hype vs Reality (experience signal) + first-party feedback
--
-- Fixes the conflation the strategy calls out: authenticity_score currently
-- stores 0 both for "we measured it and it is bad" and for "we have no data".
-- Misk Iraqi and NAAN KABOB both read 0 with ZERO reviews, which would render
-- as a negative claim about a real business with no evidence behind it.
--
-- After this migration: a null score plus an explicit *_state column. Negative
-- classifications additionally require a minimum number of independent
-- observations, enforced in lib/experience/signal.ts.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ── First-party feedback ────────────────────────────────────────────────────
-- Our own users, our own data. One editable row per user per restaurant.
create table if not exists restaurant_feedback (
  id            uuid primary key default uuid_generate_v4(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  user_id       uuid not null,
  rating        smallint not null check (rating between 1 and 5),
  would_return  boolean,
  visited       boolean not null default true,
  dish          text,
  comment       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, user_id)
);

create index if not exists restaurant_feedback_restaurant_idx
  on restaurant_feedback (restaurant_id, created_at desc);
create index if not exists restaurant_feedback_user_idx
  on restaurant_feedback (user_id);

create or replace function te_on_feedback_write()
returns trigger as $$
begin
  insert into engagement_events (event_type, restaurant_id, user_id, source)
  values ('feedback_submitted', new.restaurant_id, new.user_id, 'trigger');
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists te_feedback_write on restaurant_feedback;
create trigger te_feedback_write
  before insert or update on restaurant_feedback
  for each row execute function te_on_feedback_write();

-- ── Experience columns ──────────────────────────────────────────────────────
alter table restaurants
  add column if not exists experience_score            numeric,  -- 0..100, null unless measured
  add column if not exists experience_state            text not null default 'insufficient_data',
  add column if not exists experience_confidence       numeric,
  add column if not exists experience_observations     integer not null default 0,
  add column if not exists experience_inputs           jsonb,
  add column if not exists experience_computed_at      timestamptz,
  add column if not exists hype_vs_reality             text not null default 'insufficient_data',
  add column if not exists first_party_rating          numeric,
  add column if not exists first_party_rating_count    integer not null default 0,
  add column if not exists authenticity_state          text not null default 'insufficient_data';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'restaurants_experience_state_check'
  ) then
    alter table restaurants
      add constraint restaurants_experience_state_check
      check (experience_state in ('measured', 'insufficient_data'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'restaurants_hype_vs_reality_check'
  ) then
    alter table restaurants
      add constraint restaurants_hype_vs_reality_check
      check (hype_vs_reality in (
        'lives_up', 'mixed', 'below_expectations', 'insufficient_data'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'restaurants_authenticity_state_check'
  ) then
    alter table restaurants
      add constraint restaurants_authenticity_state_check
      check (authenticity_state in ('measured', 'insufficient_data'));
  end if;
end $$;

-- ── Un-conflate the existing authenticity_score ─────────────────────────────
-- Allow null, then clear every score that was never actually measured.
do $$
begin
  begin
    alter table restaurants alter column authenticity_score drop not null;
  exception when others then
    null;  -- already nullable
  end;
  begin
    alter table restaurants alter column authenticity_score drop default;
  exception when others then
    null;
  end;
end $$;

update restaurants
   set authenticity_score = null,
       authenticity_state = 'insufficient_data'
 where coalesce(review_count, 0) < 2;

update restaurants
   set authenticity_state = 'measured'
 where coalesce(review_count, 0) >= 2
   and authenticity_score is not null;
