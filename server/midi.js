// 표준 MIDI 파일(format 1). 트랙 0: 템포. 이후 파트별 트랙 (피아노는 양손 2트랙, 드럼은 10번 채널)
import { DRUM_PIECES } from './gemini.js';
const PPQ = 480;
const GM_DRUM = { kick: 36, snare: 38, hihat: 42, hihat_open: 46, tom_hi: 50, tom_mid: 47, tom_low: 45, crash: 49, ride: 51 };
const PROGRAM = { piano: 0, bass: 33, guitar: 25 };

function vlq(n) { const b = [n & 0x7f]; n >>>= 7; while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>>= 7; } return b; }
function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u16(n) { return [(n >>> 8) & 255, n & 255]; }
function str(s) { return [...Buffer.from(s, 'utf8')]; }
function meta(type, bytes) { return [0xff, type, ...vlq(bytes.length), ...bytes]; }

function trackBytes(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out = [];
  let last = 0;
  for (const e of events) { out.push(...vlq(Math.max(0, e.tick - last)), ...e.data); last = e.tick; }
  out.push(0x00, 0xff, 0x2f, 0x00);
  return [...str('MTrk'), ...u32(out.length), ...out];
}
function noteTrack(name, ch, program, notes, pitchOf, durOf) {
  const ev = [{ tick: 0, order: 0, data: meta(0x03, str(name)) }];
  if (program != null) ev.push({ tick: 0, order: 1, data: [0xc0 | ch, program] });
  for (const n of notes) {
    const on = Math.round(n.start * PPQ);
    const off = Math.max(on + 1, Math.round((n.start + durOf(n)) * PPQ));
    ev.push({ tick: on, order: 2, data: [0x90 | ch, pitchOf(n), 80] });
    ev.push({ tick: off, order: 1, data: [0x80 | ch, pitchOf(n), 0] });
  }
  return trackBytes(ev);
}

/** parts: [{id, name, notes | drums, splitPitch}] */
export function buildMidi({ bpm, timeSignature, parts, title = '' }) {
  const [num, den] = timeSignature.split('/').map(Number);
  const tempo = Math.round(60_000_000 / bpm);
  const tracks = [trackBytes([
    { tick: 0, order: 0, data: meta(0x03, str(title)) },
    { tick: 0, order: 1, data: [0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] },
    { tick: 0, order: 2, data: [0xff, 0x58, 0x04, num, Math.log2(den), 24, 8] },
  ])];
  let ch = 0;
  for (const part of parts) {
    if (part.id === 'drums') {
      tracks.push(noteTrack('Drums', 9, null, part.drums, d => GM_DRUM[d.piece] || 38, () => 0.25));
      continue;
    }
    const nextCh = () => { const c = ch++; return c === 9 ? ch++ : c; };
    if (part.id === 'piano') {
      const split = part.splitPitch ?? 60;
      const c1 = nextCh(), c2 = nextCh();
      tracks.push(noteTrack('Piano right hand', c1, 0, part.notes.filter(n => n.p >= split), n => n.p, n => n.dur));
      tracks.push(noteTrack('Piano left hand', c2, 0, part.notes.filter(n => n.p < split), n => n.p, n => n.dur));
    } else {
      tracks.push(noteTrack(part.name, nextCh(), PROGRAM[part.id] ?? 0, part.notes, n => n.p, n => n.dur));
    }
  }
  const header = [...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)];
  return Buffer.from([...header, ...tracks.flat()]);
}
export { DRUM_PIECES };
