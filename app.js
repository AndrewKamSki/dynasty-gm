import { getState, getUser, getLeagues, getPlayers, getLeagueBundle, getValues, clearCache } from "./data.js";
import { buildModel, windowValues, ageStage, CLIFF, PEAK, score } from "./engine.js";
import { findTrades, applyTrade } from "./trades.js";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = n => Math.round(n).toLocaleString("en-US");
const ord = n => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const store = {
  get(k, d) { try { const v = localStorage.getItem("dgm-set:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("dgm-set:" + k, JSON.stringify(v)); } catch {} },
};
const DEFAULT_USER = "komestat";
const DEFAULT_LEAGUE = /happy\s*hour/i;

const ui = { tab: "roster", posF: "All", sortK: "value", partner: "", applied: null };
let model = null, mode = "contend", ideas = { contend: null, rebuild: null }, leagues = [];

function status(msg, err = false) {
  const el = $("status");
  el.hidden = !msg;
  el.innerHTML = msg || "";
  el.classList.toggle("err", err);
}

async function load({ fresh = false } = {}) {
  if (fresh) clearCache();
  const username = store.get("user", DEFAULT_USER);
  $("f-user").value = username;
  try {
    status("Loading your league from Sleeper…");
    const state = await getState();
    const user = await getUser(username);
    let season = state.season;
    leagues = await getLeagues(user.user_id, season);
    if (!leagues.length && state.previous_season) { season = state.previous_season; leagues = await getLeagues(user.user_id, season); }
    if (!leagues.length) throw new Error(`${esc(username)} has no leagues for ${season}`);
    const saved = store.get("league", null);
    const league = leagues.find(l => l.league_id === saved) || leagues.find(l => DEFAULT_LEAGUE.test(l.name)) || leagues[0];
    $("f-league").innerHTML = leagues.map(l => `<option value="${l.league_id}" ${l === league ? "selected" : ""}>${esc(l.name)} (${l.season})</option>`).join("");

    status("Loading players, weekly scores and dynasty values…");
    const slotsRaw = league.roster_positions || [];
    const numQbs = slotsRaw.includes("SUPER_FLEX") || slotsRaw.filter(s => s === "QB").length > 1 ? 2 : 1;
    const ppr = league.scoring_settings?.rec ?? 1;
    const week = state.season === league.season ? (state.display_week || state.week) : 19;
    const [players, bundle, values] = await Promise.all([
      getPlayers(),
      getLeagueBundle(league.league_id, week),
      getValues({ numQbs, numTeams: league.total_rosters || 12, ppr }),
    ]);
    model = buildModel({ players, bundle, values, userId: user.user_id });
    model.week = week; model.numQbs = numQbs; model.ppr = ppr; model.username = username;
    if (!model.me) throw new Error(`${esc(username)} doesn't own a team in ${esc(league.name)}`);
    ideas = { contend: null, rebuild: null };
    ui.applied = null;
    mode = store.get(`mode:${league.league_id}`, model.me.dir === "rebuild" ? "rebuild" : "contend");
    status(values ? "" : "Couldn't reach FantasyCalc for dynasty values, so values below are estimated from points scored and age. Use Refresh data in Settings to try again.", !values);
    $("f-info").textContent = `Last loaded ${new Date().toLocaleString()}. Player list is cached for a day, values for 12 hours.`;
    render();
  } catch (e) {
    console.error(e);
    status(`Couldn't load your league: ${esc(e.message)}. Check the username in <b>Settings</b>, then try again.`, true);
    ui.tab = "settings";
    renderTabs();
  }
}

function current() {
  if (!ui.applied) return model.me;
  return ui.applied.after;
}

function render() {
  if (!model) return;
  const me = model.me, t = current(), L = model.league;
  document.body.classList.toggle("rebuild", mode === "rebuild");
  document.querySelectorAll(".switch button").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  const fmtName = L.roster_positions?.includes("SUPER_FLEX") ? "Superflex" : "1QB";
  $("h-eyebrow").textContent = `${L.name} · ${model.numTeams} teams · ${fmtName} · ${model.ppr} PPR · ${model.username}`;
  $("h-team").textContent = me.name;
  $("h-sub").textContent = L.status === "in_season" ? `${model.season} season, week ${model.week}` : `${model.season} season · ${L.status.replace("_", " ")}`;
  $("m-hint").textContent = `Your record and roster suggest: ${me.dir === "contend" ? "contending" : me.dir === "rebuild" ? "rebuilding" : "on the bubble"}`;
  const v = $("verdict");
  v.hidden = false;
  v.innerHTML = mode === "contend"
    ? `<b>Contending.</b> Trade ideas spend picks and bench players on starters who add points now. They target teams that are out of the race or on the bubble.`
    : `<b>Rebuilding.</b> Trade ideas sell players at or past their position's prime to teams chasing a title, in exchange for young players and picks.`;

  const n = model.numTeams, gpT = me.w + me.l + me.tie;
  $("s-rec").textContent = `${me.w}–${me.l}${me.tie ? "–" + me.tie : ""}`;
  $("s-recs").textContent = `${ord(me.place)} of ${n} in standings`;
  $("s-pf").textContent = me.pf.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  $("s-pfs").textContent = `${ord(me.pfRank)} most${gpT ? ` · ${(me.pf / gpT).toFixed(1)} per week` : ""}`;
  const vals = model.teams.map(x => x === me ? t.totalValue : x.totalValue).sort((a, b) => b - a);
  $("s-val").textContent = fmt(t.totalValue);
  $("s-vals").textContent = `${ord(vals.indexOf(t.totalValue) + 1)} of ${n}${ui.applied ? " · with trade" : ""}`;
  const ages = model.teams.map(x => x.starterAge).filter(Boolean).sort((a, b) => a - b);
  const med = ages[Math.floor(ages.length / 2)];
  $("s-age").textContent = t.starterAge ? t.starterAge.toFixed(1) : "–";
  $("s-ages").textContent = med ? `League median ${med.toFixed(1)}` : "";
  drawWindow(t);
  renderTabs();
  renderRoster(t);
  renderTrades();
  renderLeague();
}

function renderTabs() {
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === ui.tab));
  ["roster", "trades", "league", "settings"].forEach(k => ($("p-" + k).hidden = k !== ui.tab));
}

function drawWindow(t) {
  const yrs = [0, 1, 2, 3].map(i => model.season + i);
  const vals = windowValues(t, model.season), base = windowValues(model.me, model.season);
  const max = Math.max(...vals, ...base) * 1.02, W = 320, H = 62, bw = 50, gap = (W - bw * 4) / 3;
  let s = `<line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="var(--line)"/>`;
  yrs.forEach((y, i) => {
    const x = i * (bw + gap), h = (vals[i] / max) * (H - 16), hb = (base[i] / max) * (H - 16);
    s += `<rect x="${x}" y="${H - h}" width="${bw}" height="${h}" rx="3" fill="var(--mode)" opacity="${i === 0 ? 1 : 0.55}"/>`;
    if (ui.applied) s += `<rect x="${x}" y="${H - hb - 0.75}" width="${bw}" height="1.5" fill="var(--fg)"/>`;
    s += `<text x="${x + bw / 2}" y="${H - h - 4}" font-size="10" text-anchor="middle" fill="var(--muted)" font-family="IBM Plex Mono,monospace">${Math.round(vals[i] / 1000)}k</text>`;
    s += `<text x="${x + bw / 2}" y="${H + 14}" font-size="10" text-anchor="middle" fill="var(--muted)" font-family="IBM Plex Mono,monospace">${y}</text>`;
  });
  $("win").innerHTML = s;
}

function advice(p, starters) {
  const isStarter = starters.has(p.id);
  if (mode === "contend") {
    if (!isStarter && p.v >= 800 && (p.slot === "Taxi" || (p.a != null && p.a <= PEAK[p.p]))) return ["sell", "Trade for points"];
    if (isStarter && p.a != null && p.a >= CLIFF[p.p]) return ["hold", "Ride it out"];
    if (isStarter) return ["hold", "Core starter"];
    return ["hold", "Depth"];
  }
  if (p.a != null && p.a >= CLIFF[p.p] - 1 && p.v >= 500) return ["sell", "Sell now"];
  if (p.a != null && p.a <= PEAK[p.p] - 1) return ["buy", "Build around"];
  return ["hold", "Hold"];
}

function posTag(p) { return `<span class="pos ${p.p}">${p.p === "PK" ? "PK" : p.p}</span>`; }

function renderRoster(t) {
  const pos = ["All", "QB", "RB", "WR", "TE"];
  $("posf").innerHTML = pos.map(p => `<button class="chip" id="pf-${p}" aria-pressed="${p === ui.posF}" data-pos="${p}">${p}</button>`).join("");
  const starters = new Set(t.starters.map(p => p.id));
  const slotOf = new Map(t.lineup.map(x => [x.p.id, x.slot]));
  const gone = ui.applied ? ui.applied.give.filter(x => !x.pick) : [];
  let rows = [...t.players, ...gone.map(p => ({ ...p, isGone: true }))].filter(p => ui.posF === "All" || p.p === ui.posF);
  rows.sort((a, b) => ui.sortK === "age" ? (a.a ?? 99) - (b.a ?? 99) : ui.sortK === "ppg" ? b.ppg - a.ppg : b.v - a.v);
  $("rtab").innerHTML = `<thead><tr><th>Player</th><th>Lineup</th><th class="r">Age</th><th>Stage</th><th class="r">Pts/g</th><th class="r">Value</th><th class="r">30d</th><th>Call</th></tr></thead><tbody>` +
    rows.map(p => {
      const [c, l] = ageStage(p), w = p.a == null ? 0 : Math.min(100, Math.max(8, ((p.a - 21) / 14) * 100));
      const [k, txt] = advice(p, starters);
      const where = p.isGone ? "Traded" : p.isNew ? "New" : starters.has(p.id) ? slotOf.get(p.id) : p.slot === "Start" ? "Bench" : p.slot;
      const tr = p.trend ? `<span class="trend ${p.trend > 0 ? "up" : "down"}">${p.trend > 0 ? "+" : ""}${fmt(p.trend)}</span>` : `<span class="slot">–</span>`;
      return `<tr class="${p.isNew ? "flag" : ""} ${p.isGone ? "out" : ""}"><td>${posTag(p)} ${esc(p.n)} <span class="slot">${esc(p.t)}</span>${p.inj ? `<span class="inj">${esc(p.inj)}</span>` : ""}</td><td class="slot">${where}</td><td class="r num">${p.a != null ? Math.floor(p.a) : "–"}</td><td title="${l}"><span class="agebar" style="--w:${w}%;--c:${c}"></span> <span class="slot">${l}</span></td><td class="r num">${p.gp ? p.ppg.toFixed(1) : "–"}</td><td class="r num">${fmt(p.v)}</td><td class="r num">${tr}</td><td><span class="tag ${k}">${txt}</span></td></tr>`;
    }).join("") + "</tbody>";

  const all = model.teams.map(x => x === model.me ? t : x);
  const medPos = {};
  for (const P of ["QB", "RB", "WR", "TE"]) {
    const arr = all.map(x => x.byPos[P] || 0).sort((a, b) => a - b);
    medPos[P] = arr[Math.floor(arr.length / 2)];
  }
  const top = Math.max(...all.flatMap(x => ["QB", "RB", "WR", "TE"].map(P => x.byPos[P] || 0))) * 1.05 || 1;
  $("posstr").innerHTML = ["QB", "RB", "WR", "TE"].map(P => {
    const v = t.byPos[P] || 0, d = v - medPos[P];
    return `<div class="posrow"><span class="pos ${P}">${P}</span><div class="track"><span style="width:${(v / top) * 100}%;background:var(--${P.toLowerCase()})"></span><em style="left:${(medPos[P] / top) * 100}%"></em></div><span class="num ${d >= 0 ? "up" : "down"}" style="text-align:right;font-size:12px">${d >= 0 ? "+" : ""}${fmt(d)}</span></div>`;
  }).join("");
  $("picks").innerHTML = t.picks.length ? t.picks.map(p => `<div class="asset">${posTag(p)}<span class="nm">${p.n} <small>${esc(p.from)}${p.note ? " · " + p.note : ""}</small></span><span class="num">${fmt(p.v)}</span></div>`).join("") : `<p class="legend">No picks in the next three drafts.</p>`;
}

function assetRow(a) {
  const sub = a.pick ? `${esc(a.from)}${a.note ? " · " + a.note : ""}` : `${esc(a.t)}${a.a != null ? " · " + Math.floor(a.a) : ""}${a.gp ? " · " + a.ppg.toFixed(1) + " ppg" : ""}`;
  return `<div class="asset">${posTag(a)}<span class="nm">${esc(a.n)} <small>${sub}</small></span><span class="num">${fmt(a.v)}</span></div>`;
}

function renderTrades() {
  if (!ideas[mode]) ideas[mode] = findTrades(model, mode);
  const list = ideas[mode];
  const partners = [...new Set(list.map(i => i.partner))];
  const sel = $("tpartner");
  sel.innerHTML = `<option value="">All teams</option>` + partners.map(p => `<option value="${p.id}" ${String(p.id) === ui.partner ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  $("tnote").innerHTML = mode === "contend"
    ? `Ideas for <b>contending</b>: starters on non-contending teams who would improve your lineup, paid for with picks and bench players at a fair value.`
    : `Ideas for <b>rebuilding</b>: your players at or past their prime, sold to contenders who would start them, for young players and picks.`;
  const shown = list.filter(i => !ui.partner || String(i.partner.id) === ui.partner);
  if (!shown.length) {
    $("trades").innerHTML = `<div class="empty">No fair trades found for this direction right now. Try the other direction, or check back after values update.</div>`;
    return;
  }
  const me = model.me;
  $("trades").innerHTML = shown.map(i => {
    const idx = list.indexOf(i);
    const gv = i.give.reduce((a, x) => a + x.v, 0), rv = i.get.reduce((a, x) => a + x.v, 0), diff = rv - gv;
    const pct = Math.max(-50, Math.min(50, (diff / Math.max(gv, rv, 1)) * 100));
    const on = ui.applied && ui.applied.idea === i;
    const dp = i.after.starterPPG - me.starterPPG, da = (i.after.starterAge || 0) - (me.starterAge || 0), dv = i.after.totalValue - me.totalValue;
    const dirTxt = { contend: "contending", rebuild: "rebuilding", bubble: "on the bubble" }[i.partner.dir];
    return `<article class="trade ${on ? "applied" : ""}">
      <div class="thead"><h3>with ${esc(i.partner.name)}</h3><span class="rec">${i.partner.w}–${i.partner.l} · ${dirTxt} · ${esc(i.partner.user)}</span></div>
      <div class="sides"><div class="side"><div class="lbl">You give</div>${i.give.map(assetRow).join("")}</div><div class="arrow" aria-hidden="true">⇄</div><div class="side"><div class="lbl">You get</div>${i.get.map(assetRow).join("")}</div></div>
      <div class="balance"><div class="bar"><span style="${pct >= 0 ? `left:50%;width:${pct}%` : `right:50%;width:${-pct}%`}"></span></div><div class="txt"><span>Raw value ${diff >= 0 ? "gained" : "paid"}: <b class="num">${fmt(Math.abs(diff))}</b></span><span>${i.give.length !== i.get.length ? "Adjusted for consolidation" : Math.abs(pct) < 8 ? "Fair" : diff > 0 ? "You win on value" : "Overpay for fit"}</span></div></div>
      <p class="why">${esc(i.why)}</p>
      <div class="impact"><span>Starter pts/g <b class="${dp >= 0 ? "up" : "down"}">${dp >= 0 ? "+" : ""}${dp.toFixed(1)}</b></span><span>Starter age <b class="${da <= 0 ? "up" : "down"}">${da >= 0 ? "+" : ""}${da.toFixed(1)}</b></span><span>Total value <b class="${dv >= 0 ? "up" : "down"}">${dv >= 0 ? "+" : ""}${fmt(dv)}</b></span></div>
      <div class="tfoot"><button class="btn ${on ? "" : "primary"}" id="try-${mode}-${idx}" data-try="${idx}">${on ? "Undo" : "Try it"}</button><button class="btn" id="copy-${mode}-${idx}" data-copy="${idx}">Copy offer</button></div>
    </article>`;
  }).join("");
}

function renderLeague() {
  const lbl = { contend: "Contending", bubble: "Bubble", rebuild: "Rebuilding" };
  $("ltab").innerHTML = `<thead><tr><th class="r">#</th><th>Team</th><th class="r">W–L</th><th class="r">Points for</th><th class="r">Value</th><th class="r">Starter age</th><th>Direction</th><th>Trade fit</th></tr></thead><tbody>` +
    model.standings.map(t => {
      const isMe = t === model.me;
      const fit = isMe ? "–" : (mode === "contend" && t.dir !== "contend") || (mode === "rebuild" && t.dir !== "rebuild") ? '<span class="tag buy">Good partner</span>' : '<span class="tag hold">Same goal</span>';
      return `<tr class="${isMe ? "me flag" : ""}"><td class="r num">${t.place}</td><td>${esc(t.name)} <span class="slot">${esc(t.user)}</span></td><td class="r num">${t.w}–${t.l}</td><td class="r num">${t.pf.toFixed(2)}</td><td class="r num">${fmt(t.totalValue)}</td><td class="r num">${t.starterAge ? t.starterAge.toFixed(1) : "–"}</td><td>${lbl[t.dir]}</td><td>${fit}</td></tr>`;
    }).join("") + "</tbody>";
}

let toastT;
function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), 2200);
}

