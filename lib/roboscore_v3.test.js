const RS = require('./roboscore_v3.js');
let pass=0, fail=0;
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function t(name,got,exp){ if(eq(got,exp)){pass++;console.log("ok  "+name);} else {fail++;console.log("FAIL "+name+"\n   got "+JSON.stringify(got)+"\n   exp "+JSON.stringify(exp));} }
const A={focus:"A",lighting:"A",cropping:"A",angle:"A"};
const perfect={front50:50,back20:20,spine20:20,pageQuality:"White",photograder:A};

// grades + shave-cap reconciliation
t("full perfect =10", RS.compute({...perfect,depth:"full",all16Present:true}).grade, 10);
let m=RS.compute({...perfect,depth:"main"});
t("main caps 9.0", m.grade, 9.0);
t("main shave front+back", m.subscores, {front:4.5,back:1.5,spine:2,interior:1});
t("main subscores reconcile", m.subscores.front+m.subscores.back+m.subscores.spine+m.subscores.interior, 9.0);
t("main upsell deep", m.upsell, "deep");
let dp=RS.compute({...perfect,depth:"deep"});
t("deep caps 9.5", dp.grade, 9.5);
t("deep shave front only", dp.subscores, {front:4.5,back:2,spine:2,interior:1});
t("deep upsell full", dp.upsell, "full");

// ---- PM: raw severity table (computePM, uncapped) ----
t("raw main default 1.0", RS.computePM({depth:"main",photograder:A}), 1);
t("raw deep 0.5", RS.computePM({depth:"deep",photograder:A}), 0.5);
t("raw full all16 A -> 0", RS.computePM({depth:"full",all16Present:true,photograder:A}), 0);
t("raw full A not all16 -> 0.5", RS.computePM({depth:"full",all16Present:false,photograder:A}), 0.5);
t("raw main one C -> 1.5", RS.computePM({depth:"main",photograder:{...A,focus:"C"}}), 1.5);
t("raw main two B -> 1.5", RS.computePM({depth:"main",photograder:{...A,focus:"B",lighting:"B"}}), 1.5);
t("raw main one B -> 1", RS.computePM({depth:"main",photograder:{...A,focus:"B"}}), 1);
t("raw main two C -> 2", RS.computePM({depth:"main",photograder:{focus:"C",lighting:"C",cropping:"A",angle:"A"}}), 2);
t("raw main C+B -> 2", RS.computePM({depth:"main",photograder:{focus:"C",lighting:"B",cropping:"A",angle:"A"}}), 2);
t("raw deep one C -> 1", RS.computePM({depth:"deep",photograder:{...A,focus:"C"}}), 1);
t("raw deep two C -> 1.5", RS.computePM({depth:"deep",photograder:{focus:"C",lighting:"C",cropping:"A",angle:"A"}}), 1.5);
t("raw main missing 1 core -> 1.5", RS.computePM({depth:"main",missingCore:1,photograder:A}), 1.5);
t("raw main missing 2 core -> 2", RS.computePM({depth:"main",missingCore:2,photograder:A}), 2);
t("raw slab main 1.5", RS.computePM({depth:"main",slabbed:true,photograder:A}), 1.5);
t("raw slab deep 1", RS.computePM({depth:"deep",slabbed:true,photograder:A}), 1);
t("raw slab main +C -> 2", RS.computePM({depth:"main",slabbed:true,photograder:{...A,focus:"C"}}), 2);
t("slab deep caps 9.5 no upsell", RS.compute({...perfect,depth:"deep",slabbed:true}).upsell, null);

