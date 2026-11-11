/**
 * Usage watchdog (launchd, every 10 minutes). Reads today's Worker requests and D1 rows read from Cloudflare's
 * analytics API. Over the cap, it detaches the custom domain, so requests fail at DNS before they reach the Worker
 * and nothing more is billed; as a fallback it sets the D1 `kill` flag (the Worker answers 503). On the next UTC day,
 * once usage is back under the cap, it attaches the domain again.
 *
 * Uses the Studio's Wrangler login (no extra token). Plan presets: UFC_CF_PLAN=paid (default) or free.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './db.ts';
import { ACCOUNT_ID, D1_NAME, runWrangler } from './sync.ts';

const HOSTNAME = 'ufcapi.aristotle.me';
const SCRIPT = 'ufc-stats-api';
const ZONE = 'aristotle.me';

const PRESETS = {
  // Paid: 10M requests/month and 25B D1 rows read/month are included, shared by every Worker on the account.
  // 300k a day (9M in a 30-day month) and 750M rows a day keep this API alone under that; the other Workers here
  // are small today. Traffic between two checks (10 minutes plus the analytics delay) can still get past a cap.
  paid: { requests: 300_000, rowsRead: 750_000_000 },
  // Free: the account shares 100,000 requests/day and 5M D1 rows read/day across all its Workers. Stop at half.
  free: { requests: 50_000, rowsRead: 2_500_000 },
};
const plan = (process.env.UFC_CF_PLAN ?? 'paid') as keyof typeof PRESETS;
const caps = {
  requests: Number(process.env.WATCHDOG_MAX_REQUESTS ?? PRESETS[plan].requests),
  rowsRead: Number(process.env.WATCHDOG_MAX_ROWS_READ ?? PRESETS[plan].rowsRead),
};

const STATE = path.join(DATA_DIR, 'watchdog.json');
const ALERT_DIR = path.join(os.homedir(), 'Inbox', 'out');
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

interface State { detachedOn: string | null; killSet: boolean }
const readState = (): State => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { detachedOn: null, killSet: false }; }
};
const writeState = (s: State) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s));
};

function token(): string {
  runWrangler(['whoami']); // refreshes the OAuth token if it has expired
  const cfg = fs.readFileSync(path.join(os.homedir(), 'Library/Preferences/.wrangler/config/default.toml'), 'utf8');
  const m = cfg.match(/^oauth_token\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('no Wrangler OAuth token; run `wrangler login`');
  return m[1];
}

async function cf(tok: string, method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/${p}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json: any = await res.json();
  if (!json.success && !json.data) throw new Error(`${method} ${p}: ${JSON.stringify(json.errors ?? json)}`);
  return json;
}

async function usage(tok: string, date: string, databaseId: string) {
  const query = `{ viewer { accounts(filter: { accountTag: "${ACCOUNT_ID}" }) {
    w: workersInvocationsAdaptive(limit: 10, filter: { date: "${date}", scriptName: "${SCRIPT}" }) { sum { requests } }
    d: d1AnalyticsAdaptiveGroups(limit: 10, filter: { date: "${date}", databaseId: "${databaseId}" }) { sum { rowsRead } }
  } } }`;
  const out = await cf(tok, 'POST', 'graphql', { query });
  if (out.errors?.length) throw new Error(`graphql: ${JSON.stringify(out.errors)}`);
  const a = out.data.viewer.accounts[0];
  return {
    requests: a.w.reduce((t: number, r: any) => t + r.sum.requests, 0),
    rowsRead: a.d.reduce((t: number, r: any) => t + r.sum.rowsRead, 0),
  };
}

function alert(title: string, text: string) {
  log(`${title}: ${text}`);
  try {
    fs.mkdirSync(ALERT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ALERT_DIR, `UFC-API-${title.replace(/\W+/g, '-')}.txt`), `${new Date().toISOString()}\n${text}\n`);
  } catch { /* Inbox may not exist on every machine */ }
}

