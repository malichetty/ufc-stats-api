import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.ts';

/** UFC_ALERT_DIR: a folder the owner watches. */
const ALERT_DIR = process.env.UFC_ALERT_DIR ?? path.join(DATA_DIR, 'alerts');

export function alert(title: string, text: string): void {
  console.log(`[${new Date().toISOString()}] ${title}: ${text}`);
  try {
    fs.mkdirSync(ALERT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ALERT_DIR, `UFC-API-${title.replace(/\W+/g, '-')}.txt`), `${new Date().toISOString()}\n${text}\n`);
  } catch { /* the alert folder may not be writable */ }
}
