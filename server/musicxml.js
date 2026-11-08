// 박자 격자에 맞춘 파트들 → MusicXML (피아노 2단 / 베이스·기타 보표+TAB / 드럼 타악기 보표, 코드 기호, 계이름 가사)
import { GRID } from './quantize.js';
import { DRUM_PIECES } from './gemini.js';

const DIV = 4; // 4분음표당 division (16분음표 = 1)
const VALUES = [
  { beats: 4, type: 'whole', dot: false }, { beats: 3, type: 'half', dot: true }, { beats: 2, type: 'half', dot: false },
  { beats: 1.5, type: 'quarter', dot: true }, { beats: 1, type: 'quarter', dot: false }, { beats: 0.75, type: 'eighth', dot: true },
  { beats: 0.5, type: 'eighth', dot: false }, { beats: 0.25, type: '16th', dot: false },
];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SOLFEGE_SHARP = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
const SOLFEGE_FLAT = ['도', '레b', '레', '미b', '미', '파', '솔b', '솔', '라b', '라', '시b', '시'];
const MAJOR_FIFTHS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
const ENHARMONIC = { 'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab', 'Fb': 'E', 'E#': 'F', 'B#': 'C' };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
export const GUITAR_TUNING = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4 (낮은 현부터)
export const BASS_TUNING = [28, 33, 38, 43];           // E1 A1 D2 G2
const DRUM_DISPLAY = { // 표준 드럼 기보 위치
  kick: { step: 'F', octave: 4, head: 'normal' }, snare: { step: 'C', octave: 5, head: 'normal' },
  tom_low: { step: 'A', octave: 4, head: 'normal' }, tom_mid: { step: 'D', octave: 5, head: 'normal' }, tom_hi: { step: 'E', octave: 5, head: 'normal' },
  hihat: { step: 'G', octave: 5, head: 'x' }, hihat_open: { step: 'G', octave: 5, head: 'circle-x' }, crash: { step: 'A', octave: 5, head: 'x' }, ride: { step: 'F', octave: 5, head: 'x' },
};

export function keyToFifths(keyStr) {
  const m = String(keyStr || 'C major').trim().match(/^([A-Ga-g])\s*([#♯b♭]?)\s*(major|minor|maj|min|m)?/i);
  if (!m) return { fifths: 0, mode: 'major' };
  let tonic = m[1].toUpperCase() + (m[2] === '#' || m[2] === '♯' ? '#' : (m[2] === 'b' || m[2] === '♭' ? 'b' : ''));
  const modeRaw = (m[3] || 'major').toLowerCase();
  const mode = modeRaw.startsWith('m') && modeRaw !== 'major' && modeRaw !== 'maj' ? 'minor' : 'major';
  if (!(tonic in MAJOR_FIFTHS) && ENHARMONIC[tonic]) tonic = ENHARMONIC[tonic];
  let f = MAJOR_FIFTHS[tonic] ?? 0;
  if (mode === 'minor') f -= 3;
  if (f > 7) f -= 12;
  if (f < -7) f += 12;
  return { fifths: f, mode };
}
function keyAlter(step, fifths) {
  if (fifths > 0 && SHARP_ORDER.slice(0, fifths).includes(step)) return 1;
  if (fifths < 0 && FLAT_ORDER.slice(0, -fifths).includes(step)) return -1;
  return 0;
}
function pitchParts(p, useFlats) {
  const name = (useFlats ? FLAT_NAMES : SHARP_NAMES)[p % 12];
  return { step: name[0], alter: name.length > 1 ? (name[1] === '#' ? 1 : -1) : 0, octave: Math.floor(p / 12) - 1 };
}
export function solfege(p, useFlats) { return (useFlats ? SOLFEGE_FLAT : SOLFEGE_SHARP)[p % 12]; }
function decompose(beats) {
  const out = [];
  let r = Math.round(beats / GRID) * GRID;
  while (r > 1e-6) { const v = VALUES.find(v => v.beats <= r + 1e-6); out.push(v); r = Math.round((r - v.beats) / GRID) * GRID; }
  return out;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/** 음표 → 빈틈 없는 이벤트(화음/쉼표) 열. notes: {start, dur, p} */
function toEvents(notes, totalBeats, maxDur = Infinity) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.p - b.p);
  const groups = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.start - n.start) < 1e-6) { g.pitches.push(n.p); g.maxDur = Math.max(g.maxDur, n.dur); }
    else groups.push({ start: n.start, pitches: [n.p], maxDur: n.dur });
  }
  const events = [];
  let cursor = 0;
  groups.forEach((g, i) => {
    const next = groups[i + 1];
    let dur = Math.min(g.maxDur, maxDur);
    if (next) dur = Math.min(dur, next.start - g.start);
    dur = Math.max(GRID, Math.round(dur / GRID) * GRID);
    if (g.start > cursor + 1e-6) events.push({ start: cursor, dur: g.start - cursor, pitches: null });
    events.push({ start: g.start, dur, pitches: [...new Set(g.pitches)].sort((a, b) => a - b) });
    cursor = g.start + dur;
  });
  if (totalBeats > cursor + 1e-6) events.push({ start: cursor, dur: totalBeats - cursor, pitches: null });
  return events;
}

