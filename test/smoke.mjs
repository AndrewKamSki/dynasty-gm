// Smoke test: serves the app locally, mocks Sleeper and FantasyCalc with generated data, and checks every screen renders.
// Run: node test/smoke.mjs  (needs Playwright)
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const POS = [["QB", 3], ["RB", 9], ["WR", 12], ["TE", 4]];
const players = {}, fc = [], rosters = [];
const records = [[1, 6, 2, 1210.92], [2, 1, 7, 908.68], [3, 4, 4, 847.72], [4, 0, 8, 701.02], [5, 8, 0, 1161.76], [6, 5, 3, 1146.36], [7, 5, 3, 1085.5], [8, 4, 4, 970.52], [9, 4, 4, 1089.06], [10, 3, 5, 872.66]];
let pid = 1000;
const ppgOf = {};
for (const [rid, w, l, pf] of records) {
  const ids = [];
  for (const [p, n] of POS) for (let i = 0; i < n; i++) {
    const id = String(pid++), age = 21 + Math.floor(rnd() * 14);
    const prod = Math.max(0, (p === "QB" ? 22 : p === "TE" ? 11 : 15) * (1 - i / (n + 2)) * (0.6 + rnd() * 0.8));
    const by = 2026 - age;
    players[id] = { full_name: `${p} Player ${id}`, position: p, team: "NYJ", birth_date: `${by}-03-01`, years_exp: Math.max(0, age - 22), injury_status: rnd() < 0.05 ? "Questionable" : null };
    ppgOf[id] = prod;
    const ageF = age <= 25 ? 1.4 : age <= 28 ? 1 : 0.5;
    fc.push({ player: { sleeperId: id, name: players[id].full_name, position: p, maybeAge: age }, value: Math.round(prod * 380 * ageF), trend30Day: Math.round((rnd() - 0.5) * 600) });
    ids.push(id);
  }
  rosters.push({ roster_id: rid, owner_id: rid === 6 ? "604370585304240128" : "u" + rid, players: ids, starters: ids.slice(0, 10), taxi: [ids[8]], reserve: [ids[20]], settings: { wins: w, losses: l, ties: 0, fpts: Math.floor(pf), fpts_decimal: Math.round((pf % 1) * 100) } });
}
players["9999"] = { full_name: "Some Kicker", position: "K", team: "KC" };
for (const y of [2027, 2028, 2029]) for (const r of [1, 2, 3]) fc.push({ player: { name: `${y} ${["", "1st", "2nd", "3rd"][r]}`, position: "PICK" }, value: [0, 3200, 1200, 500][r] });
for (let s = 1; s <= 10; s++) fc.push({ player: { name: `2027 Pick 1.${String(s).padStart(2, "0")}`, position: "PICK" }, value: 5200 - s * 300 });
const matchups = w => rosters.map(r => ({ roster_id: r.roster_id, players: r.players, players_points: Object.fromEntries(r.players.map(id => [id, Math.max(0, ppgOf[id] * (0.5 + rnd()))])) }));
const league = { league_id: "L1", name: "Happy Hour Dynasty", season: "2026", status: "in_season", total_rosters: 10, scoring_settings: { rec: 0.5 }, settings: { draft_rounds: 4 }, roster_positions: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "FLEX", "SUPER_FLEX", "K", "DEF", "BN", "BN"] };
const users = rosters.map(r => ({ user_id: r.owner_id, display_name: r.roster_id === 6 ? "komestat" : "user" + r.roster_id, metadata: { team_name: r.roster_id === 6 ? "Jaxson Mahomies' Penix" : "Team " + r.roster_id } }));
const traded = [{ season: "2027", round: 3, roster_id: 4, owner_id: 6 }, { season: "2027", round: 2, roster_id: 6, owner_id: 2 }];

function sleeper(path) {
  if (path === "/v1/state/nfl") return { season: "2026", week: 9, display_week: 9, previous_season: "2025" };
  if (path === "/v1/user/komestat") return { user_id: "604370585304240128", display_name: "komestat" };
  if (/\/leagues\/nfl\/2026$/.test(path)) return [league];
  if (path === "/v1/players/nfl") return players;
  if (path === "/v1/league/L1") return league;
  if (path === "/v1/league/L1/rosters") return rosters;
  if (path === "/v1/league/L1/users") return users;
  if (path === "/v1/league/L1/traded_picks") return traded;
  const m = path.match(/matchups\/(\d+)$/); if (m) return matchups(+m[1]);
  return null;
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const p = req.url.split("?")[0].split("#")[0];
  try { res.writeHead(200, { "content-type": types[extname(p)] || "text/html" }); res.end(readFileSync(join(root, p === "/" ? "index.html" : p))); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;

const noFc = process.argv.includes("--no-values");
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => m.type() === "error" && !m.text().includes("ERR_FAILED") && errors.push(m.text()));
await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
await page.route("https://api.sleeper.app/**", r => { const d = sleeper(new URL(r.request().url()).pathname); d == null ? r.fulfill({ status: 404, body: "null" }) : r.fulfill({ json: d, headers: { "access-control-allow-origin": "*" } }); });
await page.route("https://api.fantasycalc.com/**", r => noFc ? r.abort() : r.fulfill({ json: fc, headers: { "access-control-allow-origin": "*" } }));
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => document.getElementById("h-team").textContent !== "Dynasty GM", null, { timeout: 15000 });
const out = process.env.OUT || ".";
const check = async (label) => {
  const info = await page.evaluate(() => ({ rows: document.querySelectorAll("#rtab tbody tr").length, trades: document.querySelectorAll(".trade").length, league: document.querySelectorAll("#ltab tbody tr").length, picks: document.querySelectorAll("#picks .asset").length, status: document.getElementById("status").textContent }));
  console.log(label, JSON.stringify(info));
  return info;
};
await check("contend roster");
await page.screenshot({ path: `${out}/roster.png`, fullPage: true });
await page.click("#t-trades");
const c = await check("contend trades");
await page.screenshot({ path: `${out}/trades-contend.png`, fullPage: true });
await page.click("#m-rebuild");
const r = await check("rebuild trades");
if (r.trades) await page.click("#try-rebuild-0");
await page.screenshot({ path: `${out}/trades-rebuild.png`, fullPage: true });
await page.click("#t-roster");
await page.screenshot({ path: `${out}/roster-after-trade.png`, fullPage: true });
await page.click("#t-league");
await check("league");
await page.setViewportSize({ width: 390, height: 844 });
await page.click("#t-trades");
await page.screenshot({ path: `${out}/phone.png`, fullPage: false });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log("phone horizontal overflow:", overflow);
console.log("errors:", errors);
await b.close(); server.close();
if (errors.length || overflow || !c.trades || !r.trades) process.exit(1);
