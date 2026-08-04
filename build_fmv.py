#!/usr/bin/env python3
"""
build_fmv.py — Robograder FMV index converter (canonical build tool).

Converts the data-entry workbook (Robograder_Index_Input_N.xlsx) into fmv.json,
the compressed price index the app (index.html -> matchFMV / _fmvKeyOf) reads.

METHODOLOGY (must stay in sync with the workbook README sheet + index.html):
  * Workbook cells ARE tier numbers 1-13 (NOT dollars). Tier legend + $ ranges
    live in fmv.json "tiers" (unchanged here). Boundaries are [low, high).
  * Each row = one issue (or annual A1/A2/A3). Grade columns 0.5 .. 9.8 ascend.
    Fill the 0.5 base + each cell where the tier STEPS UP; a blank cell inherits
    the nearest filled cell to its LEFT. Filling every cell also works — both
    styles convert identically because we compress consecutive-equal tiers.
  * A curve = the compressed ascending [[grade, tier], ...] breakpoints. Curves
    are DEDUPED into "curves"; books[key] is an integer index into that list.
  * Key = _fmvKeyOf(title, issue): lowercased title (drop leading "The"), annual
    folding (title "Annual" or issue "Annual N"/"A N" -> base title + "A<n>"),
    and "Invincible Iron Man" -> "Iron Man". MUST MIRROR index.html _fmvKeyOf.
  * Sheet priority (first-wins on duplicate key): the per-series sheets, then
    Other Value Keys, EC Comics, Most Submitted, then All Others last. So a book
    priced on its series sheet wins over a catch-all listing.
  * Blank rows (no filled grade cell) = unpriced -> skipped (app shows nothing).
  * volumeGuards: generated from the "Volume" column (Silver Surfer 1968 vs 1987).
    The cutoff year (max cover year the earlier volume's curve is valid for) is
    CURATED, not in the sheet -> see GUARD_CUTOFFS below. Add series/volumes there.
  * tiers are preserved from the previous fmv.json unchanged.

VALIDATION the build prints: books/curves counts, added/dropped keys, duplicate
rows (and CONFLICTING curves for the same key), bad tier cells. A good run drops
ONLY intended keys (e.g. invincible-iron-man consolidation) and changes shared
keys ONLY where you re-priced them.

USAGE:  python3 build_fmv.py [INPUT.xlsx] [OLD_fmv.json] [OUT_fmv.json]
        defaults: Robograder_Index_Input_11a.xlsx  fmv.json  fmv.new.json
"""
import sys

import openpyxl, json, re, sys

IN_XLSX = sys.argv[1] if len(sys.argv)>1 else 'Robograder_Index_Input_11a.xlsx'
OLD_JSON = sys.argv[2] if len(sys.argv)>2 else 'fmv.json'
OUT_JSON = sys.argv[3] if len(sys.argv)>3 else 'fmv.new.json'
OLD=json.load(open(OLD_JSON))
TIERS=OLD['tiers']
# volumeGuards are generated from the 'Volume' column (README: Silver Surfer mixes
# 1968 vs 1987 series; guard the earlier volume's issues by a curated cutoff year so
# a later-dated book doesn't inherit the earlier value). Cutoff years are curated
# (not in the sheet): the max cover year the earlier volume's curve is valid for.
GUARD_CUTOFFS = { 'silver surfer': { '1968': 1971 } }   # {normSeries: {volumeLabel: maxYear}}

def normTitle(s):
    if not s: return ''
    return re.sub(r'^the\s+','',re.sub(r'\s+',' ',str(s).strip()),flags=re.I).lower()
def coerce_issue(issue):
    if issue is None: return ''
    if isinstance(issue,float) and issue.is_integer(): return str(int(issue))
    if isinstance(issue,int): return str(issue)
    return re.sub(r'^(\d+)\.0+$', r'\1', str(issue).strip())
def fmvKey(title,issue):
    t=re.sub(r'\s+',' ',str(title or '').strip()); i=re.sub(r'^#','',coerce_issue(issue))
    ta=re.search(r'\bannual\b',t,re.I)
    ma=re.match(r'^\s*(?:annual|ann\.?)\s*#?\s*0*(\d+)\s*$',i,re.I)
    mA=re.match(r'^\s*A\s*0*(\d+)\s*$',i,re.I)
    if ta:
        t=re.sub(r'\s+',' ',re.sub(r'\bannual\b','',t,flags=re.I)).strip()
        num=ma.group(1) if ma else (mA.group(1) if mA else re.sub(r'^0+(\d)',r'\1',i)); i='A'+num
    elif ma: i='A'+ma.group(1)
    elif mA: i='A'+mA.group(1)
    else: i=re.sub(r'^0+(\d)',r'\1',i)
    t=re.sub(r'^invincible\s+iron\s+man\b','Iron Man',t,flags=re.I)
    return normTitle(t)+'|'+i

def norm_issue_display(issue):
    # what we display back in Input_12 for the issue (canonical): keep A-form for annuals
    return fmvKey('x',issue).split('|',1)[1]