// ---- S25 (#6): displayed PM cap = min(pm, 10 - grade); perfect 10 -> 0 ----
t("perfect main 9.0 -> PM ±1", RS.compute({...perfect,depth:"main"}).pm, 1);
t("perfect main label ±1", RS.compute({...perfect,depth:"main"}).pmLabel, "±1");
t("perfect deep 9.5 -> PM ±0.5", RS.compute({...perfect,depth:"deep"}).pm, 0.5);
t("perfect 10 (full all16) -> PM 0", RS.compute({...perfect,depth:"full",all16Present:true}).pm, 0);
t("10 not all16 -> PM still 0 (cap)", RS.compute({...perfect,depth:"full",all16Present:false}).pm, 0);
t("9.0 book bad photos -> PM capped ±1", RS.compute({...perfect,depth:"main",photograder:{...A,focus:"C"}}).pm, 1);
t("8.5 book two-C -> PM capped ±1.5", RS.compute({front50:45,back20:15,spine20:15,pageQuality:"White",depth:"main",photograder:{focus:"C",lighting:"C",cropping:"A",angle:"A"}}).pm, 1.5);
// mid-grade books keep their wide PM (cap does not bite)
t("mid-grade main one C -> ±1.5 (uncapped)", RS.compute({front50:30,back20:13,spine20:10,pageQuality:"White",depth:"main",photograder:{...A,focus:"C"}}).pm, 1.5);
t("mid-grade main missing 1 core -> ±1.5", RS.compute({front50:30,back20:13,spine20:10,pageQuality:"White",depth:"main",missingCore:1,photograder:A}).pm, 1.5);

// ---- S25 (#5): photo severity > 1 hedges the TOP grades down ----
t("clean-photo 10 stays 10", RS.compute({...perfect,depth:"full",all16Present:true,photograder:A}).grade, 10);
t("one B still allows 10", RS.compute({...perfect,depth:"full",all16Present:true,photograder:{...A,focus:"B"}}).grade, 10);
t("two B hedges 10 -> 9.5", RS.compute({...perfect,depth:"full",all16Present:true,photograder:{...A,focus:"B",lighting:"B"}}).grade, 9.5);
t("one C hedges 10 -> 9.5", RS.compute({...perfect,depth:"full",all16Present:true,photograder:{...A,focus:"C"}}).grade, 9.5);
t("one B still allows 9.5 (deep)", RS.compute({...perfect,depth:"deep",photograder:{...A,focus:"B"}}).grade, 9.5);
t("two B hedges 9.5 -> 9.0 (deep)", RS.compute({...perfect,depth:"deep",photograder:{...A,focus:"B",lighting:"B"}}).grade, 9.0);

// ---- S25 (#6): card PM cap too ----
t("card perfect deep 10 -> PM 0", RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"deep",photograder:A}).pm, 0);
t("card main 9.5 -> PM ±0.5", RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"main",photograder:A}).pm, 0.5);

// interior + defect
t("interior flaw White->0.5", RS.compute({...perfect,depth:"full",all16Present:true,interiorDefect:true}).subscores.interior, 0.5);
t("Cream interior 0", RS.interiorTier("Cream",false), 0);

// defected 9.5 book at main -> 9.0 via 0.5 shave (front 4.5->4.0)
let d95=RS.compute({front50:45,back20:20,spine20:20,pageQuality:"White",depth:"main",photograder:A});
t("9.5 book main -> 9.0", d95.grade, 9.0);
t("9.5 book main shave 0.5 front", d95.subscores, {front:4,back:2,spine:2,interior:1});


// ---- S23: round-each-then-sum + interior round-up (real-world cases) ----
t("interior Off-White -> 1", RS.interiorTier("Off-White",false), 1);
t("interior Off-White to White -> 1", RS.interiorTier("Off-White to White",false), 1);
t("interior Cream to Off-White -> 0.5", RS.interiorTier("Cream to Off-White",false), 0.5);
t("interior Off-White + flaw -> 0.5", RS.interiorTier("Off-White",true), 0.5);
// KQC4SR Superman MoS #19: v1 46/18/18/9 Off-White-to-White, Deep -> 9.5
(function(){
  var r = RS.compute({front50:46,back20:18,spine20:18,pageQuality:"Off-White to White",depth:"deep"});
  t("KQC4SR grade 9.5", r.grade, 9.5);
  t("KQC4SR subs 4.5/2/2/1", r.subscores, {front:4.5,back:2,spine:2,interior:1});
})();
// H5RT8X Uncanny X-Men #135: v1 30/13/4 Off-White, Main -> 6.0
(function(){
  var r = RS.compute({front50:30,back20:13,spine20:4,pageQuality:"Off-White",depth:"main"});
  t("H5RT8X grade 6.0", r.grade, 6.0);
  t("H5RT8X subs 3/1.5/0.5/1", r.subscores, {front:3,back:1.5,spine:0.5,interior:1});
})();

