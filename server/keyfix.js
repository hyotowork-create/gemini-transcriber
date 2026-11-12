// 조 보정: Gemini가 노래 곡을 통째로 옮겨 적는 문제를 바로잡는다.
// 1) 음원에서 시간 구간별 음별 에너지(크로마, 12칸)를 잰다.
// 2) 각 조각에서 Gemini 음표의 음별 분포를 만들어, 음원 크로마와 가장 잘 맞는 옮김 폭(-6~+5 반음)을 찾는다.
// 3) 확신할 수 있는 조각은 그 폭으로, 애매한 조각은 곡 전체 다수결 폭으로 음표·코드·조를 옮긴다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SR = 11025;          // 분석용 샘플레이트
const N = 8192;            // FFT 크기 (약 0.74초, 주파수 간격 1.35Hz)
const HOP = 4096;
const FMIN = 55, FMAX = 2000;

const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FLAT_MAJOR_TONICS = new Set([5, 10, 3, 8, 1, 6]);   // F Bb Eb Ab Db Gb
const FLAT_MINOR_TONICS = new Set([2, 7, 0, 5, 10, 3]);    // Dm Gm Cm Fm Bbm Ebm

// ---------- FFT (반복형 radix-2) ----------
function makeFFT(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  const re = new Float64Array(n), im = new Float64Array(n);
  return (input) => {
    for (let i = 0; i < n; i++) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const tre = re[i + j + half] * cos[k] + im[i + j + half] * sin[k];
          const tim = -re[i + j + half] * sin[k] + im[i + j + half] * cos[k];
          re[i + j + half] = re[i + j] - tre; im[i + j + half] = im[i + j] - tim;
          re[i + j] += tre; im[i + j] += tim;
        }
      }
    }
    return { re, im };
  };
}

/** 음원 → 프레임별 크로마. { hopSec, frames: Float64Array[12][] } */
export async function audioChroma(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  const x = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  const fft = makeFFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const kMin = Math.ceil(FMIN * N / SR), kMax = Math.floor(FMAX * N / SR);
  const pcOf = new Int8Array(kMax + 1);
  for (let k = kMin; k <= kMax; k++) pcOf[k] = ((Math.round(12 * Math.log2(k * SR / N / 440) + 69) % 12) + 12) % 12;
  const frames = [];
  const buf = new Float64Array(N);
  for (let s = 0; s + N <= x.length; s += HOP) {
    for (let i = 0; i < N; i++) buf[i] = x[s + i] * win[i];
    const { re, im } = fft(buf);
    const c = new Float64Array(12);
    for (let k = kMin; k <= kMax; k++) c[pcOf[k]] += re[k] * re[k] + im[k] * im[k];
    frames.push(c);
  }
  return { hopSec: HOP / SR, winSec: N / SR, frames };
}

/** [t0, t1) 구간 크로마 합 */
export function chromaBetween({ hopSec, winSec, frames }, t0, t1) {
  const c = new Float64Array(12);
  for (let i = 0; i < frames.length; i++) {
    const mid = i * hopSec + winSec / 2;
    if (mid < t0 || mid >= t1) continue;
    for (let p = 0; p < 12; p++) c[p] += frames[i][p];
  }
  return c;
}

