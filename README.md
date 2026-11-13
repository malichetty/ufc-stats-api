# UFC Stats API

A free REST API for every UFC event, fight, round and fighter on [ufcstats.com](http://ufcstats.com), updated every Sunday after the Saturday card.

**API:** https://ufcapi.aristotle.me · **Docs:** https://ufcapi.aristotle.me/docs

## Data

- 796 events, from UFC 1 (1993) to the latest card
- About 9,000 fights with method, round, time, time format, referee, details and bonuses
- Round-by-round stats for both fighters: knockdowns, significant and total strikes, takedowns, submission attempts, reversals, control time, and significant strikes by target (head, body, leg) and position (distance, clinch, ground)
- With `?include=all`: about 490 more events ufcstats has stats for but leaves off its UFC list (PRIDE, WEC, Strikeforce, Dana White's Contender Series, Road to UFC and others), with about 2,700 fights and the same round-by-round stats. Every event and fight carries `ufc: true|false`.
- 4,628 fighters with tale of the tape (height, weight, reach, stance, date of birth), record, the 8 career stats, champion flag and UFC fight history

IDs are ufcstats' own 16-character IDs, so `f4c49976c75c5ab2` is Conor McGregor here and on ufcstats.com. Percentages are fractions (`0.49` is 49%).

## Limits

Free, with no sign-up and no API key.

| Limit | Per minute | Per day |
|---|---|---|
| Per IP (IPv6: per /64) | 30 | about 1,000 |
| Per IPv6 network (/48) | 120 | about 4,000 |

Daily counts are kept per Cloudflare data centre, so they are approximate.

Past a limit you get `429` with a `Retry-After` header. Responses are cached at the edge for a week (each Sunday's update starts a new cache), and clients may reuse them for 5 minutes.

## Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/fighters` | Fighters. Filters: `search`, `stance`, `weight_class`, `min_wins`, `sort_by`; paging: `limit`, `offset` |
| `GET /api/fighters/{id}` | One fighter with full UFC fight history (`include=all` adds their other fights) |
| `GET /api/fighters/{id}/stats` | Record, striking, grappling, physical |
| `GET /api/fighters/{id}/fights` | Fight history only |
| `GET /api/fighters/compare?fighter1=ID&fighter2=ID` | Two fighters side by side |
| `GET /api/events` | Events, newest first. Filters: `year`, `search`, `include=all` |
| `GET /api/events/{id}` | One event with its card in order |
| `GET /api/fights` | Fights, newest first, with totals. Filters: `method`, `search`, `fighter_id`, `event_id`, `weight_class`, `include=all` |
| `GET /api/fights/{id}` | One fight with round-by-round stats |
| `GET /api/stats/leaders?stat=slpm` | Leaders for slpm, str_acc, sapm, str_def, td_avg, td_acc, td_def, sub_avg or wins |
| `GET /api/stats/overview` | Counts, champions, stances, last update |
| `GET /health`, `GET /openapi.json`, `GET /docs` | Health, OpenAPI spec, Swagger UI |

```bash
curl "https://ufcapi.aristotle.me/api/fighters?search=mcgregor"
curl "https://ufcapi.aristotle.me/api/fights/3eea92e7f26fb05b"        # Khabib vs McGregor, round by round
curl "https://ufcapi.aristotle.me/api/fighters/compare?fighter1=f4c49976c75c5ab2&fighter2=032cc3922d871c7f"
curl "https://ufcapi.aristotle.me/api/stats/leaders?stat=td_avg&limit=10"
```

## How it works

```
ufcstats.com ──(headless Chromium, 1 page / 2.5 s+)──► scraper SQLite ──(weekly SQL batch)──► Cloudflare D1 ◄── Worker ◄── edge cache ◄── you
```

- `scraper/`: runs on a Mac. A headless Chromium loads each page like a visitor's browser would (ufcstats checks for JavaScript), one at a time with a 2.5 s+ gap. Every page is stored gzipped, so parser fixes re-parse stored pages instead of re-crawling.
  ufcstats only serves plain http, so the scraper treats every page as untrusted: Chromium runs with its sandbox on and can reach no host but ufcstats.com, pages with implausible content are refused before anything is stored, an event page can't move a fight that has its own page, and a load that would delete more than a few published rows stops (`pnpm sync --target remote --allow-deletes` overrides it after a check).
- `worker/`: the Cloudflare Worker and D1 schema. The scraper prebuilds each JSON response, so a detail request is one primary-key read and most requests never reach D1.
- launchd runs the weekly job on Sunday and Monday at 14:00 Eastern, and the usage watchdog every 2 minutes.

### Operating it (scraper Mac)

```bash
pnpm install && npx playwright install chromium
pnpm crawl --full                 # first full crawl (~14,500 pages, ~12 h, resumable)
pnpm crawl:status                 # pages done / pending / failed, time left
pnpm weekly                       # what launchd runs: new events, their fights and fighters, list pages, flags, 100 known profiles
pnpm flag http://ufcstats.com/fight-details/<id>   # fetch this page again on the next weekly run
pnpm reparse                      # re-run the parsers over stored pages
pnpm sync --target remote         # load what changed into D1
node scraper/install-launchd.ts --target remote --plan paid   # install the weekly job and the watchdog
pnpm dev                          # local Worker against the local D1
pnpm e2e                          # end-to-end checks against `pnpm dev`
```

A change to the serving tables ships in this order: `wrangler d1 migrations apply ufc-stats --remote`, then `wrangler deploy`, then `pnpm sync --target remote`. Syncing first would let the old Worker page the new rows and cache the result under the new data version. A migration that drops something the live Worker still reads (like 0003, which drops `api_keys`) goes after `wrangler deploy` instead.

Set `CLOUDFLARE_ACCOUNT_ID` (the account that holds the Worker and D1) before syncing or installing the launchd jobs; `install-launchd` copies it into the jobs. Watchdog alerts go to `~/ufc-stats-data/alerts`, or to `UFC_ALERT_DIR` if set when installing.

Data lives in `~/ufc-stats-data` (`UFC_DATA_DIR` to change it). A crawl stops on HTTP 403/429, a browser check that doesn't clear, or 5 failures in a row, and doesn't retry harder.

## License

For personal and non-commercial use. UFC data belongs to UFC/Zuffa LLC; stats come from ufcstats.com.

---

🥊 Built by [Aristotle](https://aristotle.me) for UFC nerds who debate stats at 2am 🤓
