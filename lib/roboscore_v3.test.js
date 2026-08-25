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

// PM: main default 1.0
t("main PM 1", RS.compute({...perfect,depth:"main"}).pm, 1);
t("main PM label ±1", RS.compute({...perfect,depth:"main"}).pmLabel, "±1");
t("deep PM 0.5", RS.compute({...perfect,depth:"deep"}).pm, 0.5);
t("full all16 A -> PM 0", RS.compute({...perfect,depth:"full",all16Present:true}).pm, 0);
t("full A but not all16 -> 0.5", RS.compute({...perfect,depth:"full",all16Present:false}).pm, 0.5);

// photograder severity
t("main one C -> 1.5", RS.compute({...perfect,depth:"main",photograder:{...A,focus:"C"}}).pm, 1.5);
t("main two B -> 1.5", RS.compute({...perfect,depth:"main",photograder:{...A,focus:"B",lighting:"B"}}).pm, 1.5);
t("main one B -> 1 (base)", RS.compute({...perfect,depth:"main",photograder:{...A,focus:"B"}}).pm, 1);
t("main two C -> 2", RS.compute({...perfect,depth:"main",photograder:{focus:"C",lighting:"C",cropping:"A",angle:"A"}}).pm, 2);
t("main C+B -> 2", RS.compute({...perfect,depth:"main",photograder:{focus:"C",lighting:"B",cropping:"A",angle:"A"}}).pm, 2);
t("deep one C -> 1", RS.compute({...perfect,depth:"deep",photograder:{...A,focus:"C"}}).pm, 1);
t("deep two C -> 1.5", RS.compute({...perfect,depth:"deep",photograder:{focus:"C",lighting:"C",cropping:"A",angle:"A"}}).pm, 1.5);

// missing core images (raw main)
t("main missing 1 core -> 1.5", RS.compute({...perfect,depth:"main",missingCore:1}).pm, 1.5);
t("main missing 2 core -> 2", RS.compute({...perfect,depth:"main",missingCore:2}).pm, 2);

// slabbed
t("slab main PM 1.5", RS.compute({...perfect,depth:"main",slabbed:true}).pm, 1.5);
t("slab deep PM 1", RS.compute({...perfect,depth:"deep",slabbed:true}).pm, 1);
t("slab deep caps 9.5 no upsell", RS.compute({...perfect,depth:"deep",slabbed:true}).upsell, null);
t("slab main +C -> 2", RS.compute({...perfect,depth:"main",slabbed:true,photograder:{...A,focus:"C"}}).pm, 2);

// interior + defect
t("interior flaw White->0.5", RS.compute({...perfect,depth:"full",all16Present:true,interiorDefect:true}).subscores.interior, 0.5);
t("Cream interior 0", RS.interiorTier("Cream",false), 0);

// defected 9.5 book at main -> 9.0 via 0.5 shave (front 4.5->4.0)
let d95=RS.compute({front50:45,back20:20,spine20:20,pageQuality:"White",depth:"main",photograder:A});
t("9.5 book main -> 9.0", d95.grade, 9.0);
t("9.5 book main shave 0.5 front", d95.subscores, {front:4,back:2,spine:2,interior:1});


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
  t("92-book full stays 9.5 (not a true 10)", fu.grade, 9.5);
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