function corr(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** 음표 → 음별 분포(길이 가중) */
export function noteHistogram(noteLists) {
  const h = new Float64Array(12);
  let count = 0;
  for (const list of noteLists) for (const n of list || []) { h[((n.p % 12) + 12) % 12] += Math.max(0.05, n.d ?? n.durSec ?? 0.25); count++; }
  return { h, count };
}

const norm = s => (((s + 6) % 12) + 12) % 12 - 6; // -6~+5

/**
 * 음원 크로마와 음표 분포를 맞대어 옮김 폭 후보를 점수순으로 낸다.
 * 반환 { shift(-6~+5): 최고 후보, best, second, confident, scoreOf(shift) }
 */
export function bestShift(chroma, hist) {
  const byShift = new Map();
  const scores = [];
  for (let s = 0; s < 12; s++) {
    const rolled = new Float64Array(12);
    for (let i = 0; i < 12; i++) rolled[(i + s) % 12] = hist[i];
    const r = corr(chroma, rolled);
    const sh = norm(s);
    byShift.set(sh, Number.isFinite(r) ? r : 0);
    scores.push({ s: sh, r: Number.isFinite(r) ? r : 0 });
  }
  scores.sort((a, b) => b.r - a.r);
  const [b, c] = scores;
  return { shift: b.s, best: b.r, second: c.r, confident: b.r >= 0.6 && b.r - c.r >= 0.08, scoreOf: s => byShift.get(norm(s)) ?? 0 };
}

/** 장조 기준 으뜸음(단조는 나란한조 장조로 바꿔 비교한다) */
function majorPc(key) {
  const k = parseKey(key);
  if (!k) return null;
  return k.minor ? (k.pc + 3) % 12 : k.pc;
}

// ---------- 옮기기 ----------
export function transposePitch(p, shift) {
  let q = p + shift;
  while (q < 21) q += 12;
  while (q > 108) q -= 12;
  return q;
}
function pcName(pc, useFlats) { return (useFlats ? NAMES_FLAT : NAMES_SHARP)[((pc % 12) + 12) % 12]; }
function rootPc(letter, acc) { return (LETTER[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + 12) % 12; }

/** "C major" → { pc, minor } */
export function parseKey(key) {
  const m = String(key || '').trim().match(/^([A-Ga-g])\s*([#♯b♭]?)\s*(major|minor|maj|min|m)?/i);
  if (!m) return null;
  const acc = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2];
  const modeRaw = (m[3] || 'major').toLowerCase();
  return { pc: rootPc(m[1].toUpperCase(), acc), minor: modeRaw.startsWith('m') && modeRaw !== 'major' && modeRaw !== 'maj' };
}
export function keyUsesFlats(key) {
  const k = parseKey(key);
  if (!k) return false;
  return k.minor ? FLAT_MINOR_TONICS.has(k.pc) : FLAT_MAJOR_TONICS.has(k.pc);
}
export function transposeKey(key, shift) {
  const k = parseKey(key);
  if (!k || !shift) return key;
  const pc = (k.pc + shift + 12) % 12;
  const flats = k.minor ? FLAT_MINOR_TONICS.has(pc) : FLAT_MAJOR_TONICS.has(pc);
  return `${pcName(pc, flats)} ${k.minor ? 'minor' : 'major'}`;
}
export function transposeChord(name, shift, useFlats) {
  if (!shift) return name;
  const m = String(name).match(/^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/);
  if (!m) return name;
  const root = pcName(rootPc(m[1], m[2]) + shift, useFlats);
  const bass = m[4] ? '/' + pcName(rootPc(m[4], m[5]) + shift, useFlats) : '';
  return root + m[3] + bass;
}

/**
 * 조각 결과들을 제자리에서 보정한다.
 * results: [{offsetSec, durationSec, key, notes, bass, guitar, chords}]  (notes의 s는 조각 기준 초, d는 길이)
 * 반환: { applied, globalShift, perChunk: [{shift, confident, best}] }
 */
export function correctKeys(results, chroma, { minNotes = 6, modulationGap = 0.25 } = {}) {
  const per = results.map(r => {
    const { h, count } = noteHistogram([r.notes, r.bass, r.guitar]);
    const c = chromaBetween(chroma, r.offsetSec, r.offsetSec + (r.durationSec || 30));
    const energy = c.reduce((a, b) => a + b, 0);
    if (count < minNotes || !(energy > 0)) return { shift: 0, confident: false, best: 0, skip: true, labelPc: majorPc(r.key), count };
    return { ...bestShift(c, h), skip: false, labelPc: majorPc(r.key), count };
  });

  // 1) 곡의 실제 조(장조 기준 으뜸음)를 다수결로: "Gemini가 적은 조 + 그 조각의 최고 옮김 폭"
  const vote = (pred) => {
    const votes = new Map();
    per.forEach(p => { if (pred(p) && p.labelPc != null) { const t = (p.labelPc + p.shift + 12) % 12; votes.set(t, (votes.get(t) || 0) + p.best * Math.sqrt(p.count)); } });
    let t = null, top = 0;
    for (const [k, v] of votes) if (v > top) { top = v; t = k; }
    return t;
  };
  const target = vote(p => !p.skip && p.confident) ?? vote(p => !p.skip && p.best >= 0.6);

  // 2) 조각별 옮김 폭: 목표 조로 맞추는 폭을 우선 쓰되, 그 점수가 최고 후보보다 크게 낮으면(전조 구간) 최고 후보를 쓴다
  per.forEach(p => {
    const toTarget = target != null && p.labelPc != null ? norm(target - p.labelPc) : null;
    if (p.skip) { p.shift = toTarget ?? 0; p.how = 'target(짧은 조각)'; return; }
    if (toTarget != null && p.scoreOf(toTarget) >= p.best - modulationGap && p.scoreOf(toTarget) >= 0.4) { p.shift = toTarget; p.how = 'target'; }
    else if (p.best >= 0.6) { p.how = 'own'; /* p.shift = 최고 후보 그대로 */ }
    else { p.shift = 0; p.how = 'none'; }
  });
  const globalShift = per.find(p => !p.skip)?.shift ?? 0;

  let applied = false;
  results.forEach((r, i) => {
    const p = per[i];
    const shift = p.shift;
    if (!shift) return;
    applied = true;
    for (const f of ['notes', 'bass', 'guitar']) if (r[f]) r[f] = r[f].map(n => ({ ...n, p: transposePitch(n.p, shift) }));
    const newKey = r.key ? transposeKey(r.key, shift) : null;
    const flats = keyUsesFlats(newKey);
    if (r.chords) r.chords = r.chords.map(c => ({ ...c, name: transposeChord(c.name, shift, flats) }));
    if (r.key) r.key = newKey;
  });
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  return {
    applied, globalShift, target: target == null ? null : `${NAMES[target]} major`,
    perChunk: per.map(p => ({ shift: p.shift, how: p.how, confident: p.confident, best: +p.best.toFixed(2) })),
  };
}
