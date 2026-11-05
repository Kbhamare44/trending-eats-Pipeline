# Compliance posture

What this system does and does not do with other platforms' data. Written down
because the v2 strategy removed autonomous collection from scope, and that
boundary is easy to erode one convenient commit at a time.

## The rule

**Every restaurant in Trending Eats originates from a link a person chose to
submit.** Nothing in this codebase discovers content on its own.

## How content enters

```
person pastes a TikTok link
  -> POST /api/submit                      (user-initiated, authenticated or anonymous)
  -> row in raw_submissions                (status: pending)
  -> background worker picks it up         (never the request path)
  -> TikTok oEmbed                         (public endpoint: metadata + embed HTML)
  -> Supadata transcript                   (TEXT of the submitted URL; see below)
  -> Gemini classify + extract             (reads caption text and transcript text)
  -> Google Places verification            (is this a real, operating business?)
  -> restaurants + reviews rows
```

### Transcripts

We send the URL **the user submitted** to Supadata's transcript endpoint and
keep the returned text. That is the whole of it:

- No video or audio file is downloaded, stored, re-hosted or served by us.
- Only the transcript endpoint is called. No creator endpoint, no search
  endpoint, no listing endpoint.
- Only URLs a person pasted into the app are ever sent. Nothing is discovered.
- A transcript we already hold for the same `tiktok_video_id` is reused rather
  than re-fetched, so a video submitted twice is fetched once.
- `transcript_status` records `ok`, `unavailable`, `failed` or `not_attempted`.
  A video that is private, restricted or silent comes back `unavailable` and
  the pipeline continues on the caption alone when a caption was retrieved.
  Either a retrieved caption or spoken transcript can supply extraction. If
  neither is retrieved, we report a retrieval failure without claiming the
  video has no caption. Provider failures remain retryable.

Commercial-use rights for the transcript service were confirmed by the owner
before this was integrated, which is the condition the v2 strategy sets for
any third-party transcript provider.

If a future change makes this module fetch media rather than text, or fetch a
URL no user submitted, it has left this boundary.

`GET /api/cron` drains the `raw_submissions` queue on a schedule. It is worth
being precise about this, because a scheduled job that touches TikTok *looks*
like the thing we said we would not do:

- It reads rows **that already exist** because a user submitted them.
- It does not search, browse, enumerate, or discover anything.
- If the queue is empty, it does nothing.

If a future change makes that route find URLs rather than consume submitted
ones, it has become a scraper and is out of scope.

## What we never do

| Not done | Why it matters |
|---|---|
| Search TikTok or scrape hashtags | Out of scope per strategy §7 |
| Enumerate creators or their back catalogues | Out of scope |
| Collect comments | Out of scope |
| Download or re-host video files | We embed; playback stays on TikTok. The transcript service returns text, and we store only that text |
| Transcribe anything a user did not submit | `fetchTranscript` is only ever called with the URL from a `raw_submissions` row |
| Read TikTok engagement counts | `TikTokData.likes`/`views` are hardcoded `0`. oEmbed does not expose them and we do not go looking elsewhere. Trend scores use **our own** signals only |
| Circumvent any platform restriction | Private/deleted videos surface as errors and the submission is rejected |

## Trend scores are first-party only

Trend Score inputs, all from `engagement_events` and our own tables:

| Input | Weight | Source |
|---|---|---|
| Growth in unique user saves | 40% | `restaurant_saves` (our users) |
| Growth in accepted submissions | 25% | `reviews` (links our users sent) |
| Unique user engagement | 20% | `engagement_events` (our app) |
| Recency | 15% | timestamps on the above |

This is why every ranking is labelled **"Trending on Trending Eats — <city>"**.
It is a claim about momentum inside this app, which is something we can actually
measure. It is not a claim about TikTok popularity, which we cannot. The API
returns that heading string ready-rendered (`meta.heading`) so the wording
cannot drift screen by screen.

## Claims about real businesses

These are real restaurants, and a confident-looking number can affect them.

- **No score without evidence.** Below the observation floor the score is
  `null` and the state is `insufficient_data`. A null score and a score of zero
  are different facts and are never collapsed. (This fixes live rows where
  `authenticity_score = 0` sat on restaurants with zero reviews.)
- **Negative verdicts need more evidence than positive ones.**
  `below_expectations` requires `EXPERIENCE_MIN_OBSERVATIONS_NEGATIVE` of
  credit-weighted evidence *and* a material gap. Otherwise: `mixed` or
  `insufficient_data`.
- **Evidence is weighted by source.** A 5.0 from three Google raters is not
  three first-hand reports. See the `*Credit` constants in
  `lib/config/trends.ts`.
- **The AI summary prompt** forbids criticisms the source reviews do not
  support, and asks it to say when evidence is thin.
- **Corrections.** Every restaurant page carries a report/removal link.

## Google Places

- `google_place_id` may be cached indefinitely. Other Places fields may not be
  retained beyond 30 days, so `google_data_refreshed_at` records every pull and
  `refreshRestaurantPlaceData()` writes through whenever we re-look-up a place.
- Displayed Google data carries attribution: the API returns
  `restaurant.attribution`, and the detail screen renders it.
- Listings are not created for places Google reports as non-operational.

## Personal data

- Signed-in activity stores the verified `auth.users` id. Nothing else.
- Signed-out activity stores only `anon_id` — a random per-install string, not
  a device or advertising id, never resolved to a person.
- Feedback is displayed without usernames attached.
- `engagement_events` has RLS enabled **with no policies**, so no client-side
  key can read it. Service role only.
- Account deletion goes through the existing `delete-user` Supabase function;
  `ON DELETE CASCADE` on `restaurant_saves` and `restaurant_feedback` removes
  that user's rows with it.

## Writes are authenticated

`userId` used to be read from the request body, unverified — so any caller
could save, submit, or leave feedback as any user, and those actions feed
public scores. All writes now derive identity from the Supabase JWT
(`lib/auth/verify.ts`). Anonymous submissions are allowed with a null
submitter; anonymous saves and feedback are not allowed at all.
