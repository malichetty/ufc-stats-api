import type { DatabaseSync } from 'node:sqlite';
/** One row of a D1 serving table. Column order is the INSERT order. */
export type Row = Record<string, string | number | null>;

export interface Built {
  events: Row[];
  fights: Row[];
  fighters: Row[];
  name_tokens: Row[];
  event_tokens: Row[];
  meta: Row[];
}

type Any = Record<string, any>;

export const tokens = (s: string | null | undefined): string[] =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const pct = (l: number | null, a: number | null) => (l === null || a === null || a === 0 ? null : Math.round((l / a) * 100) / 100);
const clock = (s: number | null) => (s === null ? null : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

function statLine(s: Any | undefined, name: string | null, id: string | null): Any | null {
  if (!s) return null;
  const pair = (k: string) => ({ landed: s[`${k}_landed`], attempted: s[`${k}_attempted`] });
  return {
    fighter: name,
    fighter_id: id,
    kd: s.kd,
    sig_str: pair('sig'),
    sig_str_pct: pct(s.sig_landed, s.sig_attempted),
    total_str: pair('total'),
    td: pair('td'),
    td_pct: pct(s.td_landed, s.td_attempted),
    sub_att: s.sub_att,
    rev: s.rev,
    ctrl: clock(s.ctrl_seconds),
    ctrl_seconds: s.ctrl_seconds,
    head: pair('head'),
    body: pair('body'),
    leg: pair('leg'),
    distance: pair('distance'),
    clinch: pair('clinch'),
    ground: pair('ground'),
  };
}

const resultWord: Record<string, string> = { W: 'win', L: 'loss', D: 'draw', NC: 'nc' };

/** Build every D1 row from the Studio tables. Pure read; the caller diffs it against what was loaded. */
export function build(db: DatabaseSync): Built {
  const events = db.prepare(`SELECT * FROM events WHERE scraped_at IS NOT NULL ORDER BY date, id`).all() as Any[];
  const eventById = new Map(events.map((e) => [e.id, e]));
  const fights = (db.prepare(`SELECT * FROM fights WHERE page_scraped_at IS NOT NULL`).all() as Any[])
    .filter((f) => eventById.has(f.event_id))
    .sort((a, b) => {
      const ea = eventById.get(a.event_id)!, eb = eventById.get(b.event_id)!;
      return (ea.date ?? '').localeCompare(eb.date ?? '') || ea.id.localeCompare(eb.id) ||
        (b.bout_order ?? 0) - (a.bout_order ?? 0) || a.id.localeCompare(b.id);
    });
  const stats = db.prepare(`SELECT * FROM fight_stats ORDER BY fight_id, round`).all() as Any[];
  const statsByFight = new Map<string, Any[]>();
  for (const s of stats) {
    const list = statsByFight.get(s.fight_id) ?? [];
    list.push(s);
    statsByFight.set(s.fight_id, list);
  }
  const fighters = db.prepare(`SELECT * FROM fighters WHERE profile_scraped_at IS NOT NULL`).all() as Any[];

  const eventRef = (e: Any) => ({ id: e.id, name: e.name, date: e.date, location: e.location });

  // ---- fights
  const fightRows: Row[] = [];
  const fightCards = new Map<string, Any[]>();
  const historyByFighter = new Map<string, Any[]>();
  fights.forEach((f, i) => {
    const e = eventById.get(f.event_id)!;
    const fs = statsByFight.get(f.id) ?? [];
    const of = (fid: string | null, round: number) => fs.find((s) => s.fighter_id === fid && s.round === round);
    const rounds = [...new Set(fs.map((s) => s.round).filter((r) => r > 0))].sort((a, b) => a - b);
    const winnerSide = f.fighter1_result === 'W' ? 1 : f.fighter2_result === 'W' ? 2 : 0;
    const side = (n: 1 | 2) => ({
      id: f[`fighter${n}_id`],
      name: f[`fighter${n}_name`],
      nickname: f[`fighter${n}_nickname`],
      result: f[`fighter${n}_result`],
    });
    const resultType = winnerSide ? 'win' : f.fighter1_result === 'D' ? 'draw' : f.fighter1_result === 'NC' ? 'nc' : null;
    const totals = {
      fighter1: statLine(of(f.fighter1_id, 0), f.fighter1_name, f.fighter1_id),
      fighter2: statLine(of(f.fighter2_id, 0), f.fighter2_name, f.fighter2_id),
    };
    const summary = {
      id: f.id,
      event: eventRef(e),
      bout_order: f.bout_order,
      bout: f.bout,
      weight_class: f.weight_class,
      title_bout: !!f.title_bout,
      bonuses: JSON.parse(f.bonuses ?? '[]'),
      fighter1: side(1),
      fighter2: side(2),
      winner: winnerSide ? { id: f[`fighter${winnerSide}_id`], name: f[`fighter${winnerSide}_name`] } : null,
      result_type: resultType,
      method: f.method,
      method_short: f.method_short,
      method_detail: f.method_detail,
      details: f.details,
      round: f.round,
      time: f.time,
      time_format: f.time_format,
      referee: f.referee,
      totals: totals.fighter1 || totals.fighter2 ? totals : null,
    };
    const doc = {
      ...summary,
      rounds: rounds.map((r) => ({
        round: r,
        fighter1: statLine(of(f.fighter1_id, r), f.fighter1_name, f.fighter1_id),
        fighter2: statLine(of(f.fighter2_id, r), f.fighter2_name, f.fighter2_id),
      })),
      url: `http://ufcstats.com/fight-details/${f.id}`,
    };
    fightRows.push({
      id: f.id,
      seq: i + 1,
      event_id: f.event_id,
      date: e.date,
      fighter1_id: f.fighter1_id,
      fighter2_id: f.fighter2_id,
      winner_id: winnerSide ? f[`fighter${winnerSide}_id`] : null,
      method: f.method,
      weight_class: f.weight_class,
      title_bout: f.title_bout ? 1 : 0,
      summary: JSON.stringify(summary),
      doc: JSON.stringify(doc),
    });

    const card = fightCards.get(f.event_id) ?? [];
    card.push({
      id: f.id, bout_order: f.bout_order, bout: f.bout, weight_class: f.weight_class, title_bout: !!f.title_bout,
      bonuses: summary.bonuses, fighter1: summary.fighter1, fighter2: summary.fighter2, winner: summary.winner,
      result_type: resultType, method: f.method, method_short: f.method_short, method_detail: f.method_detail,
      round: f.round, time: f.time, referee: f.referee,
    });
    fightCards.set(f.event_id, card);

    for (const n of [1, 2] as const) {
      const me = f[`fighter${n}_id`];
      if (!me) continue;
      const o = n === 1 ? 2 : 1;
      const mine = of(me, 0);
      const list = historyByFighter.get(me) ?? [];
      list.push({
        fight_id: f.id,
        event_id: e.id,
        event_name: e.name,
        date: e.date,
        opponent_id: f[`fighter${o}_id`],
        opponent: f[`fighter${o}_name`],
        result: resultWord[f[`fighter${n}_result`]] ?? null,
        method: f.method_short ?? f.method,
        method_detail: f.method_detail,
        round: f.round,
        time: f.time,
        weight_class: f.weight_class,
        title_bout: !!f.title_bout,
        bonuses: summary.bonuses,
        kd: mine?.kd ?? null,
        sig_str: mine?.sig_landed ?? null,
        td: mine?.td_landed ?? null,
        sub_att: mine?.sub_att ?? null,
      });
      historyByFighter.set(me, list);
    }
  });

  // ---- events
  const eventTokenRows: Row[] = [];
  const eventRows: Row[] = events.map((e, i) => {
    for (const t of new Set(tokens(e.name))) eventTokenRows.push({ token: t, event_id: e.id });
    const card = (fightCards.get(e.id) ?? []).sort((a, b) => (a.bout_order ?? 0) - (b.bout_order ?? 0));
    const summary = { id: e.id, name: e.name, date: e.date, location: e.location, fight_count: card.length };
    return {
      id: e.id,
      seq: i + 1,
      name: e.name,
      date: e.date,
      year: e.date ? Number(e.date.slice(0, 4)) : null,
      summary: JSON.stringify(summary),
      doc: JSON.stringify({ ...summary, fights: card, url: `http://ufcstats.com/event-details/${e.id}` }),
    };
  });

  // ---- fighters
  const fighterRows: Row[] = [];
  const nameTokenRows: Row[] = [];
  for (const p of fighters) {
    const history = (historyByFighter.get(p.id) ?? []).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const wins = p.wins ?? 0, losses = p.losses ?? 0, draws = p.draws ?? 0;
    const summary = {
      id: p.id,
      name: p.name,
      first_name: p.first_name,
      last_name: p.last_name,
      nickname: p.nickname,
      record: p.record ?? `${wins}-${losses}-${draws}`,
      wins, losses, draws,
      no_contests: p.no_contests ?? 0,
      height: p.height, height_inches: p.height_inches,
      weight: p.weight, weight_lbs: p.weight_lbs,
      reach: p.reach, reach_inches: p.reach_inches,
      stance: p.stance,
      dob: p.dob,
      weight_class: history[0]?.weight_class ?? null,
      is_champion: !!p.is_champion,
      slpm: p.slpm, str_acc: p.str_acc, sapm: p.sapm, str_def: p.str_def,
      td_avg: p.td_avg, td_acc: p.td_acc, td_def: p.td_def, sub_avg: p.sub_avg,
      ufc_fights: history.length,
    };
    const compact = history.map((h) => ({
      fight_id: h.fight_id, event_id: h.event_id, date: h.date, opponent_id: h.opponent_id, opponent: h.opponent,
      result: h.result, method: h.method, round: h.round, time: h.time,
    }));
    const sortName = `${p.last_name ?? p.name ?? ''} ${p.first_name ?? ''}`.toLowerCase().trim();
    fighterRows.push({
      id: p.id,
      name: p.name,
      sort_name: sortName,
      stance: p.stance,
      weight_class: summary.weight_class,
      wins, losses, draws,
      total_fights: wins + losses + draws,
      is_champion: p.is_champion ? 1 : 0,
      slpm: p.slpm, str_acc: p.str_acc, sapm: p.sapm, str_def: p.str_def,
      td_avg: p.td_avg, td_acc: p.td_acc, td_def: p.td_def, sub_avg: p.sub_avg,
      summary: JSON.stringify({ ...summary, fights: compact }),
      doc: JSON.stringify({ ...summary, fights: history, url: `http://ufcstats.com/fighter-details/${p.id}` }),
    });
    for (const t of new Set([...tokens(p.name), ...tokens(p.first_name), ...tokens(p.last_name), ...tokens(p.nickname)])) {
      nameTokenRows.push({ token: t, fighter_id: p.id });
    }
  }

  const stance = (s: string) => fighters.filter((f) => (f.stance ?? '').toLowerCase() === s).length;
  const methods = [...new Set(fights.map((f) => f.method).filter(Boolean))].sort();
  const weightClasses = [...new Set(fights.map((f) => f.weight_class).filter(Boolean))].sort();
  const roundRows = stats.filter((s) => s.round > 0).length;
  const overview = {
    total_fighters: fighters.length,
    total_events: events.length,
    total_fights: fights.length,
    total_round_stat_rows: roundRows,
    champions: fighters.filter((f) => f.is_champion).length,
    latest_event: events.length ? eventRef(events[events.length - 1]) : null,
    stances: { orthodox: stance('orthodox'), southpaw: stance('southpaw'), switch: stance('switch') },
  };
  const meta: Row[] = [
    { key: 'count_events', value: String(events.length) },
    { key: 'count_fights', value: String(fights.length) },
    { key: 'count_fighters', value: String(fighters.length) },
    { key: 'methods', value: JSON.stringify(methods) },
    { key: 'weight_classes', value: JSON.stringify(weightClasses) },
    { key: 'overview', value: JSON.stringify(overview) },
  ];

  return { events: eventRows, fights: fightRows, fighters: fighterRows, name_tokens: nameTokenRows, event_tokens: eventTokenRows, meta };
}

