// League model: players, lineups, picks, team strength and direction.
import { SKILL } from "./data.js";

export const PEAK = { QB: 30, RB: 25, WR: 27, TE: 28 };
export const CLIFF = { QB: 34, RB: 28, WR: 30, TE: 31 };
const DROP = { QB: 0.10, RB: 0.25, WR: 0.17, TE: 0.14 };
const DEFAULT_PICK = { 1: 3000, 2: 1200, 3: 550, 4: 250, 5: 120 };
const SLOT_ELIG = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"],
  FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};
const SLOT_ORDER = ["QB", "RB", "WR", "TE", "WRRB_FLEX", "REC_FLEX", "FLEX", "SUPER_FLEX"];

export function ageOf(birth, fallback) {
  if (birth) {
    const d = new Date(birth);
    if (!isNaN(d)) return Math.round(((Date.now() - d) / (365.25 * 864e5)) * 10) / 10;
  }
  return fallback ?? null;
}

// Value multiplier for a player y seasons from now, by position and age.
export function project(asset, y) {
  if (asset.pick || asset.a == null) return asset.v;
  let v = asset.v;
  for (let i = 1; i <= y; i++) {
    const a = asset.a + i;
    v *= a <= PEAK[asset.p] ? 1.06 : a < CLIFF[asset.p] ? 0.96 : 1 - DROP[asset.p];
  }
  return v;
}

export function ageStage(p) {
  if (p.a == null) return ["var(--muted)", "unknown"];
  if (p.a <= PEAK[p.p]) return ["var(--good)", "rising"];
  if (p.a < CLIFF[p.p]) return ["var(--warn)", "prime"];
  return ["var(--bad)", "declining"];
}

// Weekly score proxy used to set lineups: real points per game once a player has 2+ games, otherwise value-based.
export const score = p => (p.gp >= 2 ? p.ppg : p.v / 700);

// Fill starting slots greedily: fixed positions first, then narrow flexes, superflex last.
export function lineup(players, slots) {
  const pool = players.filter(p => p.slot !== "IR" && p.slot !== "Taxi").sort((a, b) => score(b) - score(a));
  const used = new Set(), out = [];
  for (const s of SLOT_ORDER) {
    const n = slots.filter(x => x === s).length;
    for (let i = 0; i < n; i++) {
      const pick = pool.find(p => !used.has(p) && SLOT_ELIG[s].includes(p.p));
      if (pick) { used.add(pick); out.push({ slot: s.replace("SUPER_FLEX", "SF").replace(/.*FLEX/, "FLEX"), p: pick }); }
    }
  }
  return out;
}

function fallbackValue(p) {
  // Used only when FantasyCalc is unreachable: production scaled by age stage.
  const base = Math.max(150, (p.ppg || 0) * 320);
  if (p.a == null) return Math.round(base);
  const f = p.a <= PEAK[p.p] ? 1.35 : p.a < CLIFF[p.p] ? 1 : 0.55;
  return Math.round(base * f);
}

function pickValues(fcPicks) {
  // FantasyCalc lists picks as e.g. "2027 1st", "2027 Round 1" or "2027 Pick 1.05". Build season/round -> value and season/round/slot -> value.
  const generic = {}, specific = {};
  for (const r of fcPicks || []) {
    let m = r.name.match(/(\d{4}).*?Pick\s+(\d)\.(\d{1,2})/i);
    if (m) { specific[`${m[1]}-${+m[2]}-${+m[3]}`] = r.v; continue; }
    m = r.name.match(/(\d{4}).*?(?:Round\s*(\d)|(\d)(?:st|nd|rd|th))/i);
    if (m) {
      const k = `${m[1]}-${+(m[2] || m[3])}`;
      if (/early/i.test(r.name)) generic[k + "-early"] = r.v;
      else if (/late/i.test(r.name)) generic[k + "-late"] = r.v;
      else if (/mid/i.test(r.name)) generic[k + "-mid"] = r.v;
      else generic[k] = r.v;
    }
  }
  return { generic, specific };
}

