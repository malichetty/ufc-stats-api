import * as cheerio from 'cheerio';

type Cheerio = ReturnType<cheerio.CheerioAPI>;

export const BASE = 'http://ufcstats.com';
export const EVENTS_LIST_URL = `${BASE}/statistics/events/completed?page=all`;
export const UPCOMING_LIST_URL = `${BASE}/statistics/events/upcoming?page=all`;
export const FIGHTER_LIST_URLS = 'abcdefghijklmnopqrstuvwxyz'
  .split('')
  .map((c) => `${BASE}/statistics/fighters?char=${c}&page=all`);

export const eventUrl = (id: string) => `${BASE}/event-details/${id}`;
export const fightUrl = (id: string) => `${BASE}/fight-details/${id}`;
export const fighterUrl = (id: string) => `${BASE}/fighter-details/${id}`;

export type PageKind = 'events_list' | 'upcoming_list' | 'fighter_list' | 'event' | 'fight' | 'fighter';

export function kindOf(url: string): PageKind {
  if (url.includes('/events/completed')) return 'events_list';
  if (url.includes('/events/upcoming')) return 'upcoming_list';
  if (url.includes('/statistics/fighters')) return 'fighter_list';
  if (url.includes('/event-details/')) return 'event';
  if (url.includes('/fight-details/')) return 'fight';
  if (url.includes('/fighter-details/')) return 'fighter';
  throw new Error(`unknown page kind: ${url}`);
}

const idFrom = (href: string | undefined, kind: string): string | null => {
  const m = href?.match(new RegExp(`/${kind}-details/([0-9a-f]{16})`));
  return m ? m[1] : null;
};

