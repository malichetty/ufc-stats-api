# PRD: UFC Stats API rebuild (Studio scraper + Cloudflare Worker and D1)

> Re-scrape all of ufcstats.com from the Mac Studio with a real browser, serve it free at `ufcapi.aristotle.me` from a Cloudflare Worker and D1, and append each Saturday's card automatically. Guardrail: the worst case is the API returning errors, never a bill.

**Owner:** Aris · **Status:** Building · **Date:** 2026-11-11
**Builds on:** `ufc_api.py` (the old FastAPI app; its routes and response shapes are the compatibility contract), `README.md` (public endpoint list).

## Scope decisions (confirmed 2026-11-11)

Aris's brief decided these:
- The scraper runs on the Studio and drives Playwright's bundled Chromium as a normal visitor. No stealth, no spoofing, no proxies. One page at a time, at least 2.5 s apart. If ufcstats blocks or rate-limits us, the run stops and reports it.
- "Append" means new events, fights and fighters are inserted by ufcstats ID, and the fighters on a new card get their profile re-scraped. Nothing older is re-scraped unless it is flagged.
- The API is a Worker plus D1 in the personal "Aristotle" account, on `ufcapi.aristotle.me`. The old endpoints and IDs keep working. Data moves to D1 in batched SQL files, never row by row.
- Nothing on Cloudflare or DNS is created before Aris says yes to the exact spec.