/** TAB용 현·프렛 배정. notes 정렬된 목록에 string(1=가장 높은 현), fret을 붙인다 */
export function assignFrets(notes, tuning, maxFret = 19) {
  const byStart = new Map();
  for (const n of notes) { const k = n.start; if (!byStart.has(k)) byStart.set(k, []); byStart.get(k).push(n); }
  let lastFret = 3;
  const out = new Map();
  for (const [, group] of [...byStart.entries()].sort((a, b) => a[0] - b[0])) {
    const used = new Set();
    for (const n of [...group].sort((a, b) => b.p - a.p)) { // 높은 음부터 높은 현에
      let best = null;
      tuning.forEach((open, idx) => {
        if (used.has(idx)) return;
        const fret = n.p - open;
        if (fret < 0 || fret > maxFret) return;
        const cost = Math.abs(fret - lastFret) + fret * 0.15 + (fret === 0 ? -0.5 : 0);
        if (!best || cost < best.cost) best = { idx, fret, cost };
      });
      if (!best) { // 음역 밖: 옥타브 이동
        const open = tuning[0]; let fret = ((n.p - open) % 12 + 12) % 12; best = { idx: 0, fret, cost: 0 };
      }
      used.add(best.idx);
      out.set(n, { string: tuning.length - best.idx, fret: best.fret });
    }
    const frets = group.map(n => out.get(n).fret).filter(f => f > 0);
    if (frets.length) lastFret = Math.round(frets.reduce((a, b) => a + b, 0) / frets.length);
  }
  return out;
}

const KIND_MAP = [
  [/^(maj7|M7|Δ7|Δ)$/, 'major-seventh'], [/^(m7b5|ø7?|m7-5)$/, 'half-diminished'], [/^(dim7|°7|o7)$/, 'diminished-seventh'],
  [/^(dim|°|o)$/, 'diminished'], [/^(aug|\+)$/, 'augmented'], [/^(sus4|sus)$/, 'suspended-fourth'], [/^sus2$/, 'suspended-second'],
  [/^(m7|min7|-7)$/, 'minor-seventh'], [/^(m9|min9)$/, 'minor-ninth'], [/^(maj9|M9)$/, 'major-ninth'], [/^9$/, 'dominant-ninth'],
  [/^(m6|min6)$/, 'minor-sixth'], [/^6$/, 'major-sixth'], [/^7$/, 'dominant'], [/^(m|min|-)$/, 'minor'], [/^(add9|2|add2)$/, 'major'],
  [/^(maj|M)?$/, 'major'],
];
export function parseChordSymbol(sym) {
  const m = String(sym).trim().match(/^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/);
  if (!m) return null;
  const suffix = m[3].trim();
  const kind = (KIND_MAP.find(([re]) => re.test(suffix)) || [null, 'major'])[1];
  return { root: m[1], rootAlter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0, suffix, kind, bass: m[4] || null, bassAlter: m[5] === '#' ? 1 : m[5] === 'b' ? -1 : 0 };
}
function harmonyXml(name) {
  const c = parseChordSymbol(name);
  if (!c) return '';
  return `<harmony print-frame="no"><root><root-step>${c.root}</root-step>${c.rootAlter ? `<root-alter>${c.rootAlter}</root-alter>` : ''}</root>` +
    `<kind text="${esc(c.suffix)}">${c.kind}</kind>` +
    (c.bass ? `<bass><bass-step>${c.bass}</bass-step>${c.bassAlter ? `<bass-alter>${c.bassAlter}</bass-alter>` : ''}</bass>` : '') + `</harmony>`;
}