const clean = (s: string | undefined | null): string => (s ?? '').replace(/\s+/g, ' ').trim();
const orNull = (s: string): string | null => (s === '' || s === '--' || s === '---' ? null : s);

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "November 07, 2026" or "Jul. 11, 2026" -> "2026-07-11" */
export function parseDate(s: string): string | null {
  const m = clean(s).match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** "4:24" -> 264 */
export function parseClock(s: string): number | null {
  const m = clean(s).match(/^(\d+):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const parsePct = (s: string): number | null => {
  const m = clean(s).match(/^(\d+(?:\.\d+)?)%$/);
  return m ? Math.round(Number(m[1])) / 100 : null;
};

const parseNum = (s: string): number | null => {
  const v = clean(s);
  if (v === '' || v === '--' || v === '---') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const parseOf = (s: string): [number | null, number | null] => {
  const m = clean(s).match(/^(\d+)\s+of\s+(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
};

const bonusesFrom = ($: cheerio.CheerioAPI, el: Cheerio): string[] => {
  const out: string[] = [];
  el.find('img').each((_, img) => {
    const src = $(img).attr('src') ?? '';
    if (src.endsWith('/fight.png')) out.push('fight_of_the_night');
    else if (src.endsWith('/perf.png')) out.push('performance_of_the_night');
    else if (src.endsWith('/sub.png')) out.push('submission_of_the_night');
    else if (src.endsWith('/ko.png')) out.push('knockout_of_the_night');
  });
  return out;
};

export interface ListedEvent {
  id: string;
  name: string;
  date: string | null;
  location: string | null;
}

/** Completed or upcoming events list. */
export function parseEventsList(html: string): ListedEvent[] {
  const $ = cheerio.load(html);
  const out: ListedEvent[] = [];
  $('tr.b-statistics__table-row').each((_, tr) => {
    const a = $(tr).find('a[href*="/event-details/"]').first();
    const id = idFrom(a.attr('href'), 'event');
    if (!id) return;
    out.push({
      id,
      name: clean(a.text()),
      date: parseDate($(tr).find('.b-statistics__date').text()),
      location: orNull(clean($(tr).find('td').eq(1).text())),
    });
  });
  return out;
}

export interface ListedFighter {
  id: string;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  is_champion: boolean;
}

/** Fighter list page (one letter). Only identity and the champion belt are taken from it. */
export function parseFighterList(html: string): ListedFighter[] {
  const $ = cheerio.load(html);
  const out: ListedFighter[] = [];
  $('tr.b-statistics__table-row').each((_, tr) => {
    const tds = $(tr).find('td');
    const id = idFrom(tds.eq(0).find('a').attr('href'), 'fighter');
    if (!id) return;
    out.push({
      id,
      first_name: orNull(clean(tds.eq(0).text())),
      last_name: orNull(clean(tds.eq(1).text())),
      nickname: orNull(clean(tds.eq(2).text())),
      is_champion: tds.eq(10).find('img[src*="belt"]').length > 0,
    });
  });
  return out;
}

export interface CardFight {
  id: string;
  bout_order: number;
  fighter1_id: string | null;
  fighter2_id: string | null;
  fighter1_name: string;
  fighter2_name: string;
  /** flags shown on the event page: ['win'] when the first fighter won, ['draw','draw'], ['nc','nc'], or [] if no result yet */
  flags: string[];
  weight_class: string | null;
  bonuses: string[];
  method: string | null;
  method_detail: string | null;
  round: number | null;
  time: string | null;
}

export interface ParsedEvent {
  id: string;
  name: string;
  date: string | null;
  location: string | null;
  fights: CardFight[];
}

export function parseEvent(id: string, html: string): ParsedEvent {
  const $ = cheerio.load(html);
  const info: Record<string, string> = {};
  $('.b-list__box-list li').each((_, li) => {
    const label = clean($(li).find('.b-list__box-item-title').text()).replace(/:$/, '').toLowerCase();
    const value = clean($(li).clone().find('.b-list__box-item-title').remove().end().text());
    if (label) info[label] = value;
  });
  const fights: CardFight[] = [];
  $('tbody tr.b-fight-details__table-row').each((i, tr) => {
    const fid = idFrom($(tr).attr('data-link'), 'fight');
    if (!fid) return;
    const tds = $(tr).find('td');
    const ps = (n: number) => tds.eq(n).find('p').map((_, p) => clean($(p).text())).get();
    const fighterLinks = tds.eq(1).find('a[href*="/fighter-details/"]');
    const wc = tds.eq(6);
    const method = ps(7);
    fights.push({
      id: fid,
      bout_order: i + 1,
      fighter1_id: idFrom(fighterLinks.eq(0).attr('href'), 'fighter'),
      fighter2_id: idFrom(fighterLinks.eq(1).attr('href'), 'fighter'),
      fighter1_name: clean(fighterLinks.eq(0).text()),
      fighter2_name: clean(fighterLinks.eq(1).text()),
      flags: tds.eq(0).find('.b-flag__text').map((_, f) => clean($(f).text()).toLowerCase()).get(),
      weight_class: orNull(clean(wc.find('p').first().text())),
      bonuses: bonusesFrom($, wc),
      method: orNull(method[0] ?? ''),
      method_detail: orNull(method[1] ?? ''),
      round: parseNum(ps(8)[0] ?? ''),
      time: orNull(ps(9)[0] ?? ''),
    });
  });
  return {
    id,
    name: clean($('.b-content__title-highlight').text()) || clean($('.b-content__title').text()),
    date: parseDate(info['date'] ?? ''),
    location: orNull(info['location'] ?? ''),
    fights,
  };
}

export interface StatLine {
  kd: number | null;
  sig_landed: number | null;
  sig_attempted: number | null;
  total_landed: number | null;
  total_attempted: number | null;
  td_landed: number | null;
  td_attempted: number | null;
  sub_att: number | null;
  rev: number | null;
  ctrl_seconds: number | null;
  head_landed: number | null;
  head_attempted: number | null;
  body_landed: number | null;
  body_attempted: number | null;
  leg_landed: number | null;
  leg_attempted: number | null;
  distance_landed: number | null;
  distance_attempted: number | null;
  clinch_landed: number | null;
  clinch_attempted: number | null;
  ground_landed: number | null;
  ground_attempted: number | null;
}

export const STAT_FIELDS: (keyof StatLine)[] = [
  'kd', 'sig_landed', 'sig_attempted', 'total_landed', 'total_attempted', 'td_landed', 'td_attempted',
  'sub_att', 'rev', 'ctrl_seconds', 'head_landed', 'head_attempted', 'body_landed', 'body_attempted',
  'leg_landed', 'leg_attempted', 'distance_landed', 'distance_attempted', 'clinch_landed',
  'clinch_attempted', 'ground_landed', 'ground_attempted',
];

const emptyLine = (): StatLine =>
  Object.fromEntries(STAT_FIELDS.map((k) => [k, null])) as unknown as StatLine;

export interface ParsedFightStat extends StatLine {
  fighter_id: string;
  /** 0 = whole-fight totals */
  round: number;
}

export interface ParsedFight {
  id: string;
  event_id: string | null;
  bout: string | null;
  title_bout: boolean;
  bonuses: string[];
  fighters: { id: string; name: string; nickname: string | null; result: string | null }[];
  method: string | null;
  round: number | null;
  time: string | null;
  time_format: string | null;
  referee: string | null;
  details: string | null;
  stats: ParsedFightStat[];
}

/** Rows of one stats table, keyed by round (0 for the totals table). Each cell has one <p> per fighter. */
function readStatsTable($: cheerio.CheerioAPI, table: Cheerio): { round: number; cells: string[][]; ids: string[] }[] {
  const rows: { round: number; cells: string[][]; ids: string[] }[] = [];
  let round = 0;
  table.children().each((_, part) => {
    const $part = $(part);
    if (part.type !== 'tag') return;
    if (part.name === 'thead') {
      const m = clean($part.text()).match(/^Round (\d+)$/);
      if (m) round = Number(m[1]);
      return;
    }
    if (part.name !== 'tbody') return;
    $part.find('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length === 0) return;
      const ids = tds.eq(0).find('a[href*="/fighter-details/"]').map((_, a) => idFrom($(a).attr('href'), 'fighter') ?? '').get();
      const cells = tds.map((_, td) => [$(td).find('p').map((_, p) => clean($(p).text())).get()]).get() as unknown as string[][];
      rows.push({ round, cells, ids });
    });
  });
  return rows;
}

export function parseFight(id: string, html: string): ParsedFight {
  const $ = cheerio.load(html);
  const fighters = $('.b-fight-details__person')
    .map((_, p) => {
      const a = $(p).find('a.b-fight-details__person-link, .b-fight-details__person-name a').first();
      return {
        id: idFrom(a.attr('href'), 'fighter') ?? '',
        name: clean(a.text()) || clean($(p).find('.b-fight-details__person-name').text()),
        nickname: orNull(clean($(p).find('.b-fight-details__person-title').text()).replace(/^"|"$/g, '')),
        result: orNull(clean($(p).find('.b-fight-details__person-status').text())),
      };
    })
    .get();

  const head = $('.b-fight-details__fight-title').first();
  const bout = orNull(clean(head.text()));
  const titleBout = head.find('img[src*="belt"]').length > 0 || /title bout/i.test(bout ?? '');

  const info: Record<string, string> = {};
  $('.b-fight-details__content .b-fight-details__text-item, .b-fight-details__content .b-fight-details__text-item_first').each((_, item) => {
    const label = clean($(item).find('.b-fight-details__label').text()).replace(/:$/, '').toLowerCase();
    const value = clean($(item).clone().find('.b-fight-details__label').remove().end().text());
    if (label) info[label] = value;
  });
  // "Details:" is a label inside the second <p>; its value is the rest of that paragraph.
  $('.b-fight-details__content p.b-fight-details__text').each((_, p) => {
    const label = clean($(p).find('.b-fight-details__label').first().text()).toLowerCase();
    if (label.startsWith('details')) {
      info['details'] = clean($(p).clone().find('.b-fight-details__label').remove().end().text());
    }
  });

  const byKey = new Map<string, ParsedFightStat>();
  const line = (fighterId: string, round: number): ParsedFightStat => {
    const key = `${fighterId}:${round}`;
    let s = byKey.get(key);
    if (!s) {
      s = { ...emptyLine(), fighter_id: fighterId, round };
      byKey.set(key, s);
    }
    return s;
  };

  $('table').each((_, t) => {
    const $t = $(t);
    const header = clean($t.find('thead').first().text());
    const isTotals = /\bKD\b/.test(header);
    const isSig = /\bHead\b/.test(header);
    if (!isTotals && !isSig) return;
    for (const row of readStatsTable($, $t)) {
      for (let f = 0; f < 2; f++) {
        const fid = row.ids[f] || fighters[f]?.id;
        if (!fid) continue;
        const cell = (n: number) => row.cells[n]?.[f] ?? '';
        const s = line(fid, row.round);
        if (isTotals) {
          s.kd = parseNum(cell(1));
          [s.sig_landed, s.sig_attempted] = parseOf(cell(2));
          [s.total_landed, s.total_attempted] = parseOf(cell(4));
          [s.td_landed, s.td_attempted] = parseOf(cell(5));
          s.sub_att = parseNum(cell(7));
          s.rev = parseNum(cell(8));
          s.ctrl_seconds = parseClock(cell(9));
        } else {
          [s.sig_landed, s.sig_attempted] = parseOf(cell(1));
          [s.head_landed, s.head_attempted] = parseOf(cell(3));
          [s.body_landed, s.body_attempted] = parseOf(cell(4));
          [s.leg_landed, s.leg_attempted] = parseOf(cell(5));
          [s.distance_landed, s.distance_attempted] = parseOf(cell(6));
          [s.clinch_landed, s.clinch_attempted] = parseOf(cell(7));
          [s.ground_landed, s.ground_attempted] = parseOf(cell(8));
        }
      }
    }
  });

  return {
    id,
    event_id: idFrom($('.b-content__title a').attr('href'), 'event'),
    bout,
    title_bout: titleBout,
    bonuses: bonusesFrom($, head),
    fighters,
    method: orNull(info['method'] ?? ''),
    round: parseNum(info['round'] ?? ''),
    time: orNull(info['time'] ?? ''),
    time_format: orNull(info['time format'] ?? ''),
    referee: orNull(info['referee'] ?? ''),
    details: orNull(info['details'] ?? ''),
    stats: [...byKey.values()],
  };
}

export interface ParsedFighter {
  id: string;
  name: string;
  nickname: string | null;
  record: string | null;
  wins: number | null;
  losses: number | null;
  draws: number | null;
  no_contests: number;
  height: string | null;
  height_inches: number | null;
  weight: string | null;
  weight_lbs: number | null;
  reach: string | null;
  reach_inches: number | null;
  stance: string | null;
  dob: string | null;
  slpm: number | null;
  str_acc: number | null;
  sapm: number | null;
  str_def: number | null;
  td_avg: number | null;
  td_acc: number | null;
  td_def: number | null;
  sub_avg: number | null;
}

export function parseFighter(id: string, html: string): ParsedFighter {
  const $ = cheerio.load(html);
  const info: Record<string, string> = {};
  $('.b-list__box-list li').each((_, li) => {
    const label = clean($(li).find('.b-list__box-item-title').text()).replace(/:$/, '').toLowerCase();
    const value = clean($(li).clone().find('.b-list__box-item-title').remove().end().text());
    if (label) info[label] = value;
  });
  const recordText = clean($('.b-content__title-record').text()).replace(/^Record:\s*/i, '');
  const rm = recordText.match(/^(\d+)-(\d+)-(\d+)(?:\s*\((\d+)\s*NC\))?/i);
  const height = orNull(info['height'] ?? '');
  const hm = height?.match(/(\d+)'\s*(\d+)"/);
  const weight = orNull(info['weight'] ?? '');
  const reach = orNull(info['reach'] ?? '');
  return {
    id,
    name: clean($('.b-content__title-highlight').text()),
    nickname: orNull(clean($('.b-content__Nickname').text())),
    record: rm ? `${rm[1]}-${rm[2]}-${rm[3]}` : orNull(recordText),
    wins: rm ? Number(rm[1]) : null,
    losses: rm ? Number(rm[2]) : null,
    draws: rm ? Number(rm[3]) : null,
    no_contests: rm?.[4] ? Number(rm[4]) : 0,
    height,
    height_inches: hm ? Number(hm[1]) * 12 + Number(hm[2]) : null,
    weight,
    weight_lbs: weight ? parseNum(weight.replace(/\s*lbs\.?$/, '')) : null,
    reach,
    reach_inches: reach ? parseNum(reach.replace(/"$/, '')) : null,
    stance: orNull(info['stance'] ?? ''),
    dob: parseDate(info['dob'] ?? ''),
    slpm: parseNum(info['slpm'] ?? ''),
    str_acc: parsePct(info['str. acc.'] ?? ''),
    sapm: parseNum(info['sapm'] ?? ''),
    str_def: parsePct(info['str. def'] ?? ''),
    td_avg: parseNum(info['td avg.'] ?? ''),
    td_acc: parsePct(info['td acc.'] ?? ''),
    td_def: parsePct(info['td def.'] ?? ''),
    sub_avg: parseNum(info['sub. avg.'] ?? ''),
  };
}
