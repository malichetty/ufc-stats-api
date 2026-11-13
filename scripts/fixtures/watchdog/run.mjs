// Runs the real scraper/watchdog.ts tick by tick against a fake Cloudflare account. Prints one JSON line per tick.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
register(new URL('./hooks.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-watchdog-'));
fs.mkdirSync(path.join(home, 'Library/Preferences/.wrangler/config'), { recursive: true });
fs.writeFileSync(path.join(home, 'Library/Preferences/.wrangler/config/default.toml'), 'oauth_token = "dummy"\n');
process.env.HOME = home;
process.env.UFC_DATA_DIR = path.join(home, 'data');
const HOST = 'ufcapi.aristotle.me';
const cf = globalThis.__cf = { domains: new Map([['d0', { id: 'd0', hostname: HOST, service: 'ufc-stats-api' }]]), kill: false, requests: 0, n: 0 };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); const p = u.pathname.replace('/client/v4/', ''); const m = init.method ?? 'GET';
  const ok = (result) => ({ json: async () => ({ success: true, result }) });
  if (p === 'graphql') return { json: async () => ({ data: { viewer: { accounts: [{ w: [{ sum: { requests: cf.requests } }], d: [{ sum: { rowsRead: 0 } }] }] } } }) };
  if (m === 'GET' && p.endsWith('/workers/domains')) return ok([...cf.domains.values()]);
  const del = p.match(/\/workers\/domains\/(.+)$/);
  if (m === 'DELETE' && del) { cf.domains.delete(del[1]); return ok(null); }
  if (m === 'PUT' && p.endsWith('/workers/domains')) { const id = `d${++cf.n}`; cf.domains.set(id, { id, hostname: HOST, service: 'ufc-stats-api' }); return ok({ id }); }
  if (p === 'zones') return ok([{ id: 'zone' }]);
  throw new Error(`unmodelled ${m} ${p}`);
};
console.log = () => {}; // the watchdog's own log lines
let tick = 0;
for (const step of JSON.parse(process.argv[2])) {
  if (step === 'deploy') { const id = `d${++cf.n}`; cf.domains.set(id, { id, hostname: HOST, service: 'ufc-stats-api' }); continue; }
  cf.requests = step;
  await import(`../../../scraper/watchdog.ts?tick=${++tick}`);
  await new Promise((r) => setTimeout(r, 50));
  process.stdout.write(JSON.stringify({ requests: step, attached: cf.domains.size > 0, kill: cf.kill }) + '\n');
}
