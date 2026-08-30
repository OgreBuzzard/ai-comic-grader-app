#!/usr/bin/env node
// tools/resolution_eval.mjs — Image-resolution A/B eval for Robograder.
// Calls the REAL /api/assess grading path (production prompt + model), varying
// ONLY the Main-image long-edge resolution, and reports whether dropping from
// 1400 -> 1200 px changes grades or drops defect detection.
//
// It is stateless: assess.js grades and returns JSON; it does NOT charge a
// credit or write the item doc (those are client-side), so this pollutes
// nothing except a benign assessment_timings log row per call.
//
// USAGE (run from repo root):
//   ID_TOKEN="<your firebase ID token>" node tools/resolution_eval.mjs \
//     --export /path/to/robograder-export-2026-08-28.json \
//     --set tools/resolution_test_set.csv \
//     --res 1400,1200 --base https://robograder.app \
//     --tiers raw-drift,raw-gt-anchor --limit 20 --repeats 1 --suppressRef \
//     --out tools/resolution_eval_report.csv
//
// Get ID_TOKEN: sign in to the app as the admin account, then in the browser
// console run:  await firebase.auth().currentUser.getIdToken()  (or your app's
// equivalent) and paste the string. Tokens expire ~1h; re-grab if you get 401.
//
// Requires: Node 18+ (global fetch) and `sharp` (npm i sharp).

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// ---- args ----
const A = Object.fromEntries(process.argv.slice(2).reduce((a,x,i,arr)=>{
  if (x.startsWith('--')) a.push([x.slice(2), (arr[i+1]&&!arr[i+1].startsWith('--'))?arr[i+1]:true]);
  return a;
},[]));
const EXPORT = A.export;
const SET    = A.set;
const RES    = String(A.res||'1400,1200').split(',').map(n=>parseInt(n,10));
const BASE   = (A.base||'https://robograder.app').replace(/\/$/,'');
const TIERS  = A.tiers ? String(A.tiers).split(',') : null;   // null = all tiers
const LIMIT  = A.limit ? parseInt(A.limit,10) : Infinity;
const REPEATS= A.repeats ? parseInt(A.repeats,10) : 1;
const SUPPRESS_REF = !!A.suppressRef;
const OUT    = A.out || 'resolution_eval_report.csv';
const THROTTLE_MS = A.throttle ? parseInt(A.throttle,10) : 2000;
const MINGRADE = A.minGrade!=null ? parseFloat(A.minGrade) : null;   // filter picks by robograde
const TOKEN  = process.env.ID_TOKEN;
if (!EXPORT || !SET) { console.error('Need --export and --set. See header for usage.'); process.exit(1); }
if (!TOKEN) { console.error('Set ID_TOKEN env var to a Firebase ID token for an admin account.'); process.exit(1); }

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const RETRYABLE = /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|network|socket|terminated|transient|502|503|504|429/i;

// ---- load export + test set ----
const exp = JSON.parse(fs.readFileSync(EXPORT,'utf8'));
const byId = new Map(exp.items.map(it => [it.id, it]));
const csv = fs.readFileSync(SET,'utf8').trim().split(/\r?\n/);
const hdr = csv[0].split(',');
const rows = csv.slice(1).map(line=>{
  // simple CSV (no embedded commas in our fields except titles — split on first N)
  const parts = line.split(',');
  const o={}; hdr.forEach((h,i)=>o[h]=parts[i]); return o;
});
let picks = rows.filter(r => byId.has(r.id));
if (TIERS) picks = picks.filter(r => TIERS.includes(r.tier));
if (MINGRADE!=null) picks = picks.filter(r => parseFloat(r.robograde) >= MINGRADE);
picks = picks.slice(0, LIMIT);
console.log(`Books to run: ${picks.length}  |  resolutions: ${RES.join(', ')}  |  repeats: ${REPEATS}  |  suppressReference: ${SUPPRESS_REF}`);
console.log(`Estimated Opus calls: ${picks.length*RES.length*REPEATS}  (~$${(picks.length*RES.length*REPEATS*0.12).toFixed(2)} at ~$0.12/call)\n`);

