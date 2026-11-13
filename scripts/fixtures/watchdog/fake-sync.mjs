import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const D1_NAME = 'ufc-stats';
export const accountId = () => 'acct-test';
export function runWrangler(args) {
  const sql = args.join(' ');
  if (sql.includes("VALUES ('kill', '1')")) globalThis.__cf.kill = true;
  if (sql.includes("DELETE FROM meta WHERE key = 'kill'")) globalThis.__cf.kill = false;
  return '';
}