// ---- forComic adapter ----
t("forComic card -> null", RS.forComic({type:"card",roboGrade:{frontScore:40}}), null);
t("forComic no roboGrade -> null", RS.forComic({}), null);
t("forComic depth main clean caps 9.0",
  RS.forComic({roboGrade:{frontScore:50,backScore:20,spineScore:20,pageQuality:"White",defects:[]},photograder:A}).grade, 9.0);
t("forComic full flag caps 10",
  RS.forComic({fullAssessmentRan:true,fullInteriorComplete:true,roboGrade:{frontScore:50,backScore:20,spineScore:20,pageQuality:"White",defects:[]},photograder:A}).grade, 10);
t("forComic deep flag caps 9.5",
  RS.forComic({deepAssessmentRan:true,roboGrade:{frontScore:50,backScore:20,spineScore:20,pageQuality:"White",defects:[]},photograder:A}).grade, 9.5);
t("forComic slab (labelDetected) caps 9.5",
  RS.forComic({fullAssessmentRan:true,labelDetected:true,roboGrade:{frontScore:50,backScore:20,spineScore:20,pageQuality:"White",defects:[]},photograder:A}).grade, 9.5);
t("forComic interior tear drops interior",
  RS.forComic({fullAssessmentRan:true,fullInteriorComplete:true,roboGrade:{frontScore:50,backScore:20,spineScore:20,pageQuality:"White",defects:[{category:"Interior",type:"Page tear along spine"}]},photograder:A}).subscores.interior, 0.5);
t("forComic page-tanning is NOT an interior flaw (color only)",
  RS.forComic({fullAssessmentRan:true,fullInteriorComplete:true,roboGrade:{frontScore:50,backScore:20,spineScore:20,pageQuality:"White",defects:[{category:"Interior",type:"Page tanning"}]},photograder:A}).subscores.interior, 1);


// ---- CARD v3 ----
t("card full-clean main caps 9.5", RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"main",photograder:A}).grade, 9.5);
t("card main upsell deep", RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"main",photograder:A}).upsell, "deep");
t("card clean deep -> 10 (no Full needed)", RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"deep",photograder:A}).grade, 10);
t("card deep no upsell", RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"deep",photograder:A}).upsell, null);
t("card slab deep caps 9.5", RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"deep",slabbed:true,photograder:A}).grade, 9.5);
t("card main shave surface first", RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"main",photograder:A}).subscores, {surface:4.5,corners:2,edges:2,centering:1});
t("card surface 8-low (25/50) -> 2.5", RS.computeCard({surface50:25,corners20:20,edges20:20,centering10:10,depth:"deep",photograder:A}).subscores.surface, 2.5);
t("card forCard reads cardData.robograde", RS.forCard({cardData:{robograde:{surface:{total:50},corners:{total:20},edges:{total:20},centering:{total:10}}},deepAssessmentRan:true,photograder:A}).grade, 10);
t("card forCard main default", RS.forCard({cardData:{robograde:{surface:{total:50},corners:{total:20},edges:{total:20},centering:{total:10}}},photograder:A}).grade, 9.5);

