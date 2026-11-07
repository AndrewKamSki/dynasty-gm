// Data loading: Sleeper API (league, rosters, players, matchups, picks) and FantasyCalc dynasty values.
const SLEEPER = "https://api.sleeper.app/v1";
const FANTASYCALC = "https://api.fantasycalc.com/values/current";
export const SKILL = ["QB", "RB", "WR", "TE"];

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}

function cacheGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    return Date.now() - ts < maxAgeMs ? data : null;
  } catch { return null; }
}
function cacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch { /* storage full or blocked */ }
}
export function clearCache() {
  try { Object.keys(localStorage).filter(k => k.startsWith("dgm:")).forEach(k => localStorage.removeItem(k)); } catch {}
}

export async function getState() {
  return getJSON(`${SLEEPER}/state/nfl`);
}

export async function getUser(username) {
  const u = await getJSON(`${SLEEPER}/user/${encodeURIComponent(username)}`);
  if (!u || !u.user_id) throw new Error(`No Sleeper user named "${username}"`);
  return u;
}

export async function getLeagues(userId, season) {
  return (await getJSON(`${SLEEPER}/user/${userId}/leagues/nfl/${season}`)) || [];
}

// The full player database is ~5 MB, so keep only skill-position fields and cache for a day.
export async function getPlayers() {
  const cached = cacheGet("dgm:players", 24 * 3600e3);
  if (cached) return cached;
  const all = await getJSON(`${SLEEPER}/players/nfl`);
  const slim = {};
  for (const [id, p] of Object.entries(all)) {
    const pos = p.position || (p.fantasy_positions || [])[0];
    if (!SKILL.includes(pos)) continue;
    slim[id] = {
      n: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(),
      p: pos, t: p.team || "FA", b: p.birth_date || null, a: p.age ?? null,
      x: p.years_exp ?? null, i: p.injury_status || null,
    };
  }
  cacheSet("dgm:players", slim);
  return slim;
}

export async function getLeagueBundle(leagueId, week) {
  const [league, rosters, users, traded] = await Promise.all([
    getJSON(`${SLEEPER}/league/${leagueId}`),
    getJSON(`${SLEEPER}/league/${leagueId}/rosters`),
    getJSON(`${SLEEPER}/league/${leagueId}/users`),
    getJSON(`${SLEEPER}/league/${leagueId}/traded_picks`).catch(() => []),
  ]);
  // Points per game in this league's own scoring, from completed weeks' matchups.
  const lastWeek = league.status === "complete" ? 18 : Math.max(0, (week || 1) - 1);
  const weeks = Array.from({ length: Math.min(lastWeek, 18) }, (_, i) => i + 1);
  const key = `dgm:mu:${leagueId}:${lastWeek}`;
  let matchups = cacheGet(key, 6 * 3600e3);
  if (!matchups) {
    matchups = await Promise.all(weeks.map(w => getJSON(`${SLEEPER}/league/${leagueId}/matchups/${w}`).catch(() => [])));
    cacheSet(key, matchups);
  }
  return { league, rosters, users, traded, matchups };
}

// FantasyCalc values for this league's format. Returns { byId: {sleeperId: {...}}, picks: [...] } or null if unreachable.
export async function getValues({ numQbs, numTeams, ppr }) {
  const q = `isDynasty=true&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
  const key = `dgm:fc:${q}`;
  let rows = cacheGet(key, 12 * 3600e3);
  if (!rows) {
    try {
      const raw = await getJSON(`${FANTASYCALC}?${q}`);
      rows = raw.map(r => ({
        id: r.player?.sleeperId ? String(r.player.sleeperId) : null,
        name: r.player?.name || "", pos: r.player?.position || "",
        age: r.player?.maybeAge ?? null, v: Math.round(r.value || 0),
        trend: r.trend30Day ?? 0, rank: r.overallRank ?? null, prank: r.positionRank ?? null,
      }));
      cacheSet(key, rows);
    } catch (e) {
      console.warn("FantasyCalc unavailable", e);
      return null;
    }
  }
  const byId = {}, picks = [];
  for (const r of rows) {
    if (r.pos === "PICK") picks.push(r);
    else if (r.id) byId[r.id] = r;
  }
  return { byId, picks };
}
