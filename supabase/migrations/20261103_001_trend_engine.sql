-- ============================================================================
-- 001 — Trend engine foundations
--
-- Adds the TIME DIMENSION the v2 strategy needs. Before this migration the
-- schema only had created_at/updated_at on restaurants, so "growth in saves"
-- and "growth in submissions" were not computable at all.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ── Engagement events ───────────────────────────────────────────────────────
-- Append-only log of first-party activity. This is the ONLY source of truth
-- for trend growth. Nothing here comes from another platform's API.
create table if not exists engagement_events (
  id            uuid primary key default uuid_generate_v4(),
  event_type    text not null check (event_type in (
                  'restaurant_view',
                  'restaurant_detail_view',
                  'restaurant_save',
                  'restaurant_unsave',
                  'submission_accepted',
                  'feedback_submitted',
                  'dish_view',
                  'search'
                )),
  restaurant_id uuid references restaurants(id) on delete cascade,
  dish_id       uuid,          -- FK added in 002 once dishes exists
  user_id       uuid,          -- null for anonymous activity
  anon_id       text,          -- stable per-install id, lets us count unique
                               -- anonymous users without storing identity
  city          text,
  source        text default 'mobile',
  created_at    timestamptz not null default now()
);

create index if not exists engagement_events_restaurant_time_idx
  on engagement_events (restaurant_id, created_at desc);
create index if not exists engagement_events_type_time_idx
  on engagement_events (event_type, created_at desc);
create index if not exists engagement_events_dish_time_idx
  on engagement_events (dish_id, created_at desc);
create index if not exists engagement_events_city_time_idx
  on engagement_events (city, created_at desc);

-- ── Restaurant saves ────────────────────────────────────────────────────────
-- Current save state. History lives in engagement_events via trigger below.
create table if not exists restaurant_saves (
  id            uuid primary key default uuid_generate_v4(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  user_id       uuid not null,
  created_at    timestamptz not null default now(),
  unique (restaurant_id, user_id)
);

create index if not exists restaurant_saves_user_idx
  on restaurant_saves (user_id);
create index if not exists restaurant_saves_restaurant_time_idx
  on restaurant_saves (restaurant_id, created_at desc);

-- ── Trend columns on restaurants ────────────────────────────────────────────
-- trend_score is NULL whenever trend_state <> 'ranked'. A null score and a
-- score of 0 mean different things and must never be conflated.
alter table restaurants
  add column if not exists trend_score              numeric,
  add column if not exists trend_state              text not null default 'insufficient_data',
  add column if not exists trend_confidence         numeric,
  add column if not exists trend_observations       integer not null default 0,
  add column if not exists trend_components         jsonb,
  add column if not exists trend_computed_at        timestamptz,
  add column if not exists hype_score               numeric,
  add column if not exists saves_count              integer not null default 0,
  add column if not exists google_rating_count      integer,
  add column if not exists google_data_refreshed_at timestamptz,
  add column if not exists is_gta                   boolean not null default false,
  add column if not exists region                   text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'restaurants_trend_state_check'
  ) then
    alter table restaurants
      add constraint restaurants_trend_state_check
      check (trend_state in ('ranked', 'insufficient_data', 'warming_up'));
  end if;
end $$;

create index if not exists restaurants_trend_idx
  on restaurants (trend_state, trend_score desc nulls last);
create index if not exists restaurants_city_idx on restaurants (city);
create index if not exists restaurants_gta_idx on restaurants (is_gta) where is_gta;

-- ── Trend snapshots ─────────────────────────────────────────────────────────
-- One row per entity per recompute. Gives us week-over-week history and lets
-- us re-tune the scoring weights against observed data later, as the strategy
-- calls for ("initial experimental weights ... adjusted using observed data").
create table if not exists trend_snapshots (
  id           uuid primary key default uuid_generate_v4(),
  entity_type  text not null check (entity_type in ('restaurant', 'dish')),
  entity_id    uuid not null,
  window_days  integer not null,
  score        numeric,
  state        text not null,
  confidence   numeric,
  observations integer not null default 0,
  components   jsonb,
  city         text,
  computed_at  timestamptz not null default now()
);

create index if not exists trend_snapshots_entity_idx
  on trend_snapshots (entity_type, entity_id, computed_at desc);
create index if not exists trend_snapshots_time_idx
  on trend_snapshots (computed_at desc);

-- ── Keep saves_count in step, and log history ───────────────────────────────
create or replace function te_on_restaurant_save_insert()
returns trigger as $$
begin
  update restaurants
     set saves_count = saves_count + 1
   where id = new.restaurant_id;

  insert into engagement_events (event_type, restaurant_id, user_id, created_at, source)
  values ('restaurant_save', new.restaurant_id, new.user_id, new.created_at, 'trigger');

  return new;
end;
$$ language plpgsql;

create or replace function te_on_restaurant_save_delete()
returns trigger as $$
begin
  update restaurants
     set saves_count = greatest(0, saves_count - 1)
   where id = old.restaurant_id;

  insert into engagement_events (event_type, restaurant_id, user_id, source)
  values ('restaurant_unsave', old.restaurant_id, old.user_id, 'trigger');

  return old;
end;
$$ language plpgsql;

drop trigger if exists te_restaurant_save_insert on restaurant_saves;
create trigger te_restaurant_save_insert
  after insert on restaurant_saves
  for each row execute function te_on_restaurant_save_insert();

drop trigger if exists te_restaurant_save_delete on restaurant_saves;
create trigger te_restaurant_save_delete
  after delete on restaurant_saves
  for each row execute function te_on_restaurant_save_delete();

-- ── Log accepted submissions ────────────────────────────────────────────────
-- Every accepted review IS a restaurant submission. Logging it as an event is
-- what makes "growth in restaurant submissions" (25% of Trend Score) real.
create or replace function te_on_review_insert()
returns trigger as $$
begin
  insert into engagement_events (event_type, restaurant_id, created_at, source)
  values ('submission_accepted', new.restaurant_id, new.created_at, 'trigger');
  return new;
end;
$$ language plpgsql;

drop trigger if exists te_review_insert on reviews;
create trigger te_review_insert
  after insert on reviews
  for each row execute function te_on_review_insert();

-- ── Backfill submission history from existing reviews ───────────────────────
-- Without this the trend engine starts completely blind to the reviews you
-- already have.
insert into engagement_events (event_type, restaurant_id, created_at, source)
select 'submission_accepted', r.restaurant_id, r.created_at, 'backfill'
from reviews r
where r.restaurant_id is not null
  and not exists (
    select 1 from engagement_events e
     where e.event_type = 'submission_accepted'
       and e.restaurant_id = r.restaurant_id
       and e.created_at = r.created_at
  );

-- ── Backfill saves_count from any legacy saves ──────────────────────────────
update restaurants r
   set saves_count = coalesce(s.n, 0)
  from (
    select restaurant_id, count(*)::int as n
      from restaurant_saves group by restaurant_id
  ) s
 where s.restaurant_id = r.id;