// S22: sum-then-round-then-decompose — no rounding inflation, subscores sum to grade.
(function(){
  var m = RS.compute({front50:48,back20:18,spine20:18,pageQuality:"White",depth:"main"});
  t("92-book main -> 9.0 (no inflation to 10)", m.grade, 9.0);
  t("92-book main subs sum to grade", m.subscores.front+m.subscores.back+m.subscores.spine+m.subscores.interior, 9.0);
  var d = RS.compute({front50:48,back20:18,spine20:18,pageQuality:"White",depth:"deep"});
  t("92-book deep -> 9.5", d.grade, 9.5);
  var fu = RS.compute({front50:48,back20:18,spine20:18,pageQuality:"White",depth:"full"});
  t("S23: 48/18/18 full capped 9.5 (below the 10 gate)", fu.grade, 9.5);
  var pf = RS.compute({front50:50,back20:20,spine20:20,pageQuality:"White",depth:"full"});
  t("true-perfect full -> 10", pf.grade, 10);
  // property: subscores always reconcile to grade across a sweep
  var okAll = true;
  for (var f=0; f<=50; f+=3) for (var b=0; b<=20; b+=4) for (var sp=0; sp<=20; sp+=5) {
    ["main","deep","full"].forEach(function(dp){
      var r = RS.compute({front50:f,back20:b,spine20:sp,pageQuality:"White",depth:dp});
      var sm = r.subscores.front+r.subscores.back+r.subscores.spine+r.subscores.interior;
      if (Math.abs(sm - r.grade) > 1e-9) okAll = false;
    });
  }
  t("subscores sum to grade across full sweep", okAll, true);
})();
// S22: card decomposition — no inflation, subscores sum to grade.
(function(){
  var cm = RS.computeCard({surface50:48,corners20:18,edges20:18,centering10:8,depth:"main"});
  t("card 92-ish main no inflation to 10 (caps at card-main 9.5)", cm.grade < 10 && cm.grade <= 9.5, true);
  t("card main subs sum to grade", cm.subscores.surface+cm.subscores.corners+cm.subscores.edges+cm.subscores.centering, cm.grade);
  var cd = RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"deep"});
  t("card true-perfect deep -> 10", cd.grade, 10);
  var okAll = true;
  for (var f2=0; f2<=50; f2+=5) for (var c=0; c<=20; c+=5) for (var e=0; e<=20; e+=5) for (var ct=0; ct<=10; ct+=5) {
    ["main","deep"].forEach(function(dp){
      var r = RS.computeCard({surface50:f2,corners20:c,edges20:e,centering10:ct,depth:dp});
      var sm = r.subscores.surface+r.subscores.corners+r.subscores.edges+r.subscores.centering;
      if (Math.abs(sm - r.grade) > 1e-9) okAll = false;
    });
  }
  t("card subscores sum to grade across sweep", okAll, true);
})();
// ---- S23: perfect-10 gate ----
t("10 gate: 49/19/19 White full no-defects -> 10", RS.compute({front50:49,back20:19,spine20:19,pageQuality:"White",depth:"full",hasDefects:false}).grade, 10);
t("10 gate: 48/19/19 White full -> 9.5", RS.compute({front50:48,back20:19,spine20:19,pageQuality:"White",depth:"full"}).grade, 9.5);
t("10 gate: 49/18/19 White full -> 9.5", RS.compute({front50:49,back20:18,spine20:19,pageQuality:"White",depth:"full"}).grade, 9.5);
t("10 gate: 49/19/19 Off-White full -> 9.5 (needs White)", RS.compute({front50:49,back20:19,spine20:19,pageQuality:"Off-White",depth:"full"}).grade, 9.5);
t("10 gate: 49/19/19 White full WITH defects -> 9.5", RS.compute({front50:49,back20:19,spine20:19,pageQuality:"White",depth:"full",hasDefects:true}).grade, 9.5);
t("10 gate: 50/20/20 White full -> 10", RS.compute({front50:50,back20:20,spine20:20,pageQuality:"White",depth:"full"}).grade, 10);
t("10 gate forComic: perfect subs + a defect -> 9.5",
  RS.forComic({fullAssessmentRan:true,fullInteriorComplete:true,roboGrade:{frontScore:50,backScore:20,spineScore:20,pageQuality:"White",defects:[{category:"Front",type:"Corner blunting"}]},photograder:A}).grade, 9.5);
// card gate
t("card 10 gate: 49/19/19 centering 9 deep -> 9.5", RS.computeCard({surface50:49,corners20:19,edges20:19,centering10:9,depth:"deep"}).grade, 9.5);
t("card 10 gate: 50/20/20/10 deep -> 10", RS.computeCard({surface50:50,corners20:20,edges20:20,centering10:10,depth:"deep"}).grade, 10);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
