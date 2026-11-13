import type { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Row } from './build.ts';
import { DATA_DIR, tx } from './db.ts';

export type Target = 'local' | 'remote';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKER_DIR = path.join(REPO_ROOT, 'worker');
export const D1_NAME = 'ufc-stats';
/** The Cloudflare account, from the environment so it stays out of this public repo. */
export function accountId(): string {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id) throw new Error('set CLOUDFLARE_ACCOUNT_ID (the Cloudflare account that holds the Worker and D1)');
  return id;
}
/** D1 refuses statements over 100 KB. */
const MAX_STATEMENT_BYTES = 90_000;

const sqlValue = (v: string | number | null): string =>
  v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${v.replace(/'/g, "''")}'`;

const hash = (r: Row) => crypto.createHash('sha1').update(JSON.stringify(r)).digest('hex');

const tupleOf = (cols: string[], r: Row) => `(${cols.map((c) => sqlValue(r[c])).join(', ')})`;
const headOf = (verb: string, table: string, cols: string[]) => `${verb} INTO ${table} (${cols.join(', ')}) VALUES\n`;

function inserts(table: string, rows: Row[], verb = 'INSERT OR REPLACE'): string[] {
  if (rows.length === 0) return [];
  const cols = Object.keys(rows[0]);
  const head = headOf(verb, table, cols);
  const headBytes = Buffer.byteLength(head);
  const out: string[] = [];
  let batch: string[] = [];
  let size = headBytes;
  for (const r of rows) {
    const tuple = tupleOf(cols, r);
    const bytes = Buffer.byteLength(tuple);
    // Measured in bytes, D1's unit. A row can't be skipped instead: build() has already numbered the dense seq paging
    // and the counts with it in. Ingest caps every text field, so this only fires on a real bug.
    if (headBytes + bytes + 1 > MAX_STATEMENT_BYTES) throw new Error(`${table} row ${r.id ?? r.key} is too large for one D1 statement`);
    if (batch.length && size + bytes + 2 > MAX_STATEMENT_BYTES) {
      out.push(head + batch.join(',\n') + ';');
      batch = [];
      size = headBytes;
    }
    batch.push(tuple);
    size += bytes + 2;
  }
  out.push(head + batch.join(',\n') + ';');
  return out;
}

function inList(ids: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(ids.slice(i, i + 500).map((id) => sqlValue(id)).join(', '));
  return out;
}

export interface SyncResult {
  changed: Record<string, number>;
  deleted: Record<string, number>;
  version: string | null;
  file: string | null;
}

/**
 * Load what changed since the last load into D1, as one SQL file run by `wrangler d1 execute`.
 * Nothing changed means nothing is written and the data version stays the same.
 */
export function sync(
  db: DatabaseSync, target: Target, opts: { log?: (m: string) => void; dryRun?: boolean; allowDeletes?: boolean } = {},
): SyncResult {
  const log = opts.log ?? console.log;
  const live = new Set((db.prepare(`SELECT id FROM served WHERE target = ? AND tbl = 'events'`).all(target) as { id: string }[]).map((r) => r.id));
  const built = build(db, live);
  const served = new Map<string, string>();
  for (const r of db.prepare('SELECT tbl, id, hash FROM served WHERE target = ?').all(target) as { tbl: string; id: string; hash: string }[]) {
    served.set(`${r.tbl}:${r.id}`, r.hash);
  }

  const statements: string[] = [];
  const newHashes: { tbl: string; id: string; hash: string }[] = [];
  const goneKeys: { tbl: string; id: string }[] = [];
  const changed: Record<string, number> = {};
  const deleted: Record<string, number> = {};

  const keyOf = (tbl: string, r: Row) => String(tbl === 'meta' ? r.key : r.id);
  for (const tbl of ['events', 'fights', 'fighters', 'meta'] as const) {
    const rows = built[tbl];
    const present = new Set<string>();
    const todo: Row[] = [];
    for (const r of rows) {
      const id = keyOf(tbl, r);
      present.add(id);
      const h = hash(r);
      if (served.get(`${tbl}:${id}`) !== h) {
        todo.push(r);
        newHashes.push({ tbl, id, hash: h });
      }
    }
    const servedIds = [...served.keys()].filter((k) => k.startsWith(`${tbl}:`)).map((k) => k.slice(tbl.length + 1));
    const gone = servedIds.filter((id) => !present.has(id));
    // Published rows are almost never withdrawn; a load that would delete many is a bad page or a bug, not news.
    if (tbl !== 'meta' && !opts.allowDeletes && gone.length > Math.max(5, servedIds.length * 0.01)) {
      throw new Error(`sync(${target}) would delete ${gone.length} of ${servedIds.length} published ${tbl}; nothing loaded. ` +
        'Check the scraper data, then run `pnpm sync --target <target> --allow-deletes` if it is right.');
    }
    changed[tbl] = todo.length;
    deleted[tbl] = gone.length;
    const pk = tbl === 'meta' ? 'key' : 'id';
    for (const list of inList(gone)) statements.push(`DELETE FROM ${tbl} WHERE ${pk} IN (${list});`);
    for (const id of gone) goneKeys.push({ tbl, id });
    const tokenTable = tbl === 'fighters' ? 'name_tokens' : tbl === 'events' ? 'event_tokens' : null;
    if (tokenTable) {
      const ref = tbl === 'fighters' ? 'fighter_id' : 'event_id';
      const touched = [...todo.map((r) => String(r.id)), ...gone];
      for (const list of inList(touched)) statements.push(`DELETE FROM ${tokenTable} WHERE ${ref} IN (${list});`);
      const ids = new Set(todo.map((r) => r.id));
      statements.push(...inserts(tokenTable, built[tokenTable].filter((t) => ids.has(t[ref])), 'INSERT OR IGNORE'));
    }
    statements.push(...inserts(tbl, todo));
  }

  const total = Object.values(changed).reduce((a, b) => a + b, 0) + Object.values(deleted).reduce((a, b) => a + b, 0);
  if (total === 0) {
    log(`sync(${target}): nothing changed, nothing written`);
    return { changed, deleted, version: null, file: null };
  }

  const version = Date.now().toString(36);
  statements.push(...inserts('meta', [
    { key: 'data_version', value: version },
    { key: 'last_updated', value: new Date().toISOString() },
  ]));

  const dir = path.join(DATA_DIR, 'loads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${target}.sql`);
  fs.writeFileSync(file, statements.join('\n') + '\n');
  log(`sync(${target}): ${JSON.stringify(changed)} changed, ${JSON.stringify(deleted)} deleted, ${statements.length} statements -> ${file}`);
  if (opts.dryRun) return { changed, deleted, version, file };

  runWrangler(['d1', 'execute', D1_NAME, target === 'remote' ? '--remote' : '--local', '--file', file, '--yes']);

  tx(db, () => {
    const up = db.prepare('INSERT OR REPLACE INTO served (target, tbl, id, hash) VALUES (?, ?, ?, ?)');
    for (const h of newHashes) up.run(target, h.tbl, h.id, h.hash);
    const del = db.prepare('DELETE FROM served WHERE target = ? AND tbl = ? AND id = ?');
    for (const g of goneKeys) del.run(target, g.tbl, g.id);
  });
  return { changed, deleted, version, file };
}

export function runWrangler(args: string[], input?: string): string {
  const bin = path.join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');
  return execFileSync(bin, args, {
    cwd: WORKER_DIR,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId(), WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}
