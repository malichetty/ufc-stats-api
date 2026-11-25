import path from 'node:path';
export const D1_NAME = 'ufc-stats';
export const remoteWranglerConfig = () => path.join(process.env.UFC_DATA_DIR, 'wrangler.jsonc');
export const accountId = () => 'acct-test';
export function runWrangler(args) {
  const sql = args.join(' ');
  if (sql.includes("VALUES ('kill', '1')")) globalThis.__cf.kill = true;
  if (sql.includes("DELETE FROM meta WHERE key = 'kill'")) globalThis.__cf.kill = false;
  return '';
}
