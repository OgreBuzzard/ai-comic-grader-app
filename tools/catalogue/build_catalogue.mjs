#!/usr/bin/env node
// Build catalogue_data.json from an export. Opt-in only, PII stripped.
// Usage: node tools/catalogue/build_catalogue.mjs <export.json> [out.json]
import fs from 'node:fs';
const inp=process.argv[2], out=process.argv[3]||'tools/catalogue/catalogue_data.json';
if(!inp){console.error('need export path');process.exit(1);}
const d=JSON.parse(fs.readFileSync(inp,'utf8'));
const urls=a=>(a||[]).filter(Boolean).map(x=>x.url||x);
const rows=d.items.filter(x=>x.type!=='card' && x._trainingOptIn).map(x=>({
  id:x.id, title:x.title||'', issue:String(x.issue||''), publisher:x.publisher||'',
  issueDate:x.issueDate||'', printing:x.printing||'',
  predicted:x.predictedGrade??null, cgc:x.assessedCGCGrade??null, slabbed:!!x.labelDetected,
  rg:(x.roboGrade&&x.roboGrade.score)??null, subs:(x.roboGrade&&x.roboGrade.subscores)||null,
  pq:x.pageQuality||'', deep:!!(x.deepAssessmentRan||x.highGradeTier), full:!!x.fullAssessmentRan,
  notes:x.aiAssessment||'', date:x.roboGradeDate||x.dateAdded||'',
  images:urls(x.images), corners:urls(x.cornerImages), interior:urls(x.interiorImages)
}));
fs.writeFileSync(out, JSON.stringify(rows));
console.log(`wrote ${out}: ${rows.length} comics`);
