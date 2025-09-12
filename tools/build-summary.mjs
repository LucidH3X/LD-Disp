// tools/build-summary.mjs
// Strict window from CFG.from (inclusive), TEST-only counts, no early-stop, ESI fallback.
// Per-pilot ISK credit via CFG.credit. Totals metric via CFG.totalMetric.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, "..");

const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

async function readJSON(p){ try{ return JSON.parse(await fs.readFile(p,"utf8")); }catch{ return null; } }
async function writeJSON(p, obj){ await fs.mkdir(path.dirname(p), {recursive:true}); await fs.writeFile(p, JSON.stringify(obj, null, 2)+"\n", "utf8"); }

const CFG_DEFAULT = {
  title: "TEST Alliance – Deployment Tracker",
  allianceID: 498125261,
  goalISK: 500_000_000_000,
  regionID: 10000014,
  regionName: "Catch",
  from: "2025-09-12",
  rateMs: 250,
  pageCap: 150,
  esiRateMs: 180,
  esiCap: 4000,
  credit: "all",
  totalMetric: "destroyedValue",
  excludeAwox: true,
  excludeNPC: true,
  minTotalISK: 0,
  includeSoloOnly: false,
  userAgent: null
};

async function loadCfg() {
  const a = await readJSON(path.join(repoRoot, "docs", "site.json"));
  return { ...CFG_DEFAULT, ...(a || {}) };
}

function monthList(from, to){
  const out=[]; const A=new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const B=new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (A<=B){ out.push({ y:A.getUTCFullYear(), m:A.getUTCMonth()+1 }); A.setUTCMonth(A.getUTCMonth()+1); }
  return out;
}
const parseKillTime = (s) => {
  const raw = String(s || "");
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + (raw.endsWith("Z") ? "" : "Z");
  const t = new Date(iso);
  return isNaN(t) ? null : t;
};

function ua(CFG){
  if (CFG.userAgent) return CFG.userAgent;
  const repo = process.env.GITHUB_REPOSITORY || "LucidH3X/LD-Disp";
  return `LD-Disp snapshot (+https://github.com/${repo})`;
}

async function zkb(pathPart, CFG){
  const url = `https://zkillboard.com/api${pathPart}`;
  const r = await fetch(url, { headers: { "User-Agent": ua(CFG), "Accept": "application/json" }, cache: "no-store" });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}