/**
 * 한 보표를 마디 배열에 쓴다. events: [{start, dur, pitches|null}]
 * render(pitch, v, flags) → note xml (flags: chord, tieStart, tieStop, measureIdx, lyric)
 */
function layoutStaff({ events, staff, voice, beatsPerMeasure, measures, render, lyricFor }) {
  const measureDiv = Math.round(beatsPerMeasure * DIV);
  for (const ev of events) {
    const pieces = [];
    let s = ev.start, remain = ev.dur;
    while (remain > 1e-6) {
      const m = Math.floor(s / beatsPerMeasure + 1e-9);
      const off = s - m * beatsPerMeasure;
      const len = Math.min(beatsPerMeasure - off, remain);
      pieces.push({ m, off, len }); s += len; remain -= len;
    }
    const isRest = !ev.pitches;
    const valuePieces = [];
    for (const pc of pieces) {
      if (isRest && pc.off < 1e-6 && Math.abs(pc.len - beatsPerMeasure) < 1e-6) valuePieces.push({ m: pc.m, whole: true, start: pc.m * beatsPerMeasure });
      else { let cur = pc.m * beatsPerMeasure + pc.off; for (const v of decompose(pc.len)) { valuePieces.push({ m: pc.m, v, start: cur }); cur += v.beats; } }
    }
    valuePieces.forEach((vp, i) => {
      const target = measures[vp.m][`staff${staff}`];
      if (isRest) {
        target.push({ start: vp.start, xml: vp.whole
          ? `<note><rest measure="yes"/><duration>${measureDiv}</duration><voice>${voice}</voice><staff>${staff}</staff></note>`
          : `<note><rest/><duration>${Math.round(vp.v.beats * DIV)}</duration><voice>${voice}</voice><type>${vp.v.type}</type>${vp.v.dot ? '<dot/>' : ''}<staff>${staff}</staff></note>` });
        return;
      }
      const tieStart = i < valuePieces.length - 1, tieStop = i > 0;
      const lyric = lyricFor && !tieStop ? lyricFor(ev.pitches) : null;
      ev.pitches.forEach((pitch, j) => {
        target.push({ start: vp.start, xml: render(pitch, vp.v, { chord: j > 0, tieStart, tieStop, measureIdx: vp.m, staff, voice, evStart: ev.start, lyric: j === 0 ? lyric : null }) });
      });
    });
  }
}

