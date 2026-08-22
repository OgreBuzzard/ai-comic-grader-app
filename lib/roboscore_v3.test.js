const RS = require('./roboscore_v3.js');
let pass=0, fail=0;
function eq(a,b){ return JSON.stringify(a)===JSON.stringify(b); }
function t(name, got, exp){ if(eq(got,exp)){pass++; console.log("ok  "+name);} else {fail++; console.log("FAIL "+name+"\n   got "+JSON.stringify(got)+"\n   exp "+JSON.stringify(exp));} }

const perfect = {front50:50,back20:20,spine20:20,pageQuality:"White",depth:"full",photograder:{focus:"A",lighting:"A",cropping:"A",angle:"A"}};
t("perfect full = 10", RS.compute(perfect).grade, 10);
t("perfect full pm 0.5", RS.compute(perfect).pm, 0.5);
t("perfect full no upsell", RS.compute(perfect).upsell, null);

t("perfect MAIN caps at 9.0", RS.compute({...perfect,depth:"main"}).grade, 9.0);
t("perfect main upsell deep", RS.compute({...perfect,depth:"main"}).upsell, "deep");
t("perfect main pm 1", RS.compute({...perfect,depth:"main"}).pm, 1);
t("perfect main ceilingHit", RS.compute({...perfect,depth:"main"}).ceilingHit, true);

t("perfect DEEP caps at 9.5", RS.compute({...perfect,depth:"deep"}).grade, 9.5);
t("perfect deep upsell full", RS.compute({...perfect,depth:"deep"}).upsell, "full");

// a clean 9.5 book (front 4.5) — full, should show 9.5, no ceiling, no upsell
const nm = {front50:45,back20:20,spine20:20,pageQuality:"White",depth:"full",photograder:{focus:"A",lighting:"A",cropping:"A",angle:"A"}};
t("9.5 full grade", RS.compute(nm).grade, 9.5);
t("9.5 full no ceiling", RS.compute(nm).ceilingHit, false);
t("9.5 full no upsell", RS.compute(nm).upsell, null);

// interior flaw drop: White + defect -> interior 0.5 -> total 9.5 (front5+back2+spine2+0.5)
t("interior flaw drops 1->0.5", RS.compute({...perfect,interiorDefect:true}).subscores.interior, 0.5);
t("interior flaw total 9.5", RS.compute({...perfect,interiorDefect:true}).grade, 9.5);

// interior page-quality mapping
t("Cream interior = 0", RS.interiorTier("Cream", false), 0);
t("Cream to Off-White = 0.5", RS.interiorTier("Cream to Off-White", false), 0.5);
t("Off-White to White = 0.5", RS.interiorTier("Off-White to White", false), 0.5);
t("White = 1", RS.interiorTier("White", false), 1);
t("Tan = 0", RS.interiorTier("Tan", false), 0);

// slabbed: perfect at deep -> capped 9.5, NO full upsell, pm 1.5
const sl = {...perfect, depth:"deep", slabbed:true};
t("slabbed deep caps 9.5", RS.compute(sl).grade, 9.5);
t("slabbed no full upsell", RS.compute(sl).upsell, null);
t("slabbed pm 1.5", RS.compute(sl).pm, 1.5);

// photograder penalty: main all-A pm1; main with a B -> pm 1.5
t("main +B photo pm 1.5", RS.compute({...perfect,depth:"main",photograder:{focus:"B",lighting:"A",cropping:"A",angle:"A"}}).pm, 1.5);
// missing images -> 1.5
t("missing images pm 1.5", RS.compute({...perfect,depth:"full",missingImages:true}).pm, 1.5);

// mid-grade book, no cap in play: front 3.5, back 1.5, spine 1.5, cream(0) -> 6.5
t("mid book 6.5", RS.compute({front50:35,back20:15,spine20:15,pageQuality:"Cream",depth:"main",photograder:{focus:"A",lighting:"A",cropping:"A",angle:"A"}}).grade, 6.5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