// ---- helpers ----
async function fetchImage(url){
  let last;
  for (let a=0;a<4;a++){
    try{
      const r = await fetch(url, { keepalive:false });
      if (!r.ok){ if(r.status>=500||r.status===429) throw new Error('transient '+r.status); throw new Error(`img ${r.status}`); }
      return Buffer.from(await r.arrayBuffer());
    }catch(e){ last=e; if(a<3 && RETRYABLE.test(e.message)){ await sleep(700*(a+1)); continue; } throw e; }
  }
  throw last;
}
async function toDataUrl(buf, maxEdge){
  const out = await sharp(buf).rotate() // bake EXIF orientation, then strip it
    .resize({ width:maxEdge, height:maxEdge, fit:'inside', withoutEnlargement:true })
    .jpeg({ quality:90 }).toBuffer();
  return { dataUrl: 'data:image/jpeg;base64,'+out.toString('base64'), bytes: out.length };
}
function yearOf(it){ const m=String(it.issueDate||'').match(/\b(18|19|20)\d{2}\b/); return m?parseInt(m[0],10):null; }
function slots(n){ return { front:n>=1, back:n>=2, interior:n>=3, raking:n>=4 }; }
function gradeOf(p){
  const g = p && (p.predictedGrade ?? p.grade ?? p.assessedCGCGrade);
  const n = parseFloat(g); return Number.isFinite(n)?n:null;
}
function rgOf(p){ const s=p&&p.roboGrade&&p.roboGrade.score; return typeof s==='number'?s:null; }
function defectsOf(p){ return Array.isArray(p&&p.defects)?p.defects.length:(Array.isArray(p&&p.roboGrade&&p.roboGrade.defects)?p.roboGrade.defects.length:null); }

async function assess(images, it){
  const body = {
    images, slotsFilled: slots(images.length), grader:'CGC',
    title: it.title||'', issueNumber: String(it.issue||''),
    issueYear: yearOf(it), issueDate: it.issueDate||'',
    highGrade:false, suppressReference: SUPPRESS_REF
  };
  let last;
  for (let a=0;a<3;a++){
    try{
      const r = await fetch(BASE+'/api/assess', {
        method:'POST', keepalive:false,
        signal: AbortSignal.timeout(150000),
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+TOKEN },
        body: JSON.stringify(body)
      });
      const text = await r.text();
      if (!r.ok){ if(r.status===429||r.status>=500) throw new Error('transient '+r.status+': '+text.slice(0,120)); throw new Error(`assess ${r.status}: ${text.slice(0,180)}`); }
      try { return JSON.parse(text); } catch { throw new Error('unparseable response: '+text.slice(0,180)); }
    }catch(e){ last=e; if(a<2 && RETRYABLE.test(e.message)){ console.log(`    retry assess (${a+1}/3): ${e.message.slice(0,80)}`); await sleep(2000*(a+1)); continue; } throw e; }
  }
  throw last;
}

// ---- run ----
const results=[]; let firstDump=false;
for (const pk of picks){
  const it = byId.get(pk.id);
  const urls = (it.images||[]).filter(Boolean).map(x=>x.url||x).slice(0,8);
  let bufs;
  try { bufs = await Promise.all(urls.map(fetchImage)); }
  catch(e){ console.log(`  ! ${pk.id} image fetch failed: ${e.message}`); continue; }
  const row = { id:pk.id, tier:pk.tier, title:it.title, issue:it.issue, truth:pk.ground_truth||'' };
  const nums=a=>a.filter(x=>x!=null);
  const avg=a=>{const v=nums(a);return v.length?v.reduce((s,x)=>s+x,0)/v.length:null;};
  const spread=a=>{const v=nums(a);return v.length>1?+(Math.max(...v)-Math.min(...v)).toFixed(2):0;};
  for (let idx=0; idx<RES.length; idx++){
    const res=RES[idx];
    const imgs = await Promise.all(bufs.map(b=>toDataUrl(b,res).then(o=>o.dataUrl)));
    const grades=[], rgs=[], defs=[];
    for (let k=0;k<REPEATS;k++){
      try {
        const p = await assess(imgs, it);
        if(!firstDump){ try{ fs.writeFileSync('_sample_response.json', JSON.stringify(p,null,2)); console.log('  (wrote _sample_response.json — check field names if grades read as ?)'); }catch(_e){} firstDump=true; }
        grades.push(gradeOf(p)); rgs.push(rgOf(p)); defs.push(defectsOf(p));
      } catch(e){ console.log(`  ! ${pk.id} @${res}#${idx} run${k}: ${e.message}`); grades.push(null); }
      await sleep(THROTTLE_MS);
    }
    // index-based keys so a same-resolution control (1400 vs 1400) doesn't collide
    row['grade_'+idx]=avg(grades); row['gspread_'+idx]=spread(grades);
    row['rg_'+idx]=avg(rgs); row['defects_'+idx]=avg(defs); row['dspread_'+idx]=spread(defs);
  }
  const g1=row['grade_0'], g2=row['grade_1'];
  row.grade_delta = (g1!=null&&g2!=null)?+(g2-g1).toFixed(2):'';
  const d1=row['defects_0'], d2=row['defects_1'];
  row.defect_delta = (d1!=null&&d2!=null)?+(d2-d1).toFixed(2):'';
  results.push(row);
  const sp = REPEATS>1 ? ` (self±${row['gspread_0']}/${row['gspread_1']})` : '';
  console.log(`  ${pk.id.padEnd(42)} ${RES[0]}#0=${g1??'?'}  ${RES[1]}#1=${g2??'?'}  Δ=${row.grade_delta}  defΔ=${row.defect_delta}${sp}`);
}