The build session decided these:
- One language: The scraper and the Worker are both TypeScript (Node 22 runs the scraper's `.ts` files directly). The Studio's database is a SQLite file through `node:sqlite`, so there's no native module to build.
- Raw pages are kept: Every fetched page is stored gzipped in the Studio database, so a parser fix means re-parsing the stored pages, not re-crawling ufcstats.
- The Worker serves prebuilt JSON: The Studio builds each fighter, event and fight response once per load and stores it in D1 next to the columns used for filtering and sorting. A detail request is one primary-key read.
- The fighter list pages (26 pages, a to z) are fetched every week: They're the only place ufcstats shows the champion belt. That's 26 summary pages, not a re-scrape of fighter profiles.
- Rate limits (revised 2026-11-12, Aris: free for everyone, no user keys): 30 requests a minute and about 1,000 a day per IP (IPv6 per /64), plus 120 a minute per IPv6 /48. The minute and daily counts live in the edge cache (free, per data centre, approximate: requests in flight together or an early eviction can undercount). The Workers rate-limit binding sits in front to catch parallel bursts; live it was too loose to be the per-minute limit on its own (150 sequential requests a minute passed a limit of 30). Only the admin key (the quiz Workers) gets more: 300 a minute. Any other `X-API-Key` is ignored.
- Compatibility: the old admin header `X-API-Key` still lifts the limits. The quiz Workers (`ufc-quiz-proxy`, `ufc-api-proxy`) call `/api/fighters` with it.
- Events off the UFC list (decided by Aris 2026-11-12): ufcstats links 486 more events only from fighter pages (PRIDE, WEC, Strikeforce, Contender Series, Road to UFC and others), with about 2,700 fights and full round stats. They're scraped and served, but lists stay UFC-only unless `?include=all`, so the quiz sees the same data as before. Every event and fight carries `ufc: true|false`.
- **The old Python API is removed** from the repo. It lives in git history, and the Worker replaces it.

## 1. Introduction

The old API at `ufcapi.aristotle.me` is dead: DNS still points at the retired server (198.46.203.166), and the private scraper that fed it was never committed. The quiz at `ufc.aristotle.me` still calls it (its proxy Worker logged 25 requests on 2026-11-11, all failing). ufcstats now puts a JavaScript proof-of-work check ("Checking your browser…", which POSTs to `/__c` and then reloads) in front of every page, so plain HTTP scrapers fail. A headless Chromium passes it in about 0.6 s, and the pass cookie (`_fmc`) lasts a year.

## 2. Goals

- Every detail ufcstats publishes for each event, fight, round and fighter is stored on the Studio and served by the API.
- Every old endpoint answers with the same IDs and a superset of the old fields.
- New Saturday cards appear by Sunday evening (US Eastern) with no manual step.
- The worst case under abuse is errors, never a bill. Most requests are answered from the edge cache.

## 3. User stories

### US-001: Full crawl (Studio)
- [ ] `pnpm crawl --full` seeds the crawl list from the completed-events list and the 26 fighter list pages, then fetches every event, fight and fighter page one at a time, at least 2.5 s apart.
- [ ] The crawl can be resumed: killing it and running it again carries on from the crawl list, and a page already fetched is never fetched twice.
- [ ] On HTTP 403 or 429, a challenge that doesn't clear in 30 s, or 5 failures in a row, it stops with exit code 2 and prints why. It doesn't retry harder.
- [ ] `pnpm crawl:status` prints pages done, pending and failed, and an estimated time left.
- [ ] *Verifiable:* counts after the full crawl are within 1% of the reference dataset (796 events, about 9,015 fights, 4,628 fighters, about 42,356 per-round rows).

### US-002: Parsing (Studio)
- [ ] An event gives its name, date, location, and its card in order, with each fight's bonus icons (Fight of the Night, Performance, KO, Submission).
- [ ] A fight gives both fighters, each fighter's result, the weight class and bout name, whether it was a title bout, the method, the method detail, the round, time, time format, referee and details. It also gives totals and per-round rows: KD, significant strikes, total strikes, takedowns, submission attempts, reversals, control time, and significant strikes by head, body, leg, distance, clinch and ground.
- [ ] A fighter gives name, nickname, record (including no-contests), height, weight, reach, stance, date of birth and the 8 career stats. The list pages add the belt.
- [ ] Pages without stats (early events) parse with empty stats, not an error.
- [ ] *Verifiable:* the sample events' fight counts and per-fight round counts match the ufcstats pages.

### US-003: Weekly append
- [ ] `pnpm weekly` reads the completed list and the upcoming list. It fetches only new events, their fights and their fighters, the fighter list pages, and anything flagged with `pnpm flag <url>`.
- [ ] If an upcoming event dated before today isn't listed as completed yet, the run exits with code 75 ("not published yet"). The retry run picks it up.
- [ ] An event counts as done only when every fight on its card has a result. An incomplete event is fetched again on the next run.
- [ ] Each event's `first_seen_at` is recorded, so publish timing can be read later.
- [ ] Each run also re-reads 100 known fighter profiles (Aris approved 2026-11-12, an exception to "nothing older is re-scraped"): fighters from an off-list card in the last two years first, then the longest unread. That is how a later Road to UFC round made only of known fighters is found.
- [ ] *Verifiable:* running `pnpm weekly` twice in a row, the second run fetches 2 list pages, 26 fighter list pages and 100 profiles, and writes nothing to D1 unless a refreshed profile changed.

### US-004: Load to D1
- [ ] The Studio marks changed rows (by content hash), writes them to one SQL file per load, and runs it with `wrangler d1 execute --file`. The target is set by `UFC_D1_TARGET`: `local`, `remote` or `none`.
- [ ] Each load bumps `data_version` in the D1 `meta` table, so cached responses roll over within 6 minutes.
- [ ] *Verifiable:* a load with nothing changed writes nothing and doesn't bump the version.

### US-005: Public API (Worker)
- [ ] All old routes answer with the old field names: `/`, `/health`, `/docs`, `/api/fighters`, `/api/fighters/compare`, `/api/fighters/{id}`, `/api/fighters/{id}/stats`, `/api/events`, `/api/events/{id}`, `/api/fights`, `/api/fights/{id}`, `/api/stats/leaders` and `/api/stats/overview`.
- [ ] The old filters that never worked (fighter `weight_class`, event `year`) work now. New routes: `/api/fighters/{id}/fights` and `/openapi.json`.
- [ ] `/docs` serves Swagger UI against `/openapi.json`.
- [ ] Every query on the request path uses an index. List paging over events and fights reads at most `limit` rows, through a precomputed sequence number.
- [ ] *Verifiable:* the end-to-end script calls every route against `wrangler dev` and checks status and shape.

### US-007: Events off the UFC list
- [ ] Every fighter profile the crawl reads queues the events it links that aren't stored yet (upcoming cards excepted; a card that leaves the upcoming list without reaching the completed list is fetched then). The weekly run reads the profile of every fighter on the a-z list that has none yet, which is how a new Contender Series or Road to UFC card is found.
- [ ] Events from the completed list are marked `listed`; the rest aren't. A whole-list read clears the mark from an event that drops off the list. An existing warehouse gets the mark from its stored list page. `ufc` is `listed`, plus numbered "UFC N:" cards (ufcstats' list leaves out UFC 1).
- [ ] Deploy order for a change to the serving tables: migration, then the Worker, then the sync, so the old Worker never pages the new rows.
- [ ] `/api/events`, `/api/fights`, `/api/fighters`, `/api/fighters/{id}` and `/api/fighters/{id}/fights` return UFC-list data by default and everything with `include=all`. Detail routes answer for any ID. Default paging still reads only `limit` rows.
- [ ] *Verifiable:* the end-to-end script checks both modes and the query plans; a regression test checks that a profile link queues an unlisted event.

