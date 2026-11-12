const id = (name: string, what: string) => ({ name, in: 'path', required: true, description: `${what} ID (16 hex characters, as on ufcstats.com)`, schema: { type: 'string', pattern: '^[0-9a-f]{16}$' } });
const q = (name: string, description: string, type: 'string' | 'integer' = 'string', extra: Record<string, unknown> = {}) =>
  ({ name, in: 'query', required: false, description, schema: { type, ...extra } });
const limit = (def: number, max: number) => q('limit', `Page size (max ${max} without a key)`, 'integer', { default: def, minimum: 1, maximum: max });
const offset = q('offset', 'Rows to skip', 'integer', { default: 0, minimum: 0 });
const include = q('include', '`ufc` (default): only events on ufcstats\' UFC list. `all`: also the events ufcstats lists only on fighter pages (PRIDE, WEC, Strikeforce, Contender Series, Road to UFC and others).', 'string', { enum: ['ufc', 'all'], default: 'ufc' });

const ok = (description: string, example?: unknown) => ({
  200: { description, content: { 'application/json': example ? { example } : {} } },
  404: { description: 'Not found' },
  422: { description: 'Bad parameter' },
  429: { description: 'Rate limited. See Retry-After.' },
});

const op = (tag: string, summary: string, parameters: unknown[], description: string, example?: unknown) => ({
  get: { tags: [tag], summary, description, parameters, responses: ok(summary, example) },
});

export function openapi(origin: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'UFC Stats API',
      version: '2.0.0',
      description:
        'Free API for every UFC event, fight, round and fighter on ufcstats.com, updated every Sunday after the Saturday card.\n\n' +
        'Free, no key needed. Limits per IP: 30 requests a minute and about 1,000 a day; past either you get 429 with `Retry-After`. Responses are cached, so repeat requests are fast.\n\n' +
        'Lists cover UFC events by default. Add `include=all` for the other events ufcstats has stats for (PRIDE, WEC, Strikeforce, Contender Series, Road to UFC and others); every event and fight carries `ufc: true|false`, and their IDs work directly either way.\n\n' +
        'IDs are the 16-character ufcstats IDs (for example Conor McGregor is `f4c49976c75c5ab2`). Percentages are fractions (0.49 = 49%).\n\n' +
        'Data from ufcstats.com; UFC data belongs to UFC/Zuffa LLC. For personal and non-commercial use.',
    },
    servers: [{ url: origin }],
    tags: [{ name: 'Fighters' }, { name: 'Events' }, { name: 'Fights' }, { name: 'Stats' }, { name: 'System' }],
    paths: {
      '/api/fighters': op('Fighters', 'List fighters', [
        limit(50, 500), offset,
        q('search', 'Name or nickname words, matched from the start of each word ("conor mcg")'),
        q('min_wins', 'Minimum wins', 'integer'),
        q('stance', 'Orthodox, Southpaw, Switch, ...'),
        q('weight_class', 'Weight class of the fighter\'s latest UFC fight, e.g. Lightweight'),
        q('sort_by', 'name (default), or highest first: wins, losses, draws, slpm, str_acc, sapm, str_def, td_avg, td_acc, td_def, sub_avg'),
        include,
      ], 'Fighters with career stats and a compact UFC fight history (`include=all` adds their other fights). Sorted by last name unless `sort_by` is set.'),
      '/api/fighters/compare': op('Fighters', 'Compare two fighters', [
        { ...q('fighter1', 'First fighter ID'), required: true },
        { ...q('fighter2', 'Second fighter ID'), required: true },
      ], 'Career stats side by side, with who has the edge on each.'),
      '/api/fighters/{id}': op('Fighters', 'Fighter detail', [id('id', 'Fighter'), include],
        'Tale of the tape, career stats, champion flag and every UFC fight with method, round, time and the fighter\'s strike totals.',
        { id: 'f4c49976c75c5ab2', name: 'Conor McGregor', record: '22-7-0', wins: 22, losses: 7, draws: 0, height: '5\' 9"', weight: '155 lbs.', reach: '74"', stance: 'Southpaw', slpm: 5.27, str_acc: 0.49, td_avg: 0.66, fights: ['...'] }),
      '/api/fighters/{id}/stats': op('Fighters', 'Fighter career stats', [id('id', 'Fighter')], 'Record, striking, grappling and physical stats.'),
      '/api/fighters/{id}/fights': op('Fighters', 'Fighter fight history', [id('id', 'Fighter'), include], 'Every UFC fight, newest first (`include=all` adds the rest).'),
      '/api/events': op('Events', 'List events', [
        limit(50, 200), offset,
        q('year', 'Only events in this year', 'integer'),
        q('search', 'Event name words, e.g. "ufc 229"'),
        include,
      ], 'Completed UFC events, newest first.'),
      '/api/events/{id}': op('Events', 'Event detail', [id('id', 'Event')], 'Date, location and the full card in order (main event first), with results and bonuses.'),
      '/api/fights': op('Fights', 'List fights', [
        limit(50, 200), offset,
        q('method', 'Part of the method, e.g. "KO", "Submission", "Decision"'),
        q('search', 'Fighter name words'),
        q('fighter_id', 'Only this fighter\'s fights'),
        q('event_id', 'Only this event\'s fights'),
        q('weight_class', 'e.g. Lightweight, Women\'s Strawweight'),
        include,
      ], 'Fights newest first, with whole-fight totals for both fighters.'),
      '/api/fights/{id}': op('Fights', 'Fight detail', [id('id', 'Fight')],
        'Method, round, time, time format, referee, details, bonuses, totals and round-by-round stats: knockdowns, significant and total strikes, takedowns, submission attempts, reversals, control time, and significant strikes by target (head, body, leg) and position (distance, clinch, ground).'),
      '/api/stats/leaders': op('Stats', 'Stat leaders', [
        q('stat', 'slpm, str_acc, sapm, str_def, td_avg, td_acc, td_def, sub_avg or wins', 'string', { default: 'slpm' }),
        q('limit', 'How many', 'integer', { default: 10, maximum: 50 }),
        q('min_fights', 'Minimum pro fights (wins + losses + draws)', 'integer', { default: 5 }),
      ], 'Highest values first.'),
      '/api/stats/overview': op('Stats', 'Database overview', [], 'Counts, champions, stances, latest event and when the data was last updated.'),
      '/health': op('System', 'Health check', [], 'Counts and data version.'),
    },
  };
}

export const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UFC Stats API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css">
</head>
<body>
<div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
<script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui', deepLinking: true, tryItOutEnabled: true });</script>
</body>
</html>`;
