# Trending Eats — intelligence pipeline

Google Trends for food, Toronto & GTA first.

This service is the brain of Trending Eats: it ingests TikTok links that users
submit, extracts restaurants and dishes with Gemini, verifies them against
Google Places, and computes the trend and experience signals the mobile app
renders.

Read **[COMPLIANCE.md](./COMPLIANCE.md)** before changing anything that touches
TikTok, Google Places, or how scores get published. It records boundaries that
are easy to erode by accident.

---

## The four product surfaces

| Surface | Endpoint | What it answers |
|---|---|---|
| **Trending Now** | `GET /api/trending` | What is gaining momentum right now, per GTA city |
| **Viral Dishes** | `GET /api/dishes` | Which *dishes* are spreading, across restaurants |
| **Hype vs Reality** | `GET /api/restaurants/:id` | Is a popular place actually good? |
| **Local Discovery** | `GET /api/restaurants`, `GET /api/cities` | Map, city and cuisine filters |

---

## Architecture

```
          user pastes a TikTok link
                     |
            POST /api/submit                 (identity from the Supabase JWT)
                     |
         raw_submissions (pending)
                     |
          GET /api/cron   (drains the queue on a schedule)
                     |
  oEmbed -> Gemini classify -> Gemini extract -> Google Places verify
                     |
        restaurants + reviews + dish_mentions
                     |
      GET /api/cron/recompute   (daily on Vercel Hobby; hourly via GitHub Actions)
                     |
   trend scores · dish trends · experience signal · trend_snapshots
                     |
               mobile app
```

### Where the logic lives

| Concern | File |
|---|---|
| Scoring weights and every threshold | `lib/config/trends.ts` |
| Trend Score + Hype Score maths | `lib/trends/score.ts` |
| Rollup orchestration | `lib/trends/recompute.ts` |
| Experience signal, Hype vs Reality verdicts | `lib/experience/signal.ts` |
| Dish name normalization | `lib/dishes/normalize.ts` |
| Dish aggregation | `lib/dishes/aggregate.ts` |
| GTA geography | `lib/geo/gta.ts` |
| Request auth | `lib/auth/verify.ts` |
| API response shapes | `lib/presenters/restaurant.ts` |

Scoring is pure TypeScript operating on raw counts; the SQL functions in
migration 005 only aggregate. That split keeps the judgement calls testable:

```bash
npm run check      # typecheck + 32 scoring/normalization assertions
```

---

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

`SUPABASE_SERVICE_KEY` is required and the app throws at import time without
it. It is **not** the mobile app's anon key — the pipeline writes with the
service role and bypasses RLS.

### Migrations

Run the files in `supabase/migrations/` in numeric order, in the Supabase SQL
editor. They are idempotent, so re-running is safe.

| Migration | Adds |
|---|---|
| `001_trend_engine` | `engagement_events`, `restaurant_saves`, `trend_snapshots`, trend columns, triggers, backfill of submission history from existing reviews |
| `002_dishes` | `dishes`, `dish_aliases`, `restaurant_dishes`, `dish_mentions` |
| `003_experience_signal` | `restaurant_feedback`, experience columns, and the un-conflation of `authenticity_score` |
| `004_gta_and_rls` | GTA classification functions, region backfill, RLS policies |
| `005_trend_inputs` | Windowed aggregate functions (`te_*_trend_inputs`) |

---

## Trend Score

0–100, computed over a rolling window (default 7 days) against the window
before it.

| Component | Weight | Measures |
|---|---|---|
| Unique-save growth | 40% | More people saving it than last week |
| Submission growth | 25% | More videos being added for it |
| Unique engagement | 20% | How many distinct users touched it |
| Recency | 15% | How recently anything happened |

Three design decisions that matter more than the weights:

**Growth is smoothed and volume-weighted.** Raw percentage growth lets 0 → 1
save ("infinite growth") beat 20 → 40 saves. Growth is
`(current + 1) / (previous + 1)`, mapped logarithmically, then scaled by
`sqrt(volume / target)`. There is a test asserting 40 saves outranks 1.

**There is an observations floor.** Below `TREND_MIN_OBSERVATIONS` (default 5)
in the window, the score is `null` and the state is `warming_up` or
`insufficient_data`. A ranking built from two events is noise wearing a number.