function makePitchRenderer({ fifths, useFlats, written = 0, tab = null }) {
  const accState = [];
  return (pitch, v, { chord, tieStart, tieStop, measureIdx, staff, voice, evStart, lyric }) => {
    const { step, alter, octave } = pitchParts(pitch + written, useFlats);
    let accidental = '';
    if (!tab) {
      const state = accState[measureIdx] || (accState[measureIdx] = new Map());
      const k = `${staff}:${step}${octave}`;
      const cur = state.has(k) ? state.get(k) : keyAlter(step, fifths);
      if (alter !== cur) { if (!tieStop) accidental = `<accidental>${alter === 1 ? 'sharp' : alter === -1 ? 'flat' : 'natural'}</accidental>`; state.set(k, alter); }
    }
    const tieEls = (tieStart ? '<tie type="start"/>' : '') + (tieStop ? '<tie type="stop"/>' : '');
    const notations = [];
    if (tieStop) notations.push('<tied type="stop"/>');
    if (tieStart) notations.push('<tied type="start"/>');
    if (tab) { const sf = tab(pitch, evStart); if (sf) notations.push(`<technical><string>${sf.string}</string><fret>${sf.fret}</fret></technical>`); }
    return `<note>${chord ? '<chord/>' : ''}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>` +
      `<duration>${Math.round(v.beats * DIV)}</duration>${tieEls}<voice>${voice}</voice><type>${v.type}</type>${v.dot ? '<dot/>' : ''}` +
      `${accidental}<staff>${staff}</staff>${notations.length ? `<notations>${notations.join('')}</notations>` : ''}` +
      (lyric ? `<lyric number="1"><syllabic>single</syllabic><text>${esc(lyric)}</text></lyric>` : '') + `</note>`;
  };
}
function makeDrumRenderer(partId) {
  return (pieceIdx, v, { chord, voice }) => {
    const piece = DRUM_PIECES[pieceIdx];
    const d = DRUM_DISPLAY[piece];
    return `<note>${chord ? '<chord/>' : ''}<unpitched><display-step>${d.step}</display-step><display-octave>${d.octave}</display-octave></unpitched>` +
      `<duration>${Math.round(v.beats * DIV)}</duration><instrument id="${partId}-${piece}"/><voice>${voice}</voice><type>${v.type}</type>${v.dot ? '<dot/>' : ''}` +
      `${d.head !== 'normal' ? `<notehead>${d.head}</notehead>` : ''}<staff>1</staff></note>`;
  };
}

/**
 * @param parts [{id:'piano'|'bass'|'guitar'|'drums', name, notes:[{p,start,dur}] | drums:[{piece,start}], splitPitch}]
 */
