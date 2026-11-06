-- STATUS: the counter fix below (part 2) is APPLIED. Part 1, the policy
-- change, is NOT — the migration tool declines it. Re-running this whole
-- file is safe: part 2 is idempotent (it only touches rows where the count
-- already disagrees) and will be a no-op.
--
-- 1. restaurant_feedback was world-readable, user_id included.
--
-- The SELECT policy was `using (true)` for role public, so anyone holding the
-- anon key — which ships inside the app bundle and is public by design —
-- could read every feedback row and map accounts to the restaurants they
-- rated. Writes were already correctly scoped (`auth.uid() = user_id`); only
-- reads were open.
--
-- Ratings stay publicly visible on restaurant pages. That path is
-- /api/restaurants/[id], which uses the service key, bypasses RLS, and
-- returns rating, comment and dish WITHOUT user_id. The mobile app makes no
-- direct supabase.from() calls at all, so nothing depends on the open policy.
drop policy if exists "feedback readable" on public.restaurant_feedback;

create policy "own feedback readable"
  on public.restaurant_feedback
  for select
  using (auth.uid() = user_id);

-- 2. restaurants.review_count had drifted from the actual rows.
--
-- Bartholomew Bakery read 3 with one review; Misk Iraqi and NAAN KABOB read 0
-- with one each. The counter gates real behaviour — the AI summary needs 2+
-- reviews, and the experience signal weighs it — so a stale value silently
-- changes what the app says about a business. Recomputed from the source of
-- truth; derived data only, no reviews touched.
update restaurants r
   set review_count = (select count(*) from reviews rv where rv.restaurant_id = r.id)
 where r.review_count is distinct from
       (select count(*) from reviews rv where rv.restaurant_id = r.id);
