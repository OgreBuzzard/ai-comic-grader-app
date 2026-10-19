import * as R from './lib/repeat_bonus.js';
const now = Date.now(), DAY = 86400000;
const buys = (spec) => { const all=[]; for (const [tier,count] of Object.entries(spec)) for (let i=0;i<count;i++) all.push(tier);
  const N=all.length; return all.map((tier,i)=>({tier, createdAtMs: now - (N-i)*7*DAY, environment:'Production'})); };
let fails=0;
const t=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w); if(!ok){fails++;console.log('FAIL',n,'got',JSON.stringify(g),'want',JSON.stringify(w));}else console.log('ok  ',n);};
const C = (spec,tier) => { const o=R.tierOffers(buys(spec),now)[tier]; return [o.credits, +o.perCredit.toFixed(3), o.unlockedByLowerTier]; };

console.log("--- MATT'S THREE CASES ---");
t('3 stacks -> next stack 8 @1.25', C({comic_stack:3},'comic_stack'), [8,1.25,false]);
t('3 stacks -> wall 24 @1.25 UNLOCKED', C({comic_stack:3},'comic_wall'), [24,1.25,true]);
t('4 walls -> next wall 36 @0.833', C({comic_wall:4},'comic_wall'), [36,0.833,false]);
t('4 walls -> box 120 @0.833 UNLOCKED', C({comic_wall:4},'short_box'), [120,0.833,true]);
t('5 walls -> 6th wall 40 @0.75', C({comic_wall:5},'comic_wall'), [40,0.75,false]);
t('5 walls -> box 140 @0.714 UNLOCKED', C({comic_wall:5},'short_box'), [140,0.714,true]);

console.log('--- nothing already earned goes down ---');
t('3 boxes -> box 160', C({short_box:3},'short_box'), [160,0.625,false]);
t('3 boxes -> wall 32', C({short_box:3},'comic_wall'), [32,0.938,false]);
t('3 boxes -> stack 8', C({short_box:3},'comic_stack'), [8,1.25,false]);
t('no history -> all base', [C({},'comic_stack'),C({},'comic_wall'),C({},'short_box')], [[5,2,false],[20,1.5,false],[100,1,false]]);

console.log('--- ceilings ---');
t('5 stacks -> stack 10 @1.00', C({comic_stack:5},'comic_stack'), [10,1,false]);
t('5 stacks -> wall 32 @0.938 UNLOCKED', C({comic_stack:5},'comic_wall'), [32,0.938,true]);
t('5 stacks -> box 120 @0.833 UNLOCKED', C({comic_stack:5},'short_box'), [120,0.833,true]);
t('9 stacks caps stack at L5', C({comic_stack:9},'comic_stack'), [10,1,false]);
t('9 stacks: box still 120, no runaway', C({comic_stack:9},'short_box'), [120,0.833,true]);

console.log('--- chain expiry and ineligible purchases ---');
const stale=[1,2,3].map(i=>({tier:'comic_stack',createdAtMs:now-(400-i*10)*DAY,environment:'Production'}));
const so=R.tierOffers(stale,now);
t('stale chain -> all base', [so.comic_stack.credits,so.comic_wall.credits,so.short_box.credits], [5,20,100]);
t('refunded + sandbox ignored', R.tierOffers([{tier:'comic_stack',createdAtMs:now-7*DAY,environment:'Production',refunded:true},{tier:'comic_stack',createdAtMs:now-14*DAY,environment:'Sandbox'}],now).comic_stack.credits, 5);

console.log('--- INVARIANT: a higher tier is NEVER dearer per credit ---');
const specs=[];
for (let a=0;a<=6;a++) for (let b=0;b<=6;b++) for (let c=0;c<=3;c++) specs.push({comic_stack:a,comic_wall:b,short_box:c});
let mono=0;
for (const spec of specs) {
  const o=R.tierOffers(buys(spec),now);
  if(!(o.comic_wall.perCredit <= o.comic_stack.perCredit+1e-9 && o.short_box.perCredit <= o.comic_wall.perCredit+1e-9)){
    fails++; console.log('FAIL monotonic',JSON.stringify(spec),o.comic_stack.perCredit,o.comic_wall.perCredit,o.short_box.perCredit);
  } else mono++;
}
console.log('ok   monotonic across '+mono+' purchase histories');

console.log('--- INVARIANT: parity never lowers an earned bonus ---');
let nd=0;
for (const spec of specs) { const L=R.effectiveLevels(buys(spec),now);
  for (const k of Object.keys(L)) { if (L[k].level < L[k].earned) { fails++; console.log('FAIL downgrade',k,JSON.stringify(spec)); } else nd++; } }
console.log('ok   no downgrades across '+nd+' tier/history pairs');

console.log('--- the one divergence from how Matt described it ---');
t('2 stacks -> next stack 7 @1.429', C({comic_stack:2},'comic_stack'), [7,1.429,false]);
t('2 stacks -> wall unlocks at 24 (he said after 3)', C({comic_stack:2},'comic_wall'), [24,1.25,true]);
t('1 stack  -> wall NOT unlocked', C({comic_stack:1},'comic_wall'), [20,1.5,false]);

console.log(fails? '\n'+fails+' FAILURES' : '\nALL PASS ('+(mono+nd)+' invariant checks)');
process.exit(fails?1:0);
