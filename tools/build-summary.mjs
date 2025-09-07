// tools/build-summary.mjs
// Node 20+. No deps. Runs in GitHub Actions (or locally).
import fs from "node:fs/promises";

// --------- tiny utils ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => new Intl.NumberFormat().format(n);

// --------- config (from site.json) ----------
const defaults = {
  title: "TEST Alliance – Deployment Tracker",
  allianceID: 498125261,
  regionID: 10000035,    // Deklein
  goalISK: 500_000_000_000,
  from: "2025-09-01",
  rateMs: 400,           // zKB throttle
  pageCap: 10,           // pages per month
  esiRateMs: 200,        // ESI throttle
  esiCap: 500            // safety ceiling on ESI calls per run
};
let CFG = defaults;
try {
  const raw = await fs.readFile("./site.json", "utf8");
  CFG = { ...CFG, ...JSON.parse(raw) };
} catch {}

// --------- time helpers ----------
const startDate = CFG.from ? new Date(`${CFG.from}T00:00:00Z`) : null;
function monthList(fromDate, toDate) {
  const out = [];
  const a = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
  const b = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), 1));
  while (a <= b) { out.push({ y: a.getUTCFullYear(), m: a.getUTCMonth() + 1 }); a.setUTCMonth(a.getUTCMonth() + 1); }
  return out;
}
function parseKillTime(s) {
  const raw = String(s || "");
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + (raw.endsWith("Z") ? "" : "Z");
  const t = new Date(iso);
  return isNaN(t) ? null : t;
}

// --------- HTTP helpers ----------
async function getJSON(url, retry = 2) {
  for (let i = 0; i <= retry; i++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "LD-DISP/1.0 (GitHub Actions)", "Accept": "application/json" },
        cache: "no-store"
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === retry) throw e;
      await sleep(500 + i * 500);
    }
  }
}

let esiCalls = 0;
async function getESIKillmail(id, hash) {
  if (esiCalls >= CFG.esiCap) return null;
  const url = `https://esi.evetech.net/latest/killmails/${id}/${hash}/?datasource=tranquility`;
  try {
    const km = await getJSON(url);
    esiCalls++;
    await sleep(CFG.esiRateMs);
    return km;
  } catch {
    return null;
  }
}

async function resolveNames(idSet) {
  const ids = [...idSet].map(Number).filter(Boolean);
  const names = new Map();
  for (let i = 0; i < ids.length; i += 900) {
    const slice = ids.slice(i, i + 900);
    const url = "https://esi.evetech.net/latest/universe/names/?datasource=tranquility";
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(slice)
      });
      const arr = await r.json();
      for (const x of arr) names.set(x.id, x.name);
      await sleep(100);
    } catch {}
  }
  return names;
}

// --------- aggregation ----------
const zkbBase = "https://zkillboard.com/api";
const pagesTouched = { zkb: 0 };

const countTo = (map, id, by = 1) => map.set(id, (map.get(id) || 0) + by);

function testersFromAttackers(atks) {
  return (atks || [])
    .filter(a => a.character_id && !a.is_npc && a.alliance_id === CFG.allianceID)
    .map(a => a.character_id);
}
function soloIdFromAttackers(atks) {
  const nonNpc = (atks || []).filter(a => a.character_id && !a.is_npc);
  return (nonNpc.length === 1 && nonNpc[0].alliance_id === CFG.allianceID) ? nonNpc[0].character_id : null;
}

let totalISK = 0, totalShips = 0;
const iskByPilot = new Map();
const soloByPilot = new Map();
const nameIds = new Set();

async function consumeRows(rows, mode) {
  for (const row of rows) {
    const t = parseKillTime(row.killmail_time);
    if (startDate && t && t < startDate) continue;

    if (mode === "kills") {
      const value = row?.zkb?.totalValue || 0;
      totalISK += value; totalShips += 1;

      let attackers = row.attackers;
      if (!Array.isArray(attackers) || attackers.length === 0) {
        const km = await getESIKillmail(row.killmail_id, row?.zkb?.hash);
        attackers = km?.attackers || [];
      }
      const testers = testersFromAttackers(attackers);
      for (const id of testers) { countTo(iskByPilot, id, value); nameIds.add(id); }
    }

    if (mode === "solo") {
      let attackers = row.attackers;
      if (!Array.isArray(attackers) || attackers.length === 0) {
        const km = await getESIKillmail(row.killmail_id, row?.zkb?.hash);
        attackers = km?.attackers || [];
      }
      const id = soloIdFromAttackers(attackers);
      if (id) { countTo(soloByPilot, id, 1); nameIds.add(id); }
    }
  }
}

async function fetchMonth(y, m) {
  // kills
  for (let page = 1; ; page++) {
    if (CFG.pageCap && page > CFG.pageCap) break;
    const url = `${zkbBase}/kills/allianceID/${CFG.allianceID}/regionID/${CFG.regionID}/year/${y}/month/${m}/page/${page}/?_=${Date.now()}`;
    const data = await getJSON(url).catch(() => []);
    pagesTouched.zkb++;
    if (!Array.isArray(data) || data.length === 0) break;
    await consumeRows(data, "kills");
    await sleep(CFG.rateMs);
  }
  // solo
  for (let page = 1; ; page++) {
    if (CFG.pageCap && page > CFG.pageCap) break;
    const url = `${zkbBase}/kills/solo/allianceID/${CFG.allianceID}/regionID/${CFG.regionID}/year/${y}/month/${m}/page/${page}/?_=${Date.now()}`;
    const data = await getJSON(url).catch(() => []);
    pagesTouched.zkb++;
    if (!Array.isArray(data) || data.length === 0) break;
    await consumeRows(data, "solo");
    await sleep(CFG.rateMs);
  }
}

// --------- run ----------
const months = monthList(startDate || new Date(), new Date());
for (const { y, m } of months) {
  console.log(`month ${y}-${m}…`);
  await fetchMonth(y, m);
}

console.log(`Totals: ISK=${fmt(totalISK)} | ships=${fmt(totalShips)} | pages=${pagesTouched.zkb} | ESI=${esiCalls}`);

const names = await resolveNames(nameIds);
const topISK  = [...iskByPilot.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 25).map(([id, isk]) => ({ id: Number(id), isk: Math.round(isk) }));
const topSolo = [...soloByPilot.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 25).map(([id, count]) => ({ id: Number(id), count }));

const summary = {
  generatedAt: new Date().toISOString(),
  from: CFG.from, to: "now",
  allianceID: CFG.allianceID, regionID: CFG.regionID, goalISK: CFG.goalISK,
  totals: { isk: Math.round(totalISK), ships: totalShips, goalPct: Number(((totalISK / CFG.goalISK) * 100).toFixed(2)) },
  topISK, topSolo,
  names: Object.fromEntries([...names.entries()].map(([id,n]) => [String(id), n]))
};

await fs.mkdir("data", { recursive: true });
await fs.writeFile("data/summary.json", JSON.stringify(summary, null, 2));
console.log(`Wrote data/summary.json`);