export function buildModel({ players, bundle, values, userId }) {
  const { league, rosters, users, traded, matchups } = bundle;
  const season = +league.season;
  const slots = (league.roster_positions || []).filter(s => SLOT_ELIG[s]);
  const numTeams = league.total_rosters || rosters.length;

  // Points per game in league scoring.
  const pts = {}, gp = {};
  for (const week of matchups || []) for (const m of week || []) {
    for (const [id, v] of Object.entries(m.players_points || {})) {
      if (v === 0 || v == null) continue;
      pts[id] = (pts[id] || 0) + v; gp[id] = (gp[id] || 0) + 1;
    }
  }

  const userMap = Object.fromEntries((users || []).map(u => [u.user_id, u]));
  const teams = rosters.map(r => {
    const u = userMap[r.owner_id] || {};
    const taxi = new Set(r.taxi || []), ir = new Set(r.reserve || []), st = new Set(r.starters || []);
    const ps = (r.players || []).filter(id => players[id]).map(id => {
      const b = players[id], fc = values?.byId[id];
      const p = {
        id, n: b.n, p: b.p, t: b.t, a: ageOf(b.b, b.a ?? fc?.age ?? null), inj: b.i,
        ppg: gp[id] ? pts[id] / gp[id] : 0, gp: gp[id] || 0, trend: fc?.trend || 0,
        slot: taxi.has(id) ? "Taxi" : ir.has(id) ? "IR" : st.has(id) ? "Start" : "Bench",
        rosterId: r.roster_id,
      };
      p.v = values ? (fc?.v || 0) : fallbackValue(p);
      return p;
    });
    const s = r.settings || {};
    return {
      id: r.roster_id, ownerId: r.owner_id, user: u.display_name || "Open team",
      name: u.metadata?.team_name || u.display_name || `Team ${r.roster_id}`,
      w: s.wins || 0, l: s.losses || 0, tie: s.ties || 0,
      pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      players: ps, picks: [],
    };
  });

  // Strength ranks (for projected pick slots and direction).
  for (const t of teams) Object.assign(t, teamStats(t, slots));
  const games = teams.reduce((a, t) => a + t.w + t.l + t.tie, 0) / teams.length;
  const byStrength = [...teams].sort((a, b) => strength(a, games) - strength(b, games)); // weakest first
  byStrength.forEach((t, i) => (t.projSlot = i + 1));

  // Picks: next three drafts (this season's too if its draft hasn't happened).
  const firstSeason = league.status === "pre_draft" ? season : season + 1;
  const rounds = Math.min(league.settings?.draft_rounds || 4, 4);
  const pv = pickValues(values?.picks);
  const owner = {};
  for (let y = firstSeason; y < firstSeason + 3; y++) for (let rd = 1; rd <= rounds; rd++) for (const t of teams) owner[`${y}-${rd}-${t.id}`] = t.id;
  for (const tp of traded || []) {
    const k = `${tp.season}-${tp.round}-${tp.roster_id}`;
    if (k in owner) owner[k] = tp.owner_id;
  }
  const teamById = Object.fromEntries(teams.map(t => [t.id, t]));
  for (const [k, ownerId] of Object.entries(owner)) {
    const [y, rd, orig] = k.split("-").map(Number);
    const o = teamById[orig];
    const slot = y === firstSeason ? o.projSlot : null;
    const tier = slot == null ? "" : slot <= numTeams / 3 ? "early" : slot > (2 * numTeams) / 3 ? "late" : "mid";
    const v = pv.specific[`${y}-${rd}-${slot}`] ?? pv.generic[`${y}-${rd}-${tier}`] ?? pv.generic[`${y}-${rd}`]
      ?? pv.generic[`${firstSeason + 1}-${rd}`] ?? DEFAULT_PICK[rd] ?? 100;
    const label = `${y} ${["", "1st", "2nd", "3rd", "4th"][rd]}`;
    teamById[ownerId]?.picks.push({
      id: `pk-${k}`, pick: true, n: label, p: "PK", season: y, round: rd, v,
      from: orig === ownerId ? "Own" : `via ${o.name}`, note: slot ? `proj. ${rd}.${String(slot).padStart(2, "0")}` : "",
    });
  }
  for (const t of teams) {
    t.picks.sort((a, b) => a.season - b.season || a.round - b.round);
    t.totalValue = t.playerValue + t.picks.reduce((a, p) => a + p.v, 0);
  }

  // Direction.
  const pfRank = rankBy(teams, t => t.pf), valRank = rankBy(teams, t => t.starterValue);
  for (const t of teams) {
    const gpT = t.w + t.l + t.tie, wp = gpT ? (t.w + t.tie / 2) / gpT : null;
    t.pfRank = pfRank[t.id]; t.valRank = valRank[t.id];
    if (wp == null || gpT < 3) t.dir = t.valRank <= numTeams * 0.4 ? "contend" : t.oldShare < 0.25 && t.valRank > numTeams * 0.6 ? "rebuild" : "bubble";
    else if (wp >= 0.6 || (t.pfRank <= 3 && wp >= 0.5)) t.dir = "contend";
    else if (wp <= 0.375 && t.pfRank > numTeams / 2) t.dir = "rebuild";
    else t.dir = "bubble";
  }
  const me = teams.find(t => t.ownerId === userId) || teams.find(t => (t.coOwners || []).includes(userId));
  const standings = [...teams].sort((a, b) => b.w - a.w || b.pf - a.pf);
  standings.forEach((t, i) => (t.place = i + 1));
  return { league, season, slots, numTeams, teams, me, standings, games, hasValues: !!values };
}

function strength(t, games) {
  const gpT = t.w + t.l + t.tie;
  const wp = gpT ? (t.w + t.tie / 2) / gpT : 0.5;
  const weight = Math.min(1, games / 10);
  return weight * (wp * 100 + t.pf / Math.max(1, gpT) / 3) + (1 - weight) * (t.starterValue / 1000);
}
function rankBy(arr, f) {
  const s = [...arr].sort((a, b) => f(b) - f(a));
  return Object.fromEntries(s.map((t, i) => [t.id, i + 1]));
}

export function teamStats(t, slots) {
  const lu = lineup(t.players, slots);
  const starters = lu.map(x => x.p);
  const starterPPG = starters.reduce((a, p) => a + score(p), 0);
  const starterValue = starters.reduce((a, p) => a + p.v, 0);
  const aged = starters.filter(p => p.a != null);
  const starterAge = aged.length ? aged.reduce((a, p) => a + p.a, 0) / aged.length : null;
  const playerValue = t.players.reduce((a, p) => a + p.v, 0);
  const old = t.players.filter(p => p.a != null && p.a >= CLIFF[p.p] - 1).reduce((a, p) => a + p.v, 0);
  const byPos = {};
  for (const p of starters) byPos[p.p] = (byPos[p.p] || 0) + p.v;
  return { lineup: lu, starters, starterPPG, starterValue, starterAge, playerValue, oldShare: playerValue ? old / playerValue : 0, byPos };
}

// Projected roster value for this season and the next three. A pick counts once its draft has happened.
export function windowValues(t, season) {
  return [0, 1, 2, 3].map(y =>
    t.players.reduce((a, p) => a + project(p, y), 0) +
    t.picks.filter(p => p.season <= season + y).reduce((a, p) => a + p.v, 0)
  );
}

export { SKILL };