export function buildMusicXML({ title, bpm, key, timeSignature, parts, chords = [], solfege: withSolfege = false, composer = '' }) {
  const [num, den] = timeSignature.split('/').map(Number);
  const beatsPerMeasure = num * (4 / den);
  const { fifths, mode } = keyToFifths(key);
  const useFlats = fifths < 0;
  const measureDiv = Math.round(beatsPerMeasure * DIV);

  let maxEnd = 0;
  for (const p of parts) for (const n of (p.notes || p.drums || [])) maxEnd = Math.max(maxEnd, n.start + (n.dur || GRID));
  for (const c of chords) maxEnd = Math.max(maxEnd, c.beat + 1);
  const measureCount = Math.max(1, Math.ceil((maxEnd - 1e-6) / beatsPerMeasure));
  const totalBeats = measureCount * beatsPerMeasure;

  const partXml = [], partList = [];
  parts.forEach((part, pi) => {
    const pid = `P${pi + 1}`;
    const measures = Array.from({ length: measureCount }, () => ({ staff1: [], staff2: [] }));
    const lyricTop = withSolfege ? (pitches) => solfege(pitches[pitches.length - 1], useFlats) : null;
    const lyricBottom = withSolfege ? (pitches) => solfege(pitches[0], useFlats) : null;
    let attrs = `<divisions>${DIV}</divisions><key><fifths>${fifths}</fifths><mode>${mode}</mode></key><time><beats>${num}</beats><beat-type>${den}</beat-type></time>`;
    let staves = 1;
    let instruments = '';

    if (part.id === 'piano') {
      staves = 2;
      const split = part.splitPitch ?? 60;
      const render = makePitchRenderer({ fifths, useFlats });
      layoutStaff({ events: toEvents(part.notes.filter(n => n.p >= split), totalBeats), staff: 1, voice: 1, beatsPerMeasure, measures, render, lyricFor: lyricTop });
      layoutStaff({ events: toEvents(part.notes.filter(n => n.p < split), totalBeats), staff: 2, voice: 2, beatsPerMeasure, measures, render, lyricFor: lyricBottom });
      attrs += `<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>`;
    } else if (part.id === 'bass' || part.id === 'guitar') {
      staves = 2;
      const tuning = part.id === 'bass' ? BASS_TUNING : GUITAR_TUNING;
      const frets = assignFrets(part.notes, tuning);
      const byPitchStart = new Map(part.notes.map(n => [`${n.start}:${n.p}`, n]));
      const render = makePitchRenderer({ fifths, useFlats });
      const events = toEvents(part.notes, totalBeats);
      layoutStaff({ events, staff: 1, voice: 1, beatsPerMeasure, measures, render, lyricFor: lyricTop });
      // TAB 보표: 같은 이벤트를 현·프렛으로
      const tabRender = makePitchRenderer({ fifths, useFlats, tab: (pitch, evStart) => { const n = byPitchStart.get(`${evStart}:${pitch}`); return n ? frets.get(n) : null; } });
      layoutStaff({ events: events.map(e => ({ ...e })), staff: 2, voice: 2, beatsPerMeasure, measures, render: tabRender, lyricFor: null });
      const clef = part.id === 'bass' ? `<clef number="1"><sign>F</sign><line>4</line><clef-octave-change>-1</clef-octave-change></clef>` : `<clef number="1"><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>`;
      attrs += `<staves>2</staves>${clef}<clef number="2"><sign>TAB</sign><line>5</line></clef><staff-details number="2"><staff-lines>${tuning.length}</staff-lines>` +
        tuning.map((p, i) => { const pp = pitchParts(p, false); return `<staff-tuning line="${i + 1}"><tuning-step>${pp.step}</tuning-step>${pp.alter ? `<tuning-alter>${pp.alter}</tuning-alter>` : ''}<tuning-octave>${pp.octave}</tuning-octave></staff-tuning>`; }).join('') + `</staff-details>`;
    } else if (part.id === 'drums') {
      const hits = part.drums.map(d => ({ p: DRUM_PIECES.indexOf(d.piece), start: d.start, dur: GRID }));
      const onsets = [...new Set(hits.map(h => h.start))].sort((a, b) => a - b);
      const nextOf = new Map(onsets.map((s, i) => [s, onsets[i + 1]]));
      for (const h of hits) { const nx = nextOf.get(h.start); h.dur = Math.max(GRID, Math.min(1, nx != null ? nx - h.start : 1)); }
      layoutStaff({ events: toEvents(hits, totalBeats), staff: 1, voice: 1, beatsPerMeasure, measures, render: makeDrumRenderer(pid) });
      attrs += `<clef><sign>percussion</sign><line>2</line></clef>`;
      instruments = DRUM_PIECES.map(pc => `<score-instrument id="${pid}-${pc}"><instrument-name>${pc}</instrument-name></score-instrument>`).join('');
    }

    // 코드 기호는 첫 파트에
    if (pi === 0 && chords.length) {
      for (const c of chords) {
        const m = Math.floor(c.beat / beatsPerMeasure);
        if (m < 0 || m >= measureCount) continue;
        const list = measures[m].staff1;
        const idx = list.findIndex(e => e.start >= c.beat - 1e-6);
        const h = { start: c.beat, xml: harmonyXml(c.name) };
        if (idx < 0) list.push(h); else list.splice(idx, 0, h);
      }
    }

    const body = measures.map((m, i) => {
      const a = i === 0 ? `<attributes>${attrs}</attributes>` + (pi === 0 ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${bpm}"/></direction>` : '') : '';
      const s1 = m.staff1.map(e => e.xml).join('');
      const s2 = staves === 2 ? `<backup><duration>${measureDiv}</duration></backup>${m.staff2.map(e => e.xml).join('')}` : '';
      return `<measure number="${i + 1}">${a}${s1}${s2}</measure>`;
    }).join('\n');
    partXml.push(`<part id="${pid}">\n${body}\n</part>`);
    partList.push(`<score-part id="${pid}"><part-name>${esc(part.name)}</part-name>${instruments}</score-part>`);
  });

  const today = new Date().toISOString().slice(0, 10);
  const shownTitle = title.length > 50 ? title.slice(0, 49).trimEnd() + '…' : title;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
<work><work-title>${esc(shownTitle)}</work-title></work>
<identification>${composer ? `<creator type="composer">${esc(composer)}</creator>` : ''}<encoding><software>Gemini Piano Transcriber</software><encoding-date>${today}</encoding-date></encoding></identification>
<part-list>${partList.join('')}</part-list>
${partXml.join('\n')}
</score-partwise>
`;
}
