-- ============================================================================
-- 004 — GTA geography + Row Level Security
--
-- The pipeline API talks to Postgres with the service key and bypasses RLS.
-- These policies exist because the mobile app also ships a Supabase anon key
-- and can reach these tables directly. Without them, anyone with the anon key
-- (it is in the app bundle, by design) could read every user's saves and
-- write feedback as somebody else.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── GTA classification ──────────────────────────────────────────────────────
-- Toronto + the 4 regional municipalities (Peel, York, Durham, Halton), plus
-- the former-municipality and neighbourhood names Google Places returns as
-- the locality (Etobicoke, Woodbridge, Thornhill, ...).
create or replace function te_is_gta(city_name text, addr text default null)
returns boolean as $$
declare
  haystack text := lower(coalesce(city_name, '') || ' ' || coalesce(addr, ''));
begin
  if haystack = ' ' then
    return false;
  end if;

  -- \y is a word boundary. It is load-bearing, not decorative: without it
  -- 'milton' matches inside "Hamilton" and 'brock' inside "Brockville", so
  -- places well outside the GTA classify as in-market. Mirrors the \b
  -- handling in lib/geo/gta.ts — keep the two in step.
  return haystack ~ (
    '\y(toronto|mississauga|brampton|vaughan|markham|richmond hill'
    || '|oakville|burlington|milton|halton hills|georgetown|acton'
    || '|oshawa|whitby|ajax|pickering|clarington|bowmanville|courtice'
    || '|newmarket|aurora|king city|nobleton|schomberg|caledon|bolton'
    || '|stouffville|whitchurch|whitchurch-stouffville|east gwillimbury|georgina|keswick|sutton'
    || '|uxbridge|scugog|port perry|brock|beaverton|cannington|sunderland'
    || '|etobicoke|scarborough|north york|east york|york mills'
    || '|woodbridge|thornhill|concord|maple|kleinburg|unionville|milliken'
    || '|agincourt|don mills|willowdale|downsview|weston|rexdale|bramalea'
    || '|malton|streetsville|port credit|clarkson|meadowvale|cooksville'
    || '|bronte|brooklin|newcastle|old toronto|holland landing|mount albert)\y'
  );
end;
$$ language plpgsql immutable;

-- Region grouping, for the "Local Discovery" filters.
create or replace function te_gta_region(city_name text, addr text default null)
returns text as $$
declare
  haystack text := lower(coalesce(city_name, '') || ' ' || coalesce(addr, ''));
begin
  -- Every alternation is wrapped in \y word boundaries, for the same reason
  -- as te_is_gta above.
  if haystack ~ '\y(etobicoke|scarborough|north york|east york|willowdale|downsview|weston|rexdale|agincourt|don mills|york mills|old toronto)\y' then
    return 'Toronto';
  elsif haystack ~ '\ytoronto\y' then
    return 'Toronto';
  elsif haystack ~ '\y(mississauga|brampton|bramalea|caledon|bolton|malton|streetsville|port credit|clarkson|meadowvale|cooksville)\y' then
    return 'Peel';
  elsif haystack ~ '\y(vaughan|markham|milliken|richmond hill|newmarket|aurora|king city|nobleton|schomberg|stouffville|whitchurch|whitchurch-stouffville|east gwillimbury|holland landing|mount albert|georgina|keswick|sutton|woodbridge|thornhill|concord|maple|kleinburg|unionville)\y' then
    return 'York';
  elsif haystack ~ '\y(oshawa|whitby|brooklin|ajax|pickering|clarington|bowmanville|courtice|newcastle|uxbridge|scugog|port perry|brock|beaverton|cannington|sunderland)\y' then
    return 'Durham';
  elsif haystack ~ '\y(oakville|bronte|burlington|milton|halton hills|georgetown|acton)\y' then
    return 'Halton';
  else
    return null;
  end if;
end;
$$ language plpgsql immutable;

update restaurants
   set is_gta  = te_is_gta(city, address),
       region  = te_gta_region(city, address);

-- Keep it current as rows are written.
create or replace function te_set_geography()
returns trigger as $$
begin
  new.is_gta := te_is_gta(new.city, new.address);
  new.region := te_gta_region(new.city, new.address);
  return new;
end;
$$ language plpgsql;

drop trigger if exists te_restaurant_geography on restaurants;
create trigger te_restaurant_geography
  before insert or update of city, address on restaurants
  for each row execute function te_set_geography();

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table engagement_events   enable row level security;
alter table restaurant_saves    enable row level security;
alter table restaurant_feedback enable row level security;
alter table dishes              enable row level security;
alter table dish_aliases        enable row level security;
alter table restaurant_dishes   enable row level security;
alter table trend_snapshots     enable row level security;

-- Public, aggregate, non-personal data: readable by anyone.
drop policy if exists "dishes readable" on dishes;
create policy "dishes readable" on dishes
  for select using (true);

drop policy if exists "dish aliases readable" on dish_aliases;
create policy "dish aliases readable" on dish_aliases
  for select using (true);

drop policy if exists "restaurant dishes readable" on restaurant_dishes;
create policy "restaurant dishes readable" on restaurant_dishes
  for select using (true);

drop policy if exists "trend snapshots readable" on trend_snapshots;
create policy "trend snapshots readable" on trend_snapshots
  for select using (true);

-- Saves are private to their owner.
drop policy if exists "own saves readable" on restaurant_saves;
create policy "own saves readable" on restaurant_saves
  for select using (auth.uid() = user_id);

drop policy if exists "own saves insertable" on restaurant_saves;
create policy "own saves insertable" on restaurant_saves
  for insert with check (auth.uid() = user_id);

drop policy if exists "own saves deletable" on restaurant_saves;
create policy "own saves deletable" on restaurant_saves
  for delete using (auth.uid() = user_id);

-- Feedback: anyone may read it (it feeds a public experience signal), but a
-- user may only write their own row.
drop policy if exists "feedback readable" on restaurant_feedback;
create policy "feedback readable" on restaurant_feedback
  for select using (true);

drop policy if exists "own feedback insertable" on restaurant_feedback;
create policy "own feedback insertable" on restaurant_feedback
  for insert with check (auth.uid() = user_id);

drop policy if exists "own feedback updatable" on restaurant_feedback;
create policy "own feedback updatable" on restaurant_feedback
  for update using (auth.uid() = user_id);

drop policy if exists "own feedback deletable" on restaurant_feedback;
create policy "own feedback deletable" on restaurant_feedback
  for delete using (auth.uid() = user_id);

-- Raw behavioural events: no client access at all. Service key only.
-- (RLS enabled with no policy = deny everything to anon/authenticated.)
