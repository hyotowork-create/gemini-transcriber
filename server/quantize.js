// 조각별 채보 결과를 합치고 박자 격자에 맞춘다.
export const GRID = 0.25; // 16분음표 단위 (4분음표 = 1박)

function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mode(arr) {
  const count = new Map();
  for (const v of arr) if (v) count.set(v, (count.get(v) || 0) + 1);
  let best = null, n = 0;
  for (const [v, c] of count) if (c > n) { best = v; n = c; }
  return best;
}
export function normalizeTimeSignature(ts) {
  const m = String(ts || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return '4/4';
  const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
  if (![1, 2, 4, 8, 16].includes(den) || num < 1 || num > 16) return '4/4';
  return `${num}/${den}`;
}

/** 초 단위 음표 목록 → 박 격자 음표 (같은 음 겹침 정리 포함) */
export function quantizeNotes(raw, secPerBeat, grid = GRID) {
  const notes = raw.map(n => ({
    p: n.p,
    start: Math.round(n.startSec / secPerBeat / grid) * grid,
    dur: Math.max(grid, Math.round(n.durSec / secPerBeat / grid) * grid),
  }));
  notes.sort((a, b) => a.start - b.start || a.p - b.p || b.dur - a.dur);
  const out = [];
  const lastByPitch = new Map();
  for (const n of notes) {
    const prev = lastByPitch.get(n.p);
    if (prev && prev.start === n.start) continue;
    if (prev && prev.start + prev.dur > n.start) prev.dur = Math.max(grid, n.start - prev.start);
    out.push(n);
    lastByPitch.set(n.p, n);
  }
  for (const n of out) { n.startSec = +(n.start * secPerBeat).toFixed(3); n.durSec = +(n.dur * secPerBeat).toFixed(3); }
  return out;
}

/**
 * @param chunks [{offsetSec, bpm, key, timeSignature, notes, bass, guitar, drums, chords, lyrics}]
 * @returns {bpm, key, timeSignature, parts:{piano,bass,guitar,drums}, chords, lyrics}
 */
export function mergeAndQuantize(chunks, opts = {}) {
  let bpm = opts.bpmOverride || median(chunks.map(c => c.bpm)) || 120;
  bpm = Math.round(Math.min(240, Math.max(40, bpm)));
  const key = mode(chunks.map(c => c.key)) || 'C major';
  const timeSignature = normalizeTimeSignature(mode(chunks.map(c => c.timeSignature)));
  const secPerBeat = 60 / bpm;

  const collect = (field) => chunks.flatMap(c => (c[field] || []).map(n => ({ p: n.p, startSec: c.offsetSec + n.s, durSec: n.d })));
  const parts = {};
  for (const id of ['piano', 'bass', 'guitar']) {
    const field = id === 'piano' ? 'notes' : id;
    const raw = collect(field);
    if (raw.length) parts[id] = quantizeNotes(raw, secPerBeat);
  }
  // 드럼: 시작만 16분음표 격자에, 같은 자리 같은 악기는 하나로
  const drumRaw = chunks.flatMap(c => (c.drums || []).map(d => ({ piece: d.piece, startSec: c.offsetSec + d.s })));
  if (drumRaw.length) {
    const seen = new Set(); const drums = [];
    for (const d of drumRaw) {
      const start = Math.round(d.startSec / secPerBeat / GRID) * GRID;
      const k = `${d.piece}@${start}`;
      if (seen.has(k)) continue;
      seen.add(k);
      drums.push({ piece: d.piece, start, startSec: +(start * secPerBeat).toFixed(3) });
    }
    drums.sort((a, b) => a.start - b.start);
    parts.drums = drums;
  }
  // 코드: 박 단위로 맞추고 연속 중복 제거
  const chords = [];
  for (const c of chunks) for (const ch of c.chords || []) {
    const beat = Math.round((c.offsetSec + ch.s) / secPerBeat);
    const last = chords[chords.length - 1];
    if (last && last.beat === beat) { last.name = ch.name; continue; }
    if (last && last.name === ch.name) continue;
    chords.push({ beat, startSec: +(beat * secPerBeat).toFixed(3), name: ch.name });
  }
  chords.sort((a, b) => a.beat - b.beat);
  const lyrics = [];
  for (const c of chunks) for (const l of c.lyrics || []) {
    const startSec = +(c.offsetSec + l.s).toFixed(3);
    lyrics.push({ startSec, beat: +(startSec / secPerBeat).toFixed(2), text: l.text });
  }
  lyrics.sort((a, b) => a.startSec - b.startSec);
  return { bpm, key, timeSignature, parts, chords, lyrics };
}

/** 쉬운 버전: 멜로디(가장 높은 음) + 코드 근음. 8분음표 격자 */
export function buildEasyNotes({ parts, chords, bpm, timeSignature }, splitPitch = 60) {
  const src = parts.piano || parts.guitar || [];
  const [num, den] = timeSignature.split('/').map(Number);
  const beatsPerMeasure = num * (4 / den);
  const grid = 0.5;
  // 멜로디: 시작 시각별로 splitPitch 이상 중 가장 높은 음
  const byStart = new Map();
  for (const n of src) {
    if (n.p < splitPitch) continue;
    const s = Math.round(n.start / grid) * grid;
    const cur = byStart.get(s);
    if (!cur || n.p > cur.p) byStart.set(s, { p: n.p, start: s, dur: n.dur });
  }
  const melody = [...byStart.values()].sort((a, b) => a.start - b.start);
  melody.forEach((n, i) => {
    const next = melody[i + 1];
    let dur = Math.max(grid, Math.round(n.dur / grid) * grid);
    if (next) dur = Math.min(dur, next.start - n.start);
    n.dur = Math.min(4, Math.max(grid, dur));
  });
  // 베이스: 코드 근음을 다음 코드까지 (없으면 원곡 저음 중 가장 낮은 음을 마디마다)
  const bass = [];
  const total = Math.max(
    melody.reduce((m, n) => Math.max(m, n.start + n.dur), 0),
    src.reduce((m, n) => Math.max(m, n.start + n.dur), 0));
  if (chords.length) {
    chords.forEach((c, i) => {
      const root = chordRootPitch(c.name);
      if (root == null) return;
      const end = chords[i + 1] ? chords[i + 1].beat : Math.ceil(total / beatsPerMeasure) * beatsPerMeasure;
      if (end > c.beat) bass.push({ p: root, start: c.beat, dur: end - c.beat });
    });
  } else {
    const measures = Math.ceil(total / beatsPerMeasure);
    for (let m = 0; m < measures; m++) {
      const lows = src.filter(n => n.p < splitPitch && n.start >= m * beatsPerMeasure && n.start < (m + 1) * beatsPerMeasure);
      if (lows.length) bass.push({ p: Math.min(...lows.map(n => n.p)), start: m * beatsPerMeasure, dur: beatsPerMeasure });
    }
  }
  const secPerBeat = 60 / bpm;
  const all = [...melody, ...bass].map(n => ({ ...n, startSec: +(n.start * secPerBeat).toFixed(3), durSec: +(n.dur * secPerBeat).toFixed(3) }));
  return all.sort((a, b) => a.start - b.start || a.p - b.p);
}

const ROOT_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function chordRootPitch(name) {
  const m = String(name).match(/^([A-G])([#b]?)/);
  if (!m) return null;
  let st = ROOT_SEMITONE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  // 슬래시 코드면 베이스 음을 쓴다
  const slash = String(name).match(/\/([A-G])([#b]?)$/);
  if (slash) st = ROOT_SEMITONE[slash[1]] + (slash[2] === '#' ? 1 : slash[2] === 'b' ? -1 : 0);
  st = ((st % 12) + 12) % 12;
  return 36 + st; // C2~B2
}
