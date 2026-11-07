// Trade idea generator. Finds deals that move your team toward its goal and that the partner has a reason to accept.
import { teamStats, project, CLIFF, PEAK } from "./engine.js";

// Stars are worth more than the sum of lesser pieces, so value is adjusted upward for high-value assets.
const adj = v => v * (1 + 0.6 * Math.min(1, v / 9000));
const sumAdj = list => list.reduce((a, x) => a + adj(x.v), 0);
const sumV = list => list.reduce((a, x) => a + x.v, 0);

function* subsets(items, maxSize, start = 0, cur = []) {
  if (cur.length) yield cur;
  if (cur.length === maxSize) return;
  for (let i = start; i < items.length; i++) yield* subsets(items, maxSize, i + 1, [...cur, items[i]]);
}

export function applyTrade(team, give, get, slots) {
  const giveIds = new Set(give.map(x => x.id));
  const t = {
    ...team,
    players: team.players.filter(p => !giveIds.has(p.id)).concat(get.filter(x => !x.pick).map(p => ({ ...p, slot: "Bench", isNew: true }))),
    picks: team.picks.filter(p => !giveIds.has(p.id)).concat(get.filter(x => x.pick).map(p => ({ ...p, from: "Acquired", isNew: true }))),
  };
  Object.assign(t, teamStats(t, slots));
  t.totalValue = t.playerValue + t.picks.reduce((a, p) => a + p.v, 0);
  return t;
}

const future = (list, y = 2) => list.reduce((a, x) => a + project(x, y), 0);

export function findTrades(model, mode) {
  const { me, teams, slots } = model;
  if (!me) return [];
  const others = teams.filter(t => t !== me);
  const ideas = [];

  if (mode === "contend") {
    const starterIds = new Set(me.starters.map(p => p.id));
    // What you can spend: picks and non-starters with real value.
    const currency = [...me.picks, ...me.players.filter(p => !starterIds.has(p.id))]
      .filter(x => x.v >= 300).sort((a, b) => b.v - a.v).slice(0, 14);
    const partners = others.filter(t => t.dir !== "contend");
    for (const T of partners) {
      for (const target of T.players) {
        if (target.v < 800 || target.slot === "IR") continue;
        const withTarget = teamStats({ players: [...me.players, { ...target, slot: "Bench" }] }, slots);
        const gain = withTarget.starterPPG - me.starterPPG;
        if (gain < 1.2) continue;
        const want = adj(target.v);
        let best = null;
        for (const s of subsets(currency, 3)) {
          const a = sumAdj(s), ratio = a / want;
          if (ratio < 0.97 || ratio > 1.12) continue;
          if (sumV(s) > target.v * (1 + 0.15 * (s.length - 1)) + 300) continue; // no big raw overpays
          const after = applyTrade(me, s, [target], slots);
          const g = after.starterPPG - me.starterPPG;
          if (g < 1) continue;
          const cost = ratio - 1 + (s.length - 1) * 0.06;
          if (!best || cost < best.cost) best = { give: s, cost, g, after };
        }
        if (!best) continue;
        const partnerAfter = applyTrade(T, [target], best.give, slots);
        ideas.push({
          partner: T, give: best.give, get: [target], after: best.after,
          ppgGain: best.g, score: best.g * 10 - best.cost * 40 + (T.dir === "rebuild" ? 8 : 0),
          why: contendWhy(me, T, target, best, partnerAfter),
        });
      }
    }
  } else {
    // Sell players at or past their position's prime to teams trying to win now.
    const sells = me.players.filter(p => p.a != null && p.a >= CLIFF[p.p] - 2 && p.v >= 700 && p.slot !== "IR");
    const partners = others.filter(t => t.dir !== "rebuild");
    for (const X of sells) {
      for (const T of partners) {
        const tWith = teamStats({ players: [...T.players, { ...X, slot: "Bench" }] }, slots);
        const tGain = tWith.starterPPG - T.starterPPG;
        if (tGain < 1) continue;
        const tStarterIds = new Set(T.starters.map(p => p.id));
        const currency = [
          ...T.picks,
          ...T.players.filter(p => p.a != null && p.a <= PEAK[p.p] && (!tStarterIds.has(p.id) || p.v < X.v * 0.8)),
        ].filter(x => x.v >= 300).sort((a, b) => b.v - a.v).slice(0, 14);
        const want = adj(X.v);
        let best = null;
        for (const s of subsets(currency, 2)) {
          const ratio = sumAdj(s) / want;
          if (ratio < 0.92 || ratio > 1.1) continue;
          const tAfter = applyTrade(T, s, [X], slots);
          if (tAfter.starterPPG - T.starterPPG < 0.5) continue;
          const fGain = future(s) - project(X, 2);
          const cost = Math.abs(ratio - 1);
          if (!best || fGain - cost * 2000 > best.fGain - best.cost * 2000) best = { give: s, ratio, cost, fGain, tAfter };
        }
        if (!best) continue;
        const after = applyTrade(me, [X], best.give, slots);
        ideas.push({
          partner: T, give: [X], get: best.give, after, fGain: best.fGain,
          score: best.fGain / 100 + (T.dir === "contend" ? 8 : 0) - best.cost * 30,
          why: rebuildWhy(me, T, X, best, tGain),
        });
      }
    }
  }

  // Keep the best few, spread across partners and players.
  ideas.sort((a, b) => b.score - a.score);
  const out = [], perPartner = {}, perAsset = {};
  for (const i of ideas) {
    const key = mode === "contend" ? i.get[0].id : i.give[0].id;
    if ((perPartner[i.partner.id] || 0) >= 2 || (perAsset[key] || 0) >= 2) continue;
    perPartner[i.partner.id] = (perPartner[i.partner.id] || 0) + 1;
    perAsset[key] = (perAsset[key] || 0) + 1;
    out.push(i);
    if (out.length >= 12) break;
  }
  return out;
}

