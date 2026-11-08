// Gemini API 호출: (1) 오디오 조각 채보 (2) 곡 해설
import fs from 'node:fs/promises';
import { GoogleGenAI, Type } from '@google/genai';

export const PART_IDS = ['piano', 'bass', 'guitar', 'drums'];
export const DRUM_PIECES = ['kick', 'snare', 'hihat', 'hihat_open', 'tom_hi', 'tom_mid', 'tom_low', 'crash', 'ride'];

function buildSchema(parts) {
  const props = {
    bpm: { type: Type.NUMBER, description: 'estimated tempo in beats per minute' },
    key: { type: Type.STRING, description: 'musical key, e.g. "C major" or "A minor"' },
    timeSignature: { type: Type.STRING, description: 'e.g. "4/4"' },
    chords: { type: Type.STRING, description: 'one chord change per line: "<onset_seconds> <chord_symbol>"' },
    lyrics: { type: Type.STRING, description: 'one sung phrase per line: "<onset_seconds> <words>"; empty if no vocals' },
  };
  const noteDesc = 'one note per line: "<midi_pitch> <onset_seconds> <duration_seconds>"';
  if (parts.includes('piano')) props.notes = { type: Type.STRING, description: 'piano notes, ' + noteDesc };
  if (parts.includes('bass')) props.bass = { type: Type.STRING, description: 'bass guitar notes, ' + noteDesc };
  if (parts.includes('guitar')) props.guitar = { type: Type.STRING, description: 'acoustic guitar notes, ' + noteDesc };
  if (parts.includes('drums')) props.drums = { type: Type.STRING, description: 'drum hits, one per line: "<onset_seconds> <piece>"' };
  return { type: Type.OBJECT, properties: props, required: Object.keys(props) };
}

function buildPrompt({ offsetSec, durationSec, hint, parts, stemLabel }) {
  const lines = [
    'You are an expert automatic music transcription system.',
    stemLabel
      ? `This audio is the isolated "${stemLabel}" stem of a song, ${durationSec.toFixed(1)} seconds long, starting at ${offsetSec.toFixed(1)} s of the full track.`
      : `This audio is a ${durationSec.toFixed(1)}-second segment of a longer recording, starting at ${offsetSec.toFixed(1)} s of the full track.`,
    hint ? `Hint from the user: ${hint}` : '',
    'All times are in seconds from the START OF THIS SEGMENT (0.00 = segment start), with two decimals. Sort every list by onset. Include events cut off at the segment edges. If a part is silent or absent in this segment, return an empty string for it.',
    'Return JSON with these fields:',
    '- bpm: estimated tempo (number). key: like "C major" or "F# minor". timeSignature: like "4/4" or "3/4".',
    '- chords: the harmony as chord symbols, one line per chord change: "<onset_seconds> <symbol>" using symbols like C, G7, Am, F#m7, Dsus4, Bb/D. Give the actual sounding chords of the song.',
    '- lyrics: if there is singing, the sung words, one short phrase (a few words) per line: "<onset_seconds> <words>" in the original language. Empty string if no vocals.',
  ];
  const noteFmt = 'one note per line "<midi_pitch> <onset_seconds> <duration_seconds>" (60 = middle C, duration minimum 0.05, chords = several lines with the same onset)';
  if (parts.includes('piano')) lines.push(
    `- notes: a PIANO ARRANGEMENT of everything that sounds, ${noteFmt}. The MELODY (the most prominent line, or the sung vocal line) is the most important part: transcribe it note by note for the WHOLE segment and never skip bars. Then add the accompaniment (chords, bass line, arpeggios) underneath, as a pianist would play it.`);
  if (parts.includes('bass')) lines.push(
    `- bass: the BASS GUITAR (or bass line) only, ${noteFmt}. Pitches are usually MIDI 28–55. One note at a time.`);
  if (parts.includes('guitar')) lines.push(
    `- guitar: the ACOUSTIC GUITAR part only, ${noteFmt}. Pitches usually MIDI 40–76. For strummed chords write all chord tones with the same onset; for arpeggios write the individual notes.`);
  if (parts.includes('drums')) lines.push(
    `- drums: every DRUM hit, one per line "<onset_seconds> <piece>" where piece is one of: ${DRUM_PIECES.join(', ')}. Include the hi-hat/ride pattern, kick and snare, fills and crashes.`);
  return lines.filter(Boolean).join('\n');
}