function databaseId(): string {
  const cfg = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'worker', 'wrangler.jsonc'), 'utf8');
  const m = cfg.match(/"database_id":\s*"([^"]+)"/);
  if (!m || /^0{8}-/.test(m[1])) throw new Error('worker/wrangler.jsonc has no real database_id yet (not deployed)');
  return m[1];
}

function setKill(on: boolean) {
  runWrangler(['d1', 'execute', D1_NAME, '--remote', '--yes', '--command',
    on ? "INSERT OR REPLACE INTO meta (key, value) VALUES ('kill', '1')" : "DELETE FROM meta WHERE key = 'kill'"]);
}

async function main() {
  const tok = token();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const db = databaseId();
  const [now, prev] = await Promise.all([usage(tok, today, db), usage(tok, yesterday, db)]);
  const state = readState();
  log(`today ${now.requests} requests, ${now.rowsRead} rows read (caps ${caps.requests}, ${caps.rowsRead}; plan ${plan}); yesterday ${prev.requests}, ${prev.rowsRead}`);

  const over = now.requests > caps.requests || now.rowsRead > caps.rowsRead;
  if (over && !state.detachedOn) {
    let detached = false;
    try {
      const domains = (await cf(tok, 'GET', `accounts/${ACCOUNT_ID}/workers/domains?hostname=${HOSTNAME}`)).result as { id: string }[];
      for (const d of domains) await cf(tok, 'DELETE', `accounts/${ACCOUNT_ID}/workers/domains/${d.id}`);
      detached = domains.length > 0;
    } catch (e) {
      log(`detach failed: ${(e as Error).message}`);
    }
    let killSet = false;
    if (!detached) {
      try {
        setKill(true);
        killSet = true;
      } catch (e) {
        log(`kill flag failed: ${(e as Error).message}`);
      }
    }
    if (!detached && !killSet) {
      alert('PAUSE-FAILED', `Usage over the daily cap (${now.requests} requests, ${now.rowsRead} D1 rows read) and neither ` +
        `the domain detach nor the D1 kill flag worked. Detach ${HOSTNAME} in the Cloudflare dashboard. The watchdog tries again in 10 minutes.`);
      process.exitCode = 1;
      return;
    }
    writeState({ detachedOn: today, killSet });
    alert('PAUSED', `Usage over the daily cap (${now.requests} requests, ${now.rowsRead} D1 rows read). ` +
      `${detached ? `Custom domain ${HOSTNAME} detached.` : 'Domain detach failed; D1 kill flag set (Worker answers 503).'} ` +
      'It comes back automatically on the next UTC day if usage stays under the cap.');
    return;
  }

  if (state.detachedOn && state.detachedOn !== today && !over) {
    const zone = (await cf(tok, 'GET', `zones?name=${ZONE}`)).result[0];
    await cf(tok, 'PUT', `accounts/${ACCOUNT_ID}/workers/domains`, {
      environment: 'production', hostname: HOSTNAME, service: SCRIPT, zone_id: zone.id,
    });
    if (state.killSet) setKill(false);
    writeState({ detachedOn: null, killSet: false });
    alert('RESUMED', `New UTC day; ${HOSTNAME} attached again.`);
    return;
  }

  // cost-guardrails: flag a 10x day-over-day jump early, before it reaches the cap.
  if (prev.requests > 0 && now.requests > 10 * prev.requests && now.requests > 10_000) {
    alert('SPIKE', `Requests today (${now.requests}) are over 10x yesterday (${prev.requests}).`);
  }
}

main().catch((e) => {
  // Without usage numbers the watchdog can't tell whether to pause, so it says so instead of guessing.
  alert('WATCHDOG-FAILED', `The usage check failed: ${(e as Error).message}. It runs again in 10 minutes.`);
  process.exitCode = 1;
});
