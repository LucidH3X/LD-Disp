// tools/build-summary.mjs
// Strict "from" window; never counts mails before CFG.from.
// Reads ONLY docs/site.json to avoid config drift.

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

  from: "2025-09-12",   // STRICT START (UTC)

  rateMs: 300,
  pageCap: 100,

  esiRateMs: 200,
  esiCap: 2500,

  credit: "final",      // "final" or "all" (doesn't affect total ISK, only per-pilot)
  userAgent: null
};

async function loadCfg() {
  // IMPORTANT: read ONLY docs/site.json so UI + builder use the same values
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
  return j ? { attackers: Array.isArray(j.attackers) ? j.attackers : [] } : null;
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
  const now   = new Date();
  const months = monthList(startDate || now, now);
  const regions = CFG.regionID ? [Number(CFG.regionID)] :
                  (Array.isArray(CFG.regions) && CFG.regions.length ? CFG.regions.map(r=>Number(r.id)) : []);

  let totalISK=0, totalShips=0, esiCalls=0;
  const iskByPilot = new Map();
  const soloByPilot= new Map();
  const nameIds    = new Set();
  const credit = (CFG.credit || "all").toLowerCase();

  let earliestCounted = null;

  for (const {y, m} of months){
    const rids = regions.length ? regions : [null]; // null => all regions
    for (const rid of rids){
      let stopMonth = false; // stop this year/month once we hit a kill older than startDate
      for (let page=1; page <= (CFG.pageCap || 1000); page++){
        if (stopMonth) break;

        const killsPath =
          `/kills/allianceID/${CFG.allianceID}` +
          (rid ? `/regionID/${rid}` : "") +
          `/year/${Number(y)}/month/${Number(m)}/page/${page}/`;

        const rows = await zkb(killsPath, CFG);
        if (!rows.length) break;

        for (const row of rows){
          const t = parseKillTime(row.killmail_time);

          // STRICT filter: skip & mark month done if older than startDate
          if (startDate && t && t < startDate){ stopMonth = true; continue; }

          // defensive: if kill has no timestamp we ignore it
          if (!t) continue;

          if (!earliestCounted || t < earliestCounted) earliestCounted = t;

          // ---- ONLY AFTER TIME CHECK do we touch totals ----
          const value = row?.zkb?.totalValue || 0;
          totalISK  += value;
          totalShips += 1;

          // need attackers to credit ISK + detect solo
          let src = row;
          if (!Array.isArray(row.attackers) || row.attackers.length === 0){
            if (esiCalls < (CFG.esiCap ?? 0)){
              const km = await esiKillmail(row.killmail_id, row?.zkb?.hash, CFG);
              if (km) src = km;
              esiCalls++;
              await sleep(CFG.esiRateMs || 0);
            }
          }

          const ids = credit === "final" ? testerFinal(src, CFG.allianceID) : testersAll(src, CFG.allianceID);
          for (const id of ids){ countTo(iskByPilot, id, value); nameIds.add(id); }

          const soloId = soloByAlliance(src, CFG.allianceID);
          if (soloId){ countTo(soloByPilot, soloId, 1); nameIds.add(soloId); }
        }

        await sleep(CFG.rateMs || 0);
      }
    }
  }

  // Names
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
    since: CFG.from,                               // sanity breadcrumb
    earliestCountedAt: earliestCounted ? earliestCounted.toISOString() : null,
    creditMode: credit,
    totals: { isk: Math.round(totalISK), ships: totalShips, goalPct: CFG.goalISK ? (totalISK/CFG.goalISK)*100 : 0 },
    topISK, topSolo, names: namesMap
  };

  await writeJSON(path.join(repoRoot, "data", "summary.json"), summary);
  await writeJSON(path.join(repoRoot, "docs", "data", "summary.json"), summary);

  console.log(`Snapshot ok. since=${CFG.from} earliest=${summary.earliestCountedAt} ISK=${summary.totals.isk} ships=${summary.totals.ships}`);
}

main().catch(async e=>{
  console.error("Builder failed:", e);
  const fallback = { generatedAt: nowISO(), since: null, earliestCountedAt: null, creditMode: null, totals:{isk:0,ships:0,goalPct:0}, topISK:[], topSolo:[], names:{} };
  await writeJSON(path.join(repoRoot, "docs", "data", "summary.json"), fallback);
  process.exitCode = 1;
});