const NOTE_RE = /^(\d{1,3})[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/;
export function parseNotes(text) {
  const notes = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.trim().match(NOTE_RE);
    if (!m) continue;
    const p = parseInt(m[1], 10), s = parseFloat(m[2]), d = parseFloat(m[3]);
    if (p < 21 || p > 108 || !(s >= 0) || !(d > 0)) continue;
    notes.push({ p, s, d });
  }
  return notes;
}
function parseTimed(text, re, map) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.trim().match(re);
    if (!m) continue;
    const v = map(m);
    if (v) out.push(v);
  }
  return out;
}
export const parseChords = t => parseTimed(t, /^(\d+(?:\.\d+)?)\s+([A-G][#b♯♭]?[^\s]*)/, m => ({ s: parseFloat(m[1]), name: m[2].replace('♯', '#').replace('♭', 'b') }));
export const parseLyrics = t => parseTimed(t, /^(\d+(?:\.\d+)?)\s+(.+)$/, m => ({ s: parseFloat(m[1]), text: m[2].trim() }));
export const parseDrums = t => parseTimed(t, /^(\d+(?:\.\d+)?)\s+([a-z_]+)/i, m => DRUM_PIECES.includes(m[2].toLowerCase()) ? { s: parseFloat(m[1]), piece: m[2].toLowerCase() } : null);

function mockChunk({ offsetSec, durationSec }, parts) {
  const notes = [], bass = [], guitar = [], drums = [], chords = [], lyrics = [];
  const pattern = [60, 64, 67, 72, 67, 64];
  const roots = [{ p: 48, n: 'C' }, { p: 43, n: 'G' }, { p: 45, n: 'Am' }, { p: 41, n: 'F' }];
  let i = 0;
  for (let t = 0; t < durationSec - 0.05; t += 0.5, i++) {
    notes.push({ p: pattern[i % pattern.length], s: +t.toFixed(2), d: 0.45 });
    const r = roots[Math.floor(i / 4) % roots.length];
    if (i % 4 === 0) { notes.push({ p: r.p, s: +t.toFixed(2), d: 1.9 }); chords.push({ s: +t.toFixed(2), name: r.n }); bass.push({ p: r.p - 12, s: +t.toFixed(2), d: 1.9 }); guitar.push({ p: r.p + 12, s: +t.toFixed(2), d: 0.4 }, { p: r.p + 16, s: +t.toFixed(2), d: 0.4 }, { p: r.p + 19, s: +t.toFixed(2), d: 0.4 }); }
    if (i % 8 === 0) lyrics.push({ s: +t.toFixed(2), text: `가사 ${Math.floor((offsetSec + t) / 4) + 1}` });
    drums.push({ s: +t.toFixed(2), piece: 'hihat' });
    if (i % 2 === 0) drums.push({ s: +t.toFixed(2), piece: i % 4 === 0 ? 'kick' : 'snare' });
  }
  return { bpm: 120, key: 'C major', timeSignature: '4/4', notes, bass, guitar, drums, chords, lyrics, raw: null };
}

const RETRYABLE = /(429|500|503|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|fetch failed|ECONNRESET)/i;

export async function transcribeChunk(chunk, { apiKey, model, hint, mock, signal, parts = ['piano'], stemLabel = null, log = () => {} }) {
  if (mock) return mockChunk(chunk, parts);
  if (!apiKey) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다 (.env 파일을 확인하세요)');

  const ai = new GoogleGenAI({ apiKey });
  const data = (await fs.readFile(chunk.filePath)).toString('base64');
  const prompt = buildPrompt({ ...chunk, hint, parts, stemLabel });

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/mpeg', data } }, { text: prompt }] }],
        config: { responseMimeType: 'application/json', responseSchema: buildSchema(parts), temperature: 0, maxOutputTokens: 65536, abortSignal: signal },
      });
      const text = res.text;
      if (!text) throw new Error('Gemini가 빈 응답을 돌려줬습니다');
      let parsed;
      try { parsed = JSON.parse(text); }
      catch {
        parsed = {};
        for (const k of ['bpm', 'key', 'timeSignature', 'notes', 'bass', 'guitar', 'drums', 'chords', 'lyrics']) {
          const m = text.match(new RegExp(`"${k}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"?|[\\d.]+)`));
          if (m) parsed[k] = m[1].startsWith('"') ? m[1].slice(1).replace(/"$/, '').replace(/\\n/g, '\n') : parseFloat(m[1]);
        }
        log(`조각 ${chunk.index + 1}: JSON이 잘려서 부분 복구`);
      }
      return {
        bpm: Number(parsed.bpm) || null,
        key: parsed.key || null,
        timeSignature: parsed.timeSignature || null,
        notes: parts.includes('piano') ? parseNotes(parsed.notes) : [],
        bass: parts.includes('bass') ? parseNotes(parsed.bass) : [],
        guitar: parts.includes('guitar') ? parseNotes(parsed.guitar) : [],
        drums: parts.includes('drums') ? parseDrums(parsed.drums) : [],
        chords: parseChords(parsed.chords),
        lyrics: parseLyrics(parsed.lyrics),
        raw: text,
      };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (signal?.aborted) throw new Error('cancelled');
      if (attempt < 4 && RETRYABLE.test(msg)) {
        const wait = 2000 * attempt;
        log(`조각 ${chunk.index + 1}: ${msg.slice(0, 80)} → ${wait / 1000}초 후 재시도`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** 비전공자용 곡 해설 (오디오 없이 메타데이터만으로) */
export async function describeSong(info, { apiKey, model, mock, signal }) {
  if (mock) return { summary: `${info.key}, ${info.timeSignature}, ${info.bpm} BPM의 곡입니다. (모의 모드)`, structure: '코드 4개가 반복됩니다.', difficulty: '쉬움', tips: '왼손은 근음만 눌러도 됩니다.' };
  const ai = new GoogleGenAI({ apiKey });
  const schema = {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING }, structure: { type: Type.STRING }, difficulty: { type: Type.STRING }, tips: { type: Type.STRING },
    },
    required: ['summary', 'structure', 'difficulty', 'tips'],
  };
  const prompt = [
    '당신은 음악을 전공하지 않은 사람에게 곡을 쉽게 설명해 주는 친절한 선생님입니다. 아래는 자동 채보 결과의 요약입니다. 한국어로, 전문 용어는 꼭 필요할 때만 쓰고 괄호로 뜻을 덧붙여 설명하세요.',
    `제목: ${info.title}`,
    `길이: ${Math.round(info.duration)}초, 조: ${info.key}, 박자: ${info.timeSignature}, 템포: 약 ${info.bpm} BPM`,
    `코드 진행(마디 순): ${info.chordProgression || '(없음)'}`,
    `파트별 음 수: ${info.partCounts}`,
    info.lyricsSample ? `가사 일부: ${info.lyricsSample}` : '가사 없음(연주곡으로 보임)',
    '다음 JSON 필드를 채우세요:',
    '- summary: 이 곡이 어떤 분위기·빠르기·조성인지 2~3문장. 조성은 "G장조(솔이 으뜸음)"처럼 풀어서.',
    '- structure: 코드 진행이 어떻게 반복되는지, 곡이 몇 부분으로 나뉘는지 2~3문장. 코드가 몇 개인지, 가장 많이 나오는 코드는 무엇인지.',
    '- difficulty: "쉬움 / 보통 / 어려움" 중 하나와 이유 한 문장.',
    '- tips: 피아노나 기타로 따라 치려는 초보자를 위한 실용 팁 2~3문장 (예: 왼손은 근음만, 코드 4개만 익히면 됨, 어느 구간이 어려운지).',
  ].join('\n');
  const res = await ai.models.generateContent({
    model, contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.4, abortSignal: signal },
  });
  try { return JSON.parse(res.text); } catch { return { summary: res.text?.slice(0, 500) || '', structure: '', difficulty: '', tips: '' }; }
}
