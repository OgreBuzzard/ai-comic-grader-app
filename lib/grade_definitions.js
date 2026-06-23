// lib/grade_definitions.js
// Generated from Grade_Reference/CGC_GRADE_DEFINITIONS.md (Matt-authored captions).
// Per-grade reference-image metadata for the Deep Assessment grade-reference
// comparison: each grade maps to its reference image file and the condition
// caption that labels it. CGC_GRADE_SCALE is the ordered scale used to build the
// +/-2-position reference window. 0.5 has an image but no caption by design.
// Regenerate when the captions change (do not hand-edit).

export const CGC_GRADE_SCALE = ['0.5', '1.0', '1.5', '1.8', '2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5', '6.0', '6.5', '7.0', '7.5', '8.0', '8.5', '9.0', '9.2', '9.4', '9.6', '9.8', '9.9', '10.0'];

export const GRADE_DEFINITIONS = {
  '1.0': { name: 'FAIR', file: '1_0.jpg', caption: 'Large piece out bottom right corner of front cover.' },
  '1.5': { name: 'FAIR / GOOD', file: '1_5.jpg', caption: 'Moderate piece out of bottom cover. Creasing, tears and small pieces out of edges and spine of cover.' },
  '1.8': { name: 'GOOD-', file: '1_8.jpg', caption: 'Cover detached. Heavy creasing, scuffing and tears to cover.' },
  '2.0': { name: 'GOOD', file: '2_0.jpg', caption: 'Moderate tear and split top spine. Heavy color breaking creasing throughout cover.' },
  '2.5': { name: 'GOOD+', file: '2_5.jpg', caption: 'Cover nearly detached from staples. Heavy color breaking wear top edge. Piece out bottom spine.' },
  '3.0': { name: 'GOOD/VERY GOOD / GOOD+', file: '3_0.jpg', caption: 'Heavy creasing to mid spine and middle right edge. Large diagonal crease bottom cover.' },
  '3.5': { name: 'GOOD/VERY GOOD / GOOD+', file: '3_5.jpg', caption: 'Moderate scuffing and creasing to edges and corners. Heavy color breaking wear spine.' },
  '4.0': { name: 'VERY GOOD+ / VERY GOOD', file: '4_0.jpg', caption: 'Multiple reader creases break color full length of spine. Creasing bottom right corner.' },
  '4.5': { name: 'VERY GOOD+ / VERY GOOD', file: '4_5.jpg', caption: 'Moderate crease right edge. Moderate color breaking wear to spine and edges.' },
  '5.0': { name: 'VERY GOOD / FINE', file: '5_0.jpg', caption: 'Multiple color breaking creases and tears to edges and corners of cover. Heavy wear mid spine.' },
  '5.5': { name: 'FINE-', file: '5_5.jpg', caption: 'Scuffing and creasing to edges of cover. Moderate stress lines. Minor staple tears.' },
  '6.0': { name: 'FINE', file: '6_0.jpg', caption: 'Moderate creasing along spine and right edge. Light tears.' },
  '6.5': { name: 'FINE+', file: '6_5.jpg', caption: 'Light wear to edges of cover. Color breaking creases and stress lines along spine. Color loss right edge.' },
  '7.0': { name: 'FINE / VERY FINE', file: '7_0.jpg', caption: "Reader's crease breaks color along spine. Color breaking finger creases and small tears middle right edge." },
  '7.5': { name: 'VERY FINE-', file: '7_5.jpg', caption: 'Crease top right corner. Significant wear bottom spine. Significant stress lines extending out from spine.' },
  '8.0': { name: 'VERY FINE', file: '8_0.jpg', caption: 'Small color breaking creases top right corner and mid spine. Color breaking stress lines.' },
  '8.5': { name: 'VERY FINE+', file: '8_5.jpg', caption: 'Color breaking wear top corners. Color breaking stress lines. Printer ink smudge present near spine.' },
  '9.0': { name: 'VERY FINE / NEAR MINT', file: '9_0.jpg', caption: 'Light wear to bottom spine and top right corner. Color breaking spine wear. Light printer ink smudge upper spine.' },
  '9.2': { name: 'NEAR MINT-', file: '9_2.jpg', caption: 'Several color breaking stress lines present, but small in nature. Light wear to corners.' },
  '9.4': { name: 'NEAR MINT', file: '9_4.jpg', caption: 'Light spine wear that breaks color. Corners sharp with no other wear present. No printer ink smudge present.' },
  '9.6': { name: 'NEAR MINT+', file: '9_6.jpg', caption: 'Three to four small color breaking stress lines. Slight wear top right corner and top spine.' },
  '9.8': { name: 'NEAR MINT / MINT', file: '9_8.jpg', caption: 'Two very small color breaking stress lines. Very slight wear beginning to show at corner tips.' },
  '9.9': { name: 'MINT', file: '9_9.jpg', caption: 'Near perfect; very slight wear top and bottom spine corners and one small color breaking stress line mid spine.' },
  '10.0': { name: 'GEM MINT', file: '10_0.jpg', caption: 'Razor sharp corners. Perfect spine with no stress lines. No evidence of an ink smear, miswrap or faded colors.' }
};