document.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.mode) {
    mode = b.dataset.mode; ui.applied = null; ui.partner = "";
    if (model) store.set(`mode:${model.league.league_id}`, mode);
    render();
  } else if (b.dataset.tab) {
    ui.tab = b.dataset.tab; history.replaceState(null, "", "#" + ui.tab); renderTabs();
  } else if (b.dataset.pos) { ui.posF = b.dataset.pos; render(); }
  else if (b.dataset.try !== undefined) {
    const i = ideas[mode][+b.dataset.try];
    const on = ui.applied && ui.applied.idea === i;
    ui.applied = on ? null : { idea: i, after: i.after, give: i.give };
    render();
    toast(on ? "Trade undone" : "Showing your team with this trade. The Roster tab and summary reflect it.");
  } else if (b.dataset.copy !== undefined) {
    const i = ideas[mode][+b.dataset.copy];
    const txt = `Trade idea for ${i.partner.name}: I send ${i.give.map(x => x.n).join(", ")} for ${i.get.map(x => x.n).join(", ")}.`;
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast("Offer copied"), () => toast(txt));
  } else if (b.id === "f-refresh") { load({ fresh: true }); }
});
$("sort").addEventListener("change", e => { ui.sortK = e.target.value; render(); });
$("tpartner").addEventListener("change", e => { ui.partner = e.target.value; renderTrades(); });
$("sform").addEventListener("submit", async e => {
  e.preventDefault();
  const u = $("f-user").value.trim() || DEFAULT_USER;
  const changedUser = u !== store.get("user", DEFAULT_USER);
  store.set("user", u);
  store.set("league", changedUser ? null : $("f-league").value);
  ui.tab = "roster"; history.replaceState(null, "", "#roster");
  await load();
});

const h = location.hash.slice(1);
if (["roster", "trades", "league", "settings"].includes(h)) ui.tab = h;
renderTabs();
load();