// ---- report ----
const cols=['id','tier','title','issue','truth',...RES.flatMap((r,i)=>['grade_'+i,'gspread_'+i,'rg_'+i,'defects_'+i,'dspread_'+i]),'grade_delta','defect_delta'];
const esc=v=>{ v=(v==null?'':String(v)); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
fs.writeFileSync(OUT, [cols.join(','), ...results.map(r=>cols.map(c=>esc(r[c])).join(','))].join('\n'));

// ---- aggregate ----
const withBoth = results.filter(r=>r['grade_0']!=null && r['grade_1']!=null);
const mean=a=>{a=a.filter(x=>x!=null&&!Number.isNaN(x));return a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;};
const deltas = withBoth.map(r=>r['grade_1']-r['grade_0']);
const absd = deltas.map(Math.abs);
const defd = withBoth.map(r=>(r['defects_1']??0)-(r['defects_0']??0));
const isControl = RES[0]===RES[1];
const noiseG = mean([].concat(...withBoth.map(r=>[r['gspread_0'],r['gspread_1']])));   // within-res spread (needs --repeats>1)
const noiseD = mean([].concat(...withBoth.map(r=>[r['dspread_0'],r['dspread_1']])));
console.log(`\n===== AGGREGATE (${withBoth.length} books)${isControl?'  [CONTROL: '+RES[0]+' vs '+RES[0]+' — this IS the noise floor]':''} =====`);
console.log(`Mean signed grade delta (#1 - #0):        ${mean(deltas).toFixed(3)}   (− = res #1 grades lower)`);
console.log(`Mean |grade delta|:                       ${mean(absd).toFixed(3)}`);
console.log(`Books where the grade changed:            ${deltas.filter(d=>Math.abs(d)>=0.01).length}/${withBoth.length}`);
console.log(`Mean defect-count delta (#1 - #0):        ${mean(defd).toFixed(3)}   (− = res #1 found FEWER defects)`);
if (REPEATS>1){
  console.log(`\n-- noise floor from --repeats (within-resolution self-variance) --`);
  console.log(`Mean within-res grade spread:             ${noiseG.toFixed(3)}   <- compare to |grade delta| above`);
  console.log(`Mean within-res defect spread:            ${noiseD.toFixed(3)}   <- compare to |defect delta| above`);
  console.log(mean(absd) > noiseG*1.5 ? `VERDICT: grade delta EXCEEDS self-noise — resolution has a real effect.` : `VERDICT: grade delta within self-noise — no detectable resolution effect.`);
} else if (isControl){
  console.log(`\nThis run's deltas ARE the noise floor. Compare them to your 1400-vs-1200 run:`);
  console.log(`if 1200-vs-1400 looks like this, the resolution change is indistinguishable from noise.`);
} else {
  console.log(`\nNOTE: 1 repeat, so these deltas conflate resolution + model self-noise.`);
  console.log(`Run a control ( --res 1400,1400 ) or --repeats 3 to separate the two.`);
}
const gt = withBoth.filter(r=>parseFloat(r.truth));
if (gt.length && !isControl){
  const e1=mean(gt.map(r=>Math.abs(r['grade_0']-parseFloat(r.truth))));
  const e2=mean(gt.map(r=>Math.abs(r['grade_1']-parseFloat(r.truth))));
  console.log(`\nGround-truth subset (${gt.length}, grain of salt): mean |err| #0=${e1.toFixed(3)}  #1=${e2.toFixed(3)}  (${e2>e1?'#1 WORSE':'#1 not worse'})`);
}
console.log(`\nReport: ${OUT}`);
