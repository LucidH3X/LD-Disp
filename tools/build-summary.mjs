// tools/build-summary.mjs
// Builds docs/data/summary.json with top ISK + top Solo (ESI-prioritized for solo).
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

async function readJSON(p) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } }
async function writeJSON(p, obj) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }

const CFG_DEFAULT = {
  title: "TEST Alliance – Deployment Tracker",
  allianceID: 498125261,
  goalISK: 500_000_000_000,
  regionID: 10000035,
  regionName: "Deklein",
  from: "2025-09-01",
  rateMs: 400,
  pageCap: 50,
  esiRateMs: 250,
  esiCap: 150,        // general ESI cap (for non-solo pages)
  esiCapSolo: 3000,   // BIGGER cap just for solo pages (prioritized)
};

async function loadCfg() {
  const a = await readJSON(path.join(repoRoot, "docs", "site.json"));
  const b = await readJSON(path.join(repoRoot, "site.json"));
  return { ...CFG_DEFAULT, ...(a || b || {}) };
}

function monthList(from, to) {
  const out = [];
  const A = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const B = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (A <= B) { out.push({ y: A.getUTCFullYear(), m: A.getUTCMonth() + 1 }); A.setUTCMonth(A.getUTCMonth() + 1); }
  return out;
}
const parseKillTime = (s) => { const raw = String(s || ""); const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + (raw.endsWith("Z") ? "" : "Z"); const t = new Date(iso); return isNaN(t) ? null : t; };

function ua() { const repo = process.env.GITHUB_REPOSITORY || "LucidH3X/LD-Disp"; return `LD-Disp snapshot (+https://github.com/${repo})`; }

async function zkb(pathPart) {
  const r = await fetch(`https://zkillboard.com/api${pathPart}`, { headers: { "User-Agent": ua(), "Accept": "application/json" }, cache: "no-store" });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}
async function esiKillmail(id, hash) {
  if (!id || !hash) return null;
  const r = await fetch(`https://esi.evetech.net/latest/killmails/${id}/${hash}/?datasource=tranquility`, { headers: { "User-Agent": ua() } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j ? { attackers: Array.isArray(j.attackers) ? j.attackers : [] } : null;
}
async function esiNames(ids) {
  if (!ids.length) return [];
  const r = await fetch("https://esi.evetech.net/latest/universe/names/?datasource=tranquility", {
    method: "POST",
    headers: { "User-Agent": ua(), "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify(ids)
  });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

function countTo(map, id, by = 1) { map.set(id, (map.get(id) || 0) + by); }
function extractTesters(src, allianceID) { const atks = src?.attackers || []; return atks.filter(a => a?.character_id && !a.is_npc && a.alliance_id === allianceID).map(a => a.character_id); }
function isSoloByTest(src, allianceID) { const atks = src?.attackers || []; const nonNpc = atks.filter(a => a?.character_id && !a.is_npc); const solo = (nonNpc.length === 1 && nonNpc[0].alliance_id === allianceID) ? nonNpc[0] : null; return solo ? solo.character_id : null; }

async function main() {
  const CFG = await loadCfg();
  const startDate = CFG.from ? new Date(`${CFG.from}T00:00:00Z`) : null;
  const now = new Date();

  let totalISK = 0, totalShips = 0;
  const iskByPilot = new Map();
  const soloByPilot = new Map();
  const nameIds = new Set();

  let esiCallsGeneral = 0;
  let esiCallsSolo = 0;

  const months = monthList(startDate || now, now);

  for (const { y, m } of months) {
    // ------- KILLS -------
    for (let page = 1; page <= (CFG.pageCap || 1000); page++) {
      const pathKills = `/kills/allianceID/${CFG.allianceID}/regionID/${CFG.regionID}/year/${Number(y)}/month/${Number(m)}/page/${page}/`;
      const rows = await zkb(pathKills);
      if (!rows.length) break;

      for (const row of rows) {
        const t = parseKillTime(row.killmail_time);
        if (startDate && t && t < startDate) continue;

        const value = row?.zkb?.totalValue || 0;
        totalISK += value; totalShips += 1;

        let src = row;
        if (!Array.isArray(row.attackers) || row.attackers.length === 0) {
          if (esiCallsGeneral < (CFG.esiCap ?? 0)) {
            const km = await esiKillmail(row.killmail_id, row?.zkb?.hash);
            if (km) src = km;
            esiCallsGeneral++;
            await sleep(CFG.esiRateMs || 0);
          }
        }

        const testers = extractTesters(src, CFG.allianceID);
        if (testers.length) { for (const id of testers) { countTo(iskByPilot, id, value); nameIds.add(id); } }
      }
      await sleep(CFG.rateMs || 0);
    }

    // ------- SOLO (ESI PRIORITY) -------
    for (let page = 1; page <= (CFG.pageCap || 1000); page++) {
      const pathSolo = `/kills/solo/allianceID/${CFG.allianceID}/regionID/${CFG.regionID}/year/${Number(y)}/month/${Number(m)}/page/${page}/`;
      const rows = await zkb(pathSolo);
      if (!rows.length) break;

      for (const row of rows) {
        const t = parseKillTime(row.killmail_time);
        if (startDate && t && t < startDate) continue;

        // Always try to get attackers for solo, using a larger dedicated cap
        let src = row;
        if (!Array.isArray(row.attackers) || row.attackers.length === 0) {
          if (esiCallsSolo < (CFG.esiCapSolo ?? 2000)) {
            const km = await esiKillmail(row.killmail_id, row?.zkb?.hash);
            if (km) src = km;
            esiCallsSolo++;
            await sleep(CFG.esiRateMs || 0);
          }
        }

        const soloId = isSoloByTest(src, CFG.allianceID);
        if (soloId) { countTo(soloByPilot, soloId, 1); nameIds.add(soloId); }
      }
      await sleep(CFG.rateMs || 0);
    }
  }

  // Names (batched 900)
  const ids = [...nameIds].map(Number).filter(Boolean);
  const namesMap = {};
  for (let i = 0; i < ids.length; i += 900) {
    const slice = ids.slice(i, i + 900);
    const arr = await esiNames(slice);
    for (const r of arr) namesMap[r.id] = r.name;
    await sleep(120);
  }

  const topISK = [...iskByPilot.entries()].sort((a,b)=>b[1]-a[1]).slice(0,100).map(([id, isk]) => ({ id: Number(id), isk: Math.round(isk) }));
  const topSolo = [...soloByPilot.entries()].sort((a,b)=>b[1]-a[1]).slice(0,100).map(([id, count]) => ({ id: Number(id), count: Number(count) }));

  const summary = {
    generatedAt: nowISO(),
    totals: { isk: Math.round(totalISK), ships: totalShips, goalPct: CFG.goalISK ? (totalISK/CFG.goalISK)*100 : 0 },
    topISK, topSolo, names: namesMap
  };

  await writeJSON(path.join(repoRoot, "data", "summary.json"), summary);
  await writeJSON(path.join(repoRoot, "docs", "data", "summary.json"), summary);

  console.log(`Snapshot ok. ISK=${summary.totals.isk} ships=${summary.totals.ships} topSolo=${topSolo.length} topISK=${topISK.length} ESI(gen/solo)=${esiCallsGeneral}/${esiCallsSolo}`);
}

main().catch(async (e) => {
  console.error("Builder failed:", e);
  const fallback = { generatedAt: nowISO(), totals:{ isk:0, ships:0, goalPct:0 }, topISK:[], topSolo:[], names:{} };
  await writeJSON(path.join(repoRoot, "docs", "data", "summary.json"), fallback);
  process.exitCode = 1;
});