async function esiKillmail(id, hash, CFG){
  if (!id || !hash) return null;
  const url = `https://esi.evetech.net/latest/killmails/${id}/${hash}/?datasource=tranquility`;
  const r = await fetch(url, { headers: { "User-Agent": ua(CFG) } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j || null;
}
async function esiNames(ids, CFG){
  if (!ids.length) return [];
  const url = "https://esi.evetech.net/latest/universe/names/?datasource=tranquility";
  const r = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": ua(CFG), "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify(ids)
  });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

function countTo(m, id, by=1){ m.set(id, (m.get(id)||0)+by); }
const nonNpc = (atks) => (atks||[]).filter(a => a && a.character_id && !a.is_npc);
function testersAll(src, aid){
  const atks = src?.attackers || [];
  return atks.filter(a => a?.character_id && !a.is_npc && a.alliance_id === aid).map(a => a.character_id);
}
function testerFinal(src, aid){
  const atks = src?.attackers || [];
  const fb = atks.find(a =>
    (a.final_blow === true || a.final_blow === 1 || a.finalBlow === 1) &&
    a.character_id && !a.is_npc && a.alliance_id === aid
  );
  return fb ? [fb.character_id] : [];
}
function soloByAlliance(src, aid){
  const nn = nonNpc(src?.attackers);
  if (nn.length !== 1) return null;
  return nn[0].alliance_id === aid ? nn[0].character_id : null;
}

async function main(){
  const CFG = await loadCfg();
  const startDate = CFG.from ? new Date(`${CFG.from}T00:00:00Z`) : null;
  const credit    = (CFG.credit || "all").toLowerCase();
  const metricKey = (CFG.totalMetric || "destroyedValue");

  const now = new Date();
  const months = monthList(startDate || now, now);
  const regions = CFG.regionID ? [Number(CFG.regionID)]
                : (Array.isArray(CFG.regions) && CFG.regions.length ? CFG.regions.map(r=>Number(r.id)) : [null]);

  let totalISK=0, totalShips=0, esiCalls=0;
  const iskByPilot = new Map();
  const soloByPilot= new Map();
  const nameIds    = new Set();
  let earliestCounted = null;

  // debug
  let pages=0, rowsSeen=0, rowsOlder=0, rowsNoTest=0, rowsFiltered=0, rowsCounted=0;

  for (const {y, m} of months){
    for (const rid of regions){
      for (let page=1; page <= (CFG.pageCap || 1000); page++){
        const killsPath =
          `/kills/allianceID/${CFG.allianceID}` +
          (rid ? `/regionID/${rid}` : "") +
          `/year/${Number(y)}/month/${Number(m)}/page/${page}/`;

        const rows = await zkb(killsPath, CFG);
        pages++;
        if (!rows.length) break;

        for (const row of rows){
          rowsSeen++;

          let src = row;
          const needESI = !row.killmail_time || !Array.isArray(row.attackers) || row.attackers.length === 0;
          if (needESI && esiCalls < (CFG.esiCap ?? 0)){
            const km = await esiKillmail(row.killmail_id, row?.zkb?.hash, CFG);
            if (km) src = { ...row, ...km };
            esiCalls++;
            await sleep(CFG.esiRateMs || 0);
          }

          const t = parseKillTime(src.killmail_time);
          if (startDate && t && t < startDate){ rowsOlder++; continue; }
          if (!t) continue;

          const testersAny = testersAll(src, CFG.allianceID);
          if (testersAny.length === 0){ rowsNoTest++; continue; }

          const zk = row?.zkb || {};
          if ((CFG.excludeAwox ?? true) && zk.awox) { rowsFiltered++; continue; }
          if ((CFG.excludeNPC  ?? true) && zk.npc)  { rowsFiltered++; continue; }
          if ((CFG.includeSoloOnly ?? false) && !soloByAlliance(src, CFG.allianceID)) { rowsFiltered++; continue; }

          const value = Number(zk?.[metricKey] ?? zk?.totalValue ?? 0);
          if (value < (CFG.minTotalISK ?? 0)) { rowsFiltered++; continue; }

          if (!earliestCounted || t < earliestCounted) earliestCounted = t;

          totalISK  += value;        // count kill ONCE in totals
          totalShips += 1;
          rowsCounted++;

          const creditIds = credit === "final" ? testerFinal(src, CFG.allianceID) : testersAny;
          for (const id of creditIds){ countTo(iskByPilot, id, value); nameIds.add(id); }

          const soloId = soloByAlliance(src, CFG.allianceID);
          if (soloId){ countTo(soloByPilot, soloId, 1); nameIds.add(soloId); }
        }

        await sleep(CFG.rateMs || 0);
      }
    }
  }

  // names
  const ids = [...nameIds].map(Number).filter(Boolean);
  const namesMap = {};
  for (let i=0; i<ids.length; i+=900){
    const slice = ids.slice(i, i+900);
    const arr   = await esiNames(slice, CFG);
    for (const r of arr) namesMap[r.id] = r.name;
    await sleep(120);
  }

  const topISK  = [...iskByPilot.entries()].sort((a,b)=>b[1]-a[1]).slice(0,100)
                    .map(([id,isk])=>({id:Number(id), isk:Math.round(isk)}));
  const topSolo = [...soloByPilot.entries()].sort((a,b)=>b[1]-a[1]).slice(0,100)
                    .map(([id,c])   =>({id:Number(id), count:Number(c)}));

  const summary = {
    generatedAt: nowISO(),
    since: CFG.from,
    earliestCountedAt: earliestCounted ? earliestCounted.toISOString() : null,
    creditMode: credit,
    totalMetric: metricKey,
    debug: { pages, rowsSeen, rowsOlder, rowsNoTest, rowsFiltered, rowsCounted, esiCalls },
    totals: { isk: Math.round(totalISK), ships: totalShips, goalPct: CFG.goalISK ? (totalISK/CFG.goalISK)*100 : 0 },
    topISK, topSolo, names: namesMap
  };

  await writeJSON(path.join(repoRoot, "data", "summary.json"), summary);
  await writeJSON(path.join(repoRoot, "docs", "data", "summary.json"), summary);

  console.log(`Snapshot ok. metric=${metricKey} since=${CFG.from} earliest=${summary.earliestCountedAt} pages=${pages} seen=${rowsSeen} older=${rowsOlder} noTest=${rowsNoTest} filtered=${rowsFiltered} counted=${rowsCounted} ESI=${esiCalls}`);
}

main().catch(async e=>{
  console.error("Builder failed:", e);
  const fallback = { generatedAt: nowISO(), since: null, earliestCountedAt: null, creditMode: null, totalMetric: null, debug:{}, totals:{isk:0,ships:0,goalPct:0}, topISK:[], topSolo:[], names:{} };
  await writeJSON(path.join(repoRoot, "docs", "data", "summary.json"), fallback);
  process.exitCode = 1;
});


