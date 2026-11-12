/**
 * Installs (or with --uninstall removes) the two launchd jobs on this Mac, run from this checkout:
 *   me.aristotle.ufcstats.weekly    Sunday and Monday 14:00 local time (set the Mac to US Eastern)
 *   me.aristotle.ufcstats.watchdog  every 2 minutes
 * Usage: node scraper/install-launchd.ts --target remote --plan paid
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DATA_DIR } from './db.ts';
import { REPO_ROOT } from './sync.ts';

const { values } = parseArgs({
  options: { target: { type: 'string', default: 'remote' }, plan: { type: 'string', default: 'paid' }, uninstall: { type: 'boolean' } },
});

const AGENTS = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LOGS = path.join(DATA_DIR, 'logs');
const uid = process.getuid!();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(label: string, script: string[], schedule: string, env: Record<string, string>): string {
  const args = [process.execPath, '--no-warnings', ...script].map((a) => `    <string>${esc(a)}</string>`).join('\n');
  const envXml = Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${esc(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
${schedule}
  <key>StandardOutPath</key><string>${esc(path.join(LOGS, `${label.split('.').pop()}.log`))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(LOGS, `${label.split('.').pop()}.log`))}</string>
</dict>
</plist>
`;
}

// launchd runs a missed calendar job when the Mac wakes, so a Mac asleep at 14:00 still runs it.
const weeklySchedule = `  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>
  </array>`;
const watchdogSchedule = `  <key>StartInterval</key><integer>120</integer>`;

if (!values.uninstall && !process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error('set CLOUDFLARE_ACCOUNT_ID before installing');
const env: Record<string, string> = {
  PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
  ...(process.env.UFC_ALERT_DIR ? { UFC_ALERT_DIR: process.env.UFC_ALERT_DIR } : {}),
  UFC_DATA_DIR: DATA_DIR,
  UFC_D1_TARGET: values.target!,
  UFC_CF_PLAN: values.plan!,
};

const jobs = [
  { label: 'me.aristotle.ufcstats.weekly', body: plist('me.aristotle.ufcstats.weekly', [path.join(REPO_ROOT, 'scraper', 'cli.ts'), 'weekly'], weeklySchedule, env) },
  { label: 'me.aristotle.ufcstats.watchdog', body: plist('me.aristotle.ufcstats.watchdog', [path.join(REPO_ROOT, 'scraper', 'watchdog.ts')], watchdogSchedule, env) },
];

fs.mkdirSync(LOGS, { recursive: true });
for (const job of jobs) {
  const file = path.join(AGENTS, `${job.label}.plist`);
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${job.label}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  if (values.uninstall) {
    fs.rmSync(file, { force: true });
    console.log(`removed ${job.label}`);
    continue;
  }
  fs.writeFileSync(file, job.body);
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, file]);
  console.log(`installed ${job.label} -> ${file}`);
}