**Dishes need spread.** A dish must appear at `TREND_DISH_MIN_RESTAURANTS`
(default 2) venues before it can rank. One restaurant's signature item is not a
local food trend.

### Reading the states

| `trend_state` | `trend_score` | App shows |
|---|---|---|
| `ranked` | 0–100 | "Trending", with the number and a one-line reason |
| `warming_up` | `null` | "Gaining attention", no number |
| `insufficient_data` | `null` | "Not enough data yet" |

`meta.rankingUnavailable` is true when nothing qualifies, and the app says so
rather than presenting the fallback list as a ranking.

---

## Hype vs Reality

Two separate measures, never blended:

- **Hype Score** — accumulated attention: review count, saves, reach.
- **Experience Score** — what customers reported: our own feedback (60%),
  Google rating (30%), creator sentiment (10%).

Evidence is credit-weighted rather than counted, because sources are not
interchangeable. One first-party rating = 1.0 credit; one Google rater = 0.05
(capped at 5 total); one creator review = 0.5. A 5.0 from three Google raters
therefore stays `insufficient_data` instead of reading as measured — that case
is covered by a test.

A `below_expectations` verdict additionally requires
`EXPERIENCE_MIN_OBSERVATIONS_NEGATIVE` credit **and** a gap of at least 15
points. These are real businesses; a negative verdict needs more evidence than
a positive one.

---

## Operations

```bash
npm run recompute -- --url https://your-app.vercel.app   # force a rollup
npm run seed -- links.txt --url https://your-app.vercel.app
npm run seed -- links.txt --dry-run
```

Seeding replays TikTok links **you collected by hand** through the same public
`/api/submit` endpoint a user hits. It does not search TikTok. See
`scripts/seed-links.example.txt` for what a useful set of links looks like.

Scheduled jobs (`vercel.json`):

| Job | Schedule | Does |
|---|---|---|
| `/api/cron` | daily 09:00 | Drain up to 5 pending user submissions |
| `/api/cron/recompute` | daily 10:00 UTC (Vercel) + hourly (GitHub Actions) | Trend + dish + experience rollup |

Both accept `Authorization: Bearer $CRON_SECRET` or `$PIPELINE_SECRET`. Vercel
Cron sends `CRON_SECRET`; accepting both avoids the silent 401 loop that
happens when only one is configured.

---

## API reference

### Reads

| Method | Path | Notes |
|---|---|---|
| GET | `/api/trending` | `?city=&region=&cuisine=&gtaOnly=&include=warming&limit=` |
| GET | `/api/dishes` | `?city=&category=&family=&include=warming&limit=` |
| GET | `/api/dishes/:slug` | Dish + every restaurant serving it + siblings |
| GET | `/api/restaurants` | `?city=&region=&cuisine=&q=&sort=&lat=&lng=&radiusKm=` |
| GET | `/api/restaurants/:id` | Detail + TikTok sources + feedback + viewer state |
| GET | `/api/cities` | GTA cities with live restaurant counts |
| GET | `/api/saves` | The caller's saved restaurants — **auth required** |

### Writes

| Method | Path | Auth |
|---|---|---|
| POST | `/api/submit` | Optional (anonymous allowed, submitter null) |
| POST / DELETE | `/api/restaurants/:id/save` | **Required** |
| POST / DELETE | `/api/restaurants/:id/feedback` | **Required** |
| POST | `/api/events` | Optional (anonymous uses `anonId`) |

Reads return `{ <payload>, meta }`; errors return `{ error, detail? }`.
`meta.heading` is render-ready and carries the provenance claim — pass it
through rather than composing your own heading in the client.

---

## Gotchas

- **`next build` is run with env vars present.** `lib/supabase/client.ts`
  throws at import, so a build with no `SUPABASE_*` set fails during page data
  collection.
- **`nullsFirst: false` on every score ordering.** A null score means "not
  ranked"; Postgres sorts nulls first on `DESC` by default, which would put
  unranked restaurants at the top of the trending list.
- **Legacy Places API.** `GOOGLE_PLACES_API_VERSION=legacy` uses endpoints
  closed to Google Cloud projects created after the cutoff. A 403 on lookups
  means switch to `new`.
- **`dynamic` / `revalidate` route segment config is gone in Next 16** when
  Cache Components is enabled. No route here uses them; prefer reading from
  `request.nextUrl` to stay dynamic.