const names = list => list.map(x => x.n).reduce((s, n, i, arr) => s + (i === 0 ? "" : i === arr.length - 1 ? " and " : ", ") + n, "");
const recText = T => `${T.w}–${T.l}${T.tie ? `–${T.tie}` : ""}`;

function contendWhy(me, T, target, best, partnerAfter) {
  const replaced = me.starters.find(p => !best.after.starters.some(q => q.id === p.id));
  const youth = best.give.filter(x => x.pick || (x.a != null && x.a <= 25));
  let s = `${target.n} would go straight into your lineup${replaced ? ` in place of ${replaced.n}` : ""}, worth about ${best.g.toFixed(1)} more points a week. `;
  s += T.dir === "rebuild"
    ? `${T.name} is ${recText(T)} and out of the race, so `
    : `${T.name} is ${recText(T)} and on the bubble, so `;
  s += youth.length ? `${names(youth)} ${youth.length > 1 ? "fit" : "fits"} their timeline better than a ${target.a ? Math.floor(target.a) + "-year-old " : ""}${target.p}.` : `they turn one asset into depth.`;
  return s;
}

function rebuildWhy(me, T, X, best, tGain) {
  const drop = 1 - project(X, 1) / X.v;
  let s = `${X.n} is ${Math.floor(X.a)}, at the age when ${X.p}s usually lose value fast, about ${Math.round(drop * 100)}% by next season on the age curve. `;
  s += `${T.name} is ${recText(T)} and would start him, adding about ${tGain.toFixed(1)} points a week to their lineup. `;
  const young = best.give.filter(x => !x.pick);
  const pk = best.give.filter(x => x.pick);
  s += `You get ${[young.length ? names(young) + (young.length === 1 && young[0].a ? ` (${Math.floor(young[0].a)})` : "") : "", pk.length ? names(pk) : ""].filter(Boolean).join(" plus ")}, which should hold value through your rebuild.`;
  return s;
}
