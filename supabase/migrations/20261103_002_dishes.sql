-- ============================================================================
-- 002 — Viral Dishes
--
-- Before this migration, dishes lived only as a JSON blob (restaurants.top_dishes),
-- so a dish could not be ranked ACROSS restaurants — which is the whole point
-- of the Viral Dishes feature. This promotes dishes to first-class rows with
-- name normalization, so "matcha croissant" and "Matcha Croissants" collapse
-- while "matcha latte" stays distinct.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ── Canonical dishes ────────────────────────────────────────────────────────
create table if not exists dishes (
  id                uuid primary key default uuid_generate_v4(),
  slug              text not null unique,
  name              text not null,
  family            text,        -- coarse grouping: 'matcha', 'burger', 'fried-chicken'
  category          text,        -- 'dessert' | 'savoury' | 'drink' | null
  trend_score       numeric,
  trend_state       text not null default 'insufficient_data',
  trend_confidence  numeric,
  trend_observations integer not null default 0,
  trend_components  jsonb,
  trend_computed_at timestamptz,
  restaurant_count  integer not null default 0,
  mention_count     integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'dishes_trend_state_check'
  ) then
    alter table dishes
      add constraint dishes_trend_state_check
      check (trend_state in ('ranked', 'insufficient_data', 'warming_up'));
  end if;
end $$;

create index if not exists dishes_family_idx on dishes (family);
create index if not exists dishes_trend_idx
  on dishes (trend_state, trend_score desc nulls last);

-- ── Aliases ─────────────────────────────────────────────────────────────────
-- Maps a normalized raw string to a canonical dish. Lets you fix a bad
-- grouping by inserting a row instead of shipping code.
create table if not exists dish_aliases (
  id         uuid primary key default uuid_generate_v4(),
  alias      text not null unique,   -- already normalized (lowercase, no punctuation)
  dish_id    uuid not null references dishes(id) on delete cascade,
  source     text not null default 'rule' check (source in ('rule', 'gemini', 'manual')),
  created_at timestamptz not null default now()
);

create index if not exists dish_aliases_dish_idx on dish_aliases (dish_id);

-- ── Restaurant ↔ dish join ──────────────────────────────────────────────────
create table if not exists restaurant_dishes (
  id            uuid primary key default uuid_generate_v4(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  dish_id       uuid not null references dishes(id) on delete cascade,
  mention_count integer not null default 0,
  review_count  integer not null default 0,
  avg_sentiment numeric,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  unique (restaurant_id, dish_id)
);

create index if not exists restaurant_dishes_dish_idx
  on restaurant_dishes (dish_id, mention_count desc);
create index if not exists restaurant_dishes_restaurant_idx
  on restaurant_dishes (restaurant_id, mention_count desc);

-- ── Now that dishes exists, point engagement_events.dish_id at it ───────────
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'engagement_events_dish_fk'
  ) then
    alter table engagement_events
      add constraint engagement_events_dish_fk
      foreign key (dish_id) references dishes(id) on delete set null;
  end if;
end $$;

-- ── Dish mentions ───────────────────────────────────────────────────────────
-- One row per (dish, review). This is the dish time-series: without it,
-- "which dishes are gaining momentum" requires re-scanning and re-normalizing
-- every review's dishes_mentioned array on every recompute.
create table if not exists dish_mentions (
  id            uuid primary key default uuid_generate_v4(),
  dish_id       uuid not null references dishes(id) on delete cascade,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  review_id     uuid references reviews(id) on delete cascade,
  raw_name      text,          -- what Gemini actually said, for auditing
  sentiment     numeric,
  created_at    timestamptz not null default now(),
  unique (dish_id, review_id)
);

create index if not exists dish_mentions_dish_time_idx
  on dish_mentions (dish_id, created_at desc);
create index if not exists dish_mentions_restaurant_idx
  on dish_mentions (restaurant_id);
