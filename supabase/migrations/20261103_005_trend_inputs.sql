-- ============================================================================
-- 005 — Windowed aggregate functions for the trend engine
--
-- These exist so a recompute is ONE round trip instead of one query per
-- restaurant per window. They return raw counts only; all weighting and the
-- observations floor live in TypeScript (lib/trends/score.ts) so the scoring
-- rules stay testable and in one place.
--
-- "Unique user" counts coalesce(user_id, anon_id) so a signed-out install
-- counts once, not once per event.
--
-- NOTE ON QUALIFICATION: in a `language sql` function, the RETURNS TABLE
-- column names are OUT parameters and are visible inside the body. An
-- unqualified reference to a real column with the same name (restaurant_id,
-- dish_id) is therefore ambiguous and Postgres rejects it. Every column
-- reference below is table-qualified for that reason — do not "simplify" them.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── Restaurant trend inputs ─────────────────────────────────────────────────
drop function if exists te_restaurant_trend_inputs(integer);
create function te_restaurant_trend_inputs(window_days integer default 7)
returns table (
  restaurant_id             uuid,
  unique_saves_current      integer,
  unique_saves_previous     integer,
  submissions_current       integer,
  submissions_previous      integer,
  unique_users_current      integer,
  unique_users_previous     integer,
  hours_since_last_activity numeric,
  observations              integer
)
language sql
stable
as $$
  with bounds as (
    select
      now() - make_interval(days => window_days)     as current_start,
      now() - make_interval(days => window_days * 2) as previous_start
  ),
  scoped as (
    select
      ev.restaurant_id                       as rid,
      ev.event_type                          as etype,
      coalesce(ev.user_id::text, ev.anon_id) as actor,
      ev.created_at                          as at,
      (ev.created_at >= b.current_start)     as in_current,
      (ev.created_at >= b.previous_start
        and ev.created_at < b.current_start) as in_previous
    from engagement_events ev
    cross join bounds b
    where ev.restaurant_id is not null
      and ev.created_at >= b.previous_start
  )
  select
    s.rid,
    count(distinct case when s.in_current  and s.etype = 'restaurant_save'    then s.actor end)::int,
    count(distinct case when s.in_previous and s.etype = 'restaurant_save'    then s.actor end)::int,
    count(case when s.in_current  and s.etype = 'submission_accepted' then 1 end)::int,
    count(case when s.in_previous and s.etype = 'submission_accepted' then 1 end)::int,
    count(distinct case when s.in_current  then s.actor end)::int,
    count(distinct case when s.in_previous then s.actor end)::int,
    (extract(epoch from (now() - max(s.at))) / 3600.0)::numeric,
    count(case when s.in_current then 1 end)::int
  from scoped s
  group by s.rid;
$$;

-- ── Dish trend inputs ───────────────────────────────────────────────────────
-- A dish's momentum comes from new mentions plus engagement with the
-- restaurants that serve it.
drop function if exists te_dish_trend_inputs(integer);
create function te_dish_trend_inputs(window_days integer default 7)
returns table (
  dish_id                   uuid,
  mentions_current          integer,
  mentions_previous         integer,
  unique_saves_current      integer,
  unique_saves_previous     integer,
  unique_users_current      integer,
  unique_users_previous     integer,
  restaurant_count          integer,
  hours_since_last_activity numeric,
  observations              integer
)
language sql
stable
as $$
  with bounds as (
    select
      now() - make_interval(days => window_days)     as current_start,
      now() - make_interval(days => window_days * 2) as previous_start
  ),
  mention_stats as (
    select
      dm.dish_id                                                            as did,
      count(case when dm.created_at >= b.current_start then 1 end)::int      as cur,
      count(case when dm.created_at >= b.previous_start
                  and dm.created_at < b.current_start then 1 end)::int       as prev,
      max(dm.created_at)                                                     as last_mention
    from dish_mentions dm
    cross join bounds b
    group by dm.dish_id
  ),
  dish_spread as (
    select
      rd.dish_id                               as did,
      count(distinct rd.restaurant_id)::int    as venues
    from restaurant_dishes rd
    group by rd.dish_id
  ),
  dish_engagement as (
    select
      rd.dish_id as did,
      count(distinct case when ev.created_at >= b.current_start
                           and ev.event_type = 'restaurant_save'
                          then coalesce(ev.user_id::text, ev.anon_id) end)::int as saves_cur,
      count(distinct case when ev.created_at >= b.previous_start
                           and ev.created_at < b.current_start
                           and ev.event_type = 'restaurant_save'
                          then coalesce(ev.user_id::text, ev.anon_id) end)::int as saves_prev,
      count(distinct case when ev.created_at >= b.current_start
                          then coalesce(ev.user_id::text, ev.anon_id) end)::int as users_cur,
      count(distinct case when ev.created_at >= b.previous_start
                           and ev.created_at < b.current_start
                          then coalesce(ev.user_id::text, ev.anon_id) end)::int as users_prev,
      count(case when ev.created_at >= b.current_start then 1 end)::int         as events_cur,
      max(ev.created_at)                                                        as last_event
    from restaurant_dishes rd
    cross join bounds b
    join engagement_events ev
      on ev.restaurant_id = rd.restaurant_id
     and ev.created_at >= b.previous_start
    group by rd.dish_id
  )
  select
    d.id,
    coalesce(ms.cur, 0),
    coalesce(ms.prev, 0),
    coalesce(de.saves_cur, 0),
    coalesce(de.saves_prev, 0),
    coalesce(de.users_cur, 0),
    coalesce(de.users_prev, 0),
    coalesce(ds.venues, 0),
    (extract(epoch from (now() - greatest(
      coalesce(ms.last_mention, to_timestamp(0)),
      coalesce(de.last_event,   to_timestamp(0))
    ))) / 3600.0)::numeric,
    (coalesce(ms.cur, 0) + coalesce(de.events_cur, 0))::int
  from dishes d
  left join mention_stats   ms on ms.did = d.id
  left join dish_spread     ds on ds.did = d.id
  left join dish_engagement de on de.did = d.id;
$$;

-- ── Experience inputs ───────────────────────────────────────────────────────
drop function if exists te_restaurant_experience_inputs();
create function te_restaurant_experience_inputs()
returns table (
  restaurant_id        uuid,
  first_party_ratings  smallint[],
  google_rating        numeric,
  google_rating_count  integer,
  creator_sentiment    numeric,
  creator_review_count integer
)
language sql
stable
as $$
  select
    r.id,
    coalesce(fb.ratings, array[]::smallint[]),
    r.google_rating::numeric,
    r.google_rating_count,
    rv.avg_sentiment::numeric,
    coalesce(rv.n, 0)::int
  from restaurants r
  left join (
    select
      rf.restaurant_id      as rid,
      array_agg(rf.rating)  as ratings
    from restaurant_feedback rf
    group by rf.restaurant_id
  ) fb on fb.rid = r.id
  left join (
    select
      rev.restaurant_id            as rid,
      avg(rev.sentiment_score)     as avg_sentiment,
      count(*)                     as n
    from reviews rev
    group by rev.restaurant_id
  ) rv on rv.rid = r.id;
$$;