wb=openpyxl.load_workbook(IN_XLSX, read_only=True, data_only=True)
def cell(r,i): return r[i] if i<len(r) else None

# processing priority: series sheets first, then value-key sheets, catch-alls last
SERIES=[n for n in wb.sheetnames if n not in ('README','Other Value Keys','Most Submitted','EC Comics','All Others')]
ORDER=SERIES+['Other Value Keys','EC Comics','Most Submitted','All Others']

books={}   # key -> curve (list of [grade,tier])
origin={}  # key -> (sheet, issue, title)
dupes=[]   # (key, sheet, title, issue, same_or_conflict)
badtier=[]
for name in ORDER:
    ws=wb[name]; rows=list(ws.iter_rows(values_only=True))
    if not rows: continue
    hdr=rows[0]
    grade_cols=[(i,float(h)) for i,h in enumerate(hdr) if isinstance(h,(int,float)) or (isinstance(h,str) and re.fullmatch(r'\d+(\.\d+)?',(h or '').strip()))]
    title_i=next((i for i,h in enumerate(hdr) if isinstance(h,str) and (h or '').strip().lower()=='title'), None)
    issue_i=next((i for i,h in enumerate(hdr) if isinstance(h,str) and (h or '').strip().lower()=='issue'), None)
    for r in rows[1:]:
        if issue_i is None: continue
        iss=cell(r,issue_i)
        if iss in (None,''): continue
        title = cell(r,title_i) if title_i is not None else name
        if title in (None,''): continue
        curve=[]
        for i,g in grade_cols:
            v=cell(r,i)
            if v in (None,''): continue
            try: tv=int(round(float(v)))
            except: continue
            if tv<1 or tv>13: badtier.append((name,str(title),str(iss),g,v)); continue
            curve.append([g,tv])
        if not curve: continue
        curve.sort(key=lambda x:x[0])
        # compress: drop consecutive equal tiers
        comp=[]; last=None
        for g,tv in curve:
            if tv!=last: comp.append([g,tv]); last=tv
        key=fmvKey(title,iss)
        if key in books:
            same = books[key]==comp
            dupes.append((key,name,str(title),str(iss),'same' if same else 'CONFLICT', origin[key], comp if not same else None))
            continue  # first-wins
        books[key]=comp; origin[key]=(name,str(iss),str(title))

# --- volumeGuards from the Volume column ---
GUARDS={}
for name in SERIES:
    ws=wb[name]; rows=list(ws.iter_rows(values_only=True))
    if not rows: continue
    hdr=rows[0]
    voli=next((i for i,h in enumerate(hdr) if isinstance(h,str) and 'volume' in (h or '').lower()), None)
    issue_i=next((i for i,h in enumerate(hdr) if isinstance(h,str) and (h or '').strip().lower()=='issue'), None)
    if voli is None or issue_i is None: continue
    cut=GUARD_CUTOFFS.get(normTitle(name))
    if not cut: continue
    for r in rows[1:]:
        iss=cell(r,issue_i); vol=cell(r,voli)
        if iss in (None,'') or vol in (None,''): continue
        vl=str(vol).strip().replace('.0','')
        if vl in cut:
            k=fmvKey(name,iss)
            if k in books: GUARDS[k]=cut[vl]

# dedup curves
curve_index={}; curves=[]
booksOut={}
for k,c in books.items():
    sig=json.dumps(c)
    if sig not in curve_index:
        curve_index[sig]=len(curves); curves.append(c)
    booksOut[k]=curve_index[sig]

new={'version':'1.8.0','tiers':TIERS,'volumeGuards':GUARDS,'curves':curves,'books':booksOut}
json.dump(new, open(OUT_JSON,'w'), separators=(',',':'))

# ---- report ----
old_keys=set(OLD['books']); new_keys=set(booksOut)
print('NEW books:', len(booksOut), '| curves:', len(curves), '(old', len(OLD['books']),'books /',len(OLD['curves']),'curves)')
print('added keys:', len(new_keys-old_keys), '| dropped keys (in old, not new):', len(old_keys-new_keys))
dropped=sorted(old_keys-new_keys)
print('  sample dropped:', dropped[:20])
conf=[d for d in dupes if d[4]=='CONFLICT']
print('duplicate rows dropped (first-wins):', len(dupes), '| of which CONFLICTing curves:', len(conf))
for d in conf[:25]:
    print('   CONFLICT', d[0], '| kept from', d[5], '| also in', d[1],'/',d[2],d[3],'->',d[6])
print('bad tier cells:', len(badtier), badtier[:6])
# FF annual redundancy check
ffdupe=[d for d in dupes if d[0].startswith('fantastic four|A')]
print('FF annual dupes in catch-alls (should be dropped):', [(d[0],d[1]) for d in ffdupe])
# iron man 128 present now?
print('iron man|128 present now:', 'iron man|128' in booksOut, '| iron man|150:', 'iron man|150' in booksOut)
