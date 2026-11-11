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
export const ACCOUNT_ID = '50c7fea4e988671380a7ba6b6a4e54fd';
/** D1 refuses statements over 100 KB. */
const MAX_STATEMENT_BYTES = 90_000;

const sqlValue = (v: string | number | null): string =>
  v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${v.replace(/'/g, "''")}'`;

const hash = (r: Row) => crypto.createHash('sha1').update(JSON.stringify(r)).digest('hex');

function inserts(table: string, rows: Row[], verb = 'INSERT OR REPLACE'): string[] {
  if (rows.length === 0) return [];
  const cols = Object.keys(rows[0]);
  const head = `${verb} INTO ${table} (${cols.join(', ')}) VALUES\n`;
  const out: string[] = [];
  let batch: string[] = [];
  let size = head.length;
  for (const r of rows) {
    const tuple = `(${cols.map((c) => sqlValue(r[c])).join(', ')})`;
    if (tuple.length + head.length > MAX_STATEMENT_BYTES) throw new Error(`${table} row ${r.id} is too large for one D1 statement`);
    if (batch.length && size + tuple.length + 2 > MAX_STATEMENT_BYTES) {
      out.push(head + batch.join(',\n') + ';');
      batch = [];
      size = head.length;
    }
    batch.push(tuple);
    size += tuple.length + 2;
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
export function sync(db: DatabaseSync, target: Target, opts: { log?: (m: string) => void; dryRun?: boolean } = {}): SyncResult {
  const log = opts.log ?? console.log;
  const built = build(db);
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
    const gone = [...served.keys()].filter((k) => k.startsWith(`${tbl}:`)).map((k) => k.slice(tbl.length + 1)).filter((id) => !present.has(id));
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
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}
