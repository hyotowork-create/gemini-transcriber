import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAndQuantize, buildEasyNotes, chordRootPitch } from '../server/quantize.js';
import { buildMusicXML, keyToFifths, parseChordSymbol, assignFrets, GUITAR_TUNING } from '../server/musicxml.js';
import { buildMidi } from '../server/midi.js';
import { parseChords, parseLyrics, parseDrums } from '../server/gemini.js';

const chunk = {
  offsetSec: 0, bpm: 120, key: 'G major', timeSignature: '4/4',
  notes: [
    { p: 67, s: 0, d: 0.5 }, { p: 71, s: 0, d: 0.5 }, { p: 74, s: 0, d: 0.5 },
    { p: 72, s: 0.5, d: 0.25 }, { p: 73, s: 0.75, d: 0.25 },
    { p: 79, s: 1.0, d: 2.5 },
    { p: 43, s: 0, d: 2.0 }, { p: 43, s: 2.0, d: 2.0 }, { p: 41, s: 4.0, d: 1.0 },
  ],
  bass: [{ p: 31, s: 0, d: 1.9 }, { p: 38, s: 2, d: 1.9 }],
  guitar: [{ p: 55, s: 0, d: 0.4 }, { p: 59, s: 0, d: 0.4 }, { p: 62, s: 0, d: 0.4 }, { p: 67, s: 0.5, d: 0.4 }],
  drums: [{ s: 0, piece: 'kick' }, { s: 0, piece: 'hihat' }, { s: 0.5, piece: 'hihat' }, { s: 1, piece: 'snare' }, { s: 1, piece: 'hihat' }],
  chords: [{ s: 0, name: 'G' }, { s: 2, name: 'D/F#' }, { s: 4, name: 'Em7' }],
  lyrics: [{ s: 0.2, text: '나는 예배자입니다' }],
};

test('키·코드 해석', () => {
  assert.equal(keyToFifths('G major').fifths, 1);
  assert.equal(keyToFifths('Bb major').fifths, -2);
  assert.equal(keyToFifths('D# minor').fifths, -6);
  assert.deepEqual(parseChordSymbol('F#m7'), { root: 'F', rootAlter: 1, suffix: 'm7', kind: 'minor-seventh', bass: null, bassAlter: 0 });
  assert.equal(parseChordSymbol('D/F#').bass, 'F');
  assert.equal(chordRootPitch('Em7'), 40);
  assert.equal(chordRootPitch('D/F#'), 42);
});

test('Gemini 텍스트 파싱', () => {
  assert.equal(parseChords('0.00 G\n2.40 D/F#\nxx').length, 2);
  assert.equal(parseLyrics('1.5 hello world')[0].text, 'hello world');
  assert.deepEqual(parseDrums('0.00 kick\n0.5 cowbell\n1.0 HiHat'), [{ s: 0, piece: 'kick' }, { s: 1, piece: 'hihat' }]);
});

test('합치기·양자화·쉬운 버전', () => {
  const m = mergeAndQuantize([chunk]);
  assert.equal(m.bpm, 120);
  assert.equal(m.parts.piano.length, 9);
  assert.equal(m.parts.bass.length, 2);
  assert.equal(m.parts.drums.length, 5);
  assert.equal(m.chords.length, 3);
  assert.equal(m.chords[1].beat, 4);
  assert.equal(m.lyrics[0].text, '나는 예배자입니다');
  const easy = buildEasyNotes(m);
  assert.ok(easy.some(n => n.p === 74 && n.start === 0)); // 멜로디 = 가장 높은 음
  assert.ok(easy.some(n => n.p === 43 && n.start === 0)); // G 근음
});

test('TAB 현·프렛 배정', () => {
  const notes = [{ p: 40, start: 0, dur: 1 }, { p: 64, start: 1, dur: 1 }, { p: 55, start: 2, dur: 1 }, { p: 59, start: 2, dur: 1 }];
  const f = assignFrets(notes, GUITAR_TUNING);
  assert.deepEqual(f.get(notes[0]), { string: 6, fret: 0 });
  assert.deepEqual(f.get(notes[1]), { string: 1, fret: 0 });
  assert.notEqual(f.get(notes[2]).string, f.get(notes[3]).string);
});

test('MusicXML 여러 파트 + 코드 + 계이름', () => {
  const m = mergeAndQuantize([chunk]);
  const parts = ['piano', 'bass', 'guitar', 'drums'].map(id => ({ id, name: id, notes: m.parts[id], drums: m.parts[id], splitPitch: 60 }));
  const xml = buildMusicXML({ title: 'T<est>', bpm: m.bpm, key: m.key, timeSignature: m.timeSignature, parts, chords: m.chords, solfege: true });
  assert.match(xml, /<work-title>T&lt;est&gt;<\/work-title>/);
  assert.equal((xml.match(/<part id=/g) || []).length, 4);
  assert.match(xml, /<harmony[^>]*><root><root-step>D<\/root-step><\/root><kind text="">major<\/kind><bass><bass-step>F<\/bass-step><bass-alter>1<\/bass-alter><\/bass><\/harmony>/);
  assert.match(xml, /<kind text="m7">minor-seventh<\/kind>/);
  assert.match(xml, /<lyric number="1"><syllabic>single<\/syllabic><text>레<\/text><\/lyric>/);
  assert.match(xml, /<sign>TAB<\/sign>/);
  assert.match(xml, /<technical><string>\d<\/string><fret>\d+<\/fret><\/technical>/);
  assert.match(xml, /<sign>percussion<\/sign>/);
  assert.match(xml, /<unpitched><display-step>F<\/display-step><display-octave>4<\/display-octave><\/unpitched>/);
  assert.match(xml, /<notehead>x<\/notehead>/);
  assert.match(xml, /<tie type="start"\/>/);
});

test('MIDI 여러 파트', () => {
  const m = mergeAndQuantize([chunk]);
  const parts = ['piano', 'bass', 'drums'].map(id => ({ id, name: id, notes: m.parts[id], drums: m.parts[id], splitPitch: 60 }));
  const buf = buildMidi({ bpm: m.bpm, timeSignature: m.timeSignature, parts, title: 'x' });
  assert.equal(buf.subarray(0, 4).toString(), 'MThd');
  assert.equal(buf.readUInt16BE(10), 5); // 템포 + 양손 2 + 베이스 + 드럼
});