### US-006: Cost and abuse guardrails
- [ ] A per-IP minute limit (counted in the edge cache, with the Workers rate-limit binding in front for bursts) returns 429 with `Retry-After`. A per-IP daily allowance is counted in the edge cache, which is free, and is approximate per data centre. IPv6 addresses are counted per /64.
- [ ] Responses are cached at the edge under a key that includes `data_version`. A cache hit does no D1 read.
- [ ] The watchdog (Studio, every 2 minutes; caps 100k requests and 200M D1 rows read a day on Paid) reads the Worker's requests and D1 rows read for the day from Cloudflare's analytics API. Over the threshold, it detaches the custom domain, so requests fail before they reach the Worker and nothing is billed. It attaches it again at the next UTC midnight. A D1 `kill` flag (Worker answers 503) is the fallback.
- [ ] `workers_dev` and preview URLs are off, so the only way in is the custom domain.
- [ ] IPv6 callers are also limited per /48. `offset` is capped at 20,000, and a page past the end skips its query.
- [ ] *Verifiable:* the end-to-end script sees a 429 after the burst limit and after rotating /64s inside one /48, a clamped offset, a cache HIT on a repeat request, and a new cache key after a version bump.

## 4. Functional requirements

- FR-1: Crawl list table `pages(url, kind, status, attempts, last_error, fetched_at)`. Raw pages go in `raw_pages(url, fetched_at, html_gz)`.
- FR-2: Normalised Studio tables: `events`, `fights`, `fight_stats` (one row per fight, fighter and round; round 0 is the totals), `fighters`, `upcoming_events`, `flags`.
- FR-3: D1 serving tables: `events`, `fights` and `fighters` (filter and sort columns plus `doc` and `summary` JSON), `name_tokens` (the fighter-name search index) and `meta`.
- FR-4: Search uses `name_tokens` (word-prefix match on first name, last name and nickname words). No `LIKE '%x%'` scans.
- FR-5: A fight-method filter matches `method` through the indexed `method_group` column.
- FR-6: launchd jobs on the Studio: `weekly` (Sunday 14:00 and Monday 14:00, US Eastern) and `watchdog` (every 2 minutes). An install script writes the plists.

## 5. Non-goals

- No upcoming-event cards in the API (the weekly job reads that list only for timing).
- No API keys for users. The API is free for everyone; only the admin key exists, for Aris's quiz Workers.
- No re-scraping of old fights for silent corrections, unless flagged.
- No changes to the quiz Workers.

## 6. Design considerations

- Response shapes keep every field the old code read: `name`, `record`, `wins`, `losses`, `draws`, `height`, `weight`, `reach`, `stance`, the eight career stats as fractions (`str_acc: 0.49`), `is_champion`, `fights`. Fights keep `method` and `totals.fighter1.fighter`. Lists keep `{total, limit, offset, data}`.
- JSON is compact, not pretty-printed as before. The Worker joins stored JSON strings without parsing them, so a big list costs little CPU.

## 7. Technical considerations

- Verified source mechanics (2026-11-11): the completed list (`/statistics/events/completed?page=all`) has 796 events, newest first. Event pages list the card main event first, with bonus icons `fight.png`, `perf.png`, `sub.png` and `ko.png`. Fight pages have 4 tables (totals, per-round totals, significant strikes, per-round significant strikes). The per-round header says "Td %" twice, but the columns are in the same order as the totals. Fighter list pages show `belt.png` for champions. Fight-page headers don't send `Last-Modified` and are `no-store`.
- When results appear: the public scraper Greco1899/scrape_ufc_stats refreshes daily at 18:00 UTC and commits only when data changes. For 9 straight Saturday cards (2026-09-19 to 2026-11-07) the new event first appeared in the Sunday 18:00 UTC run, never the Saturday run. So results are up within about 13 hours of a US card ending. The weekly run is Sunday 14:00 Eastern (19:00 UTC in winter, 18:00 UTC in summer), with a retry Monday 14:00 Eastern, and `first_seen_at` records the real timing.
- Cost (cost-guardrails): no queues, no self-scheduling inside Cloudflare. The only timers are launchd on the Studio, each with a fixed schedule. The Worker does at most 1 D1 query per cache miss, plus one `meta` read per data centre every 5 minutes. Writes happen only in the weekly batch.
- Plan: the account's Workers plan can't be read with the OAuth token. The account has exactly 10 D1 databases, which is the Free plan's cap, but a queue there has 4-day retention, which is a Paid-plan setting. Aris confirms the plan at the deploy question. On Free, an 11th D1 database can't be created, and the account-wide cap of 100,000 Worker requests a day is shared with his other 16 Workers.

## 8. Success metrics

- Crawl counts within 1% of the reference.
- At least 90% of requests answered from the edge cache in the first week.
- Zero usage-based charges caused by this API.

## 9. Open questions

- Workers plan (Free or Paid): the answer sets the watchdog thresholds. Decided: Paid. The watchdog cutoff is 100,000 requests a day (3.1M a month, under a third of the 10M included that all of the account's Workers share).
- The old admin key value: if Aris has it, set the same secret so the quiz keeps working untouched. If not, set a new one and update `UFC_API_KEY` on the two quiz Workers.
