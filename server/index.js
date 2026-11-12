// Gemini 채보 웹앱 서버
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createJob, getJob, publicView, persistJob, restoreJobs } from './jobs.js';
import { downloadFromUrl, probeDuration, makePlayback, splitChunks, hasBinary } from './audio.js';
import { transcribeChunk, describeSong, validateKey, PART_IDS } from './gemini.js';
import { maskKey, isPrivateAddress, saveKey } from './settings.js';
import { mergeAndQuantize, buildEasyNotes } from './quantize.js';
import { buildMidi } from './midi.js';
import { buildMusicXML } from './musicxml.js';
import { separateStems, demucsAvailable } from './stems.js';
import { audioChroma, correctKeys } from './keyfix.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env 없음 */ }

const PORT = Number(process.env.PORT) || 3000;
let HTTPS_PORT = Number(process.env.HTTPS_PORT) || 443;
const REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT) || 80;
const DATA = path.join(ROOT, 'data');
const MAX_DURATION_SEC = 15 * 60;
const MOCK = process.env.MOCK_GEMINI === '1';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const PART_NAMES = { piano: 'Piano', bass: 'Bass', guitar: 'Guitar', drums: 'Drums' };
const PART_LABELS = { piano: '피아노', bass: '베이스', guitar: '기타', drums: '드럼' };

await fs.mkdir(path.join(DATA, 'uploads'), { recursive: true });
await fs.mkdir(path.join(DATA, 'jobs'), { recursive: true });
console.log(`이전 작업 ${await restoreJobs(path.join(DATA, 'jobs'))}개 복원`);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// 화면 파일은 매번 새것인지 확인하게 한다(앱을 고친 뒤 휴대폰 사파리가 옛 화면을 붙잡지 않게)
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
const upload = multer({ dest: path.join(DATA, 'uploads'), limits: { fileSize: 200 * 1024 * 1024 } });

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
function lanUrls() { return lanIps().map(ip => `http://${ip}:${PORT}`); }
function lanHttpsUrls() { return httpsReady ? lanIps().map(ip => `https://${ip}${HTTPS_PORT === 443 ? '' : ':' + HTTPS_PORT}`) : []; }
function lanPhoneUrls() { return httpsReady && REDIRECT_PORT === 80 && redirectReady ? lanIps().map(ip => `http://${ip}`) : lanHttpsUrls(); }
let redirectReady = false;
let httpsReady = false;

/** 휴대폰 공유 창(Web Share API)은 https에서만 열리므로 자체 서명 인증서를 만들어 https도 띄운다 */
async function ensureCert() {
  const dir = path.join(DATA, 'certs');
  await fs.mkdir(dir, { recursive: true });
  const ips = lanIps();
  const tag = (ips.join('_') || 'local') + '_v2'; // v2: 아이폰 규칙(서버 인증 용도·398일 이하·CA 아님)에 맞춘 인증서
  const key = path.join(dir, `${tag}.key`), crt = path.join(dir, `${tag}.crt`);
  try { await fs.access(key); await fs.access(crt); return { key, crt }; } catch { /* 새로 만든다 */ }
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map(ip => `IP:${ip}`)].join(',');
  // 아이폰(iOS)은 서버 인증서에 extendedKeyUsage=serverAuth가 없거나 유효기간이 길면 "방문"을 눌러도 연결을 끊는다
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '397', '-keyout', key, '-out', crt,
    '-subj', `/CN=${ips[0] || 'localhost'}`,
    '-addext', `subjectAltName=${san}`,
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth']);
  return { key, crt };
}

app.get('/api/health', async (req, res) => {
  res.json({
    lan: lanUrls(), lanHttps: lanHttpsUrls(), phone: lanPhoneUrls(), ok: true, hasKey: Boolean(process.env.GEMINI_API_KEY), keyHint: maskKey(process.env.GEMINI_API_KEY), mock: MOCK, model: DEFAULT_MODEL,
    ytdlp: await hasBinary('yt-dlp'), ffmpeg: await hasBinary('ffmpeg'), demucs: await demucsAvailable(ROOT),
  });
});

// 화면에서 API 키 바꾸기: 같은 네트워크에서 온 요청만, 저장 전에 키를 검사, 응답에는 끝 4자리만
app.post('/api/settings/key', async (req, res) => {
  const ip = req.socket.remoteAddress;
  if (!isPrivateAddress(ip)) return res.status(403).json({ error: '같은 와이파이·핫스팟에서만 키를 바꿀 수 있습니다.' });
  const key = String(req.body?.key || '');
  try {
    const r = await saveKey(ROOT, key, k => validateKey(k));
    if (!r.ok) return res.status(400).json({ error: r.error });
    console.log(`API 키를 화면에서 바꿨습니다 (${r.hint}, 요청: ${ip})`);
    res.json({ ok: true, keyHint: r.hint, warning: r.warning });
  } catch (e) {
    res.status(500).json({ error: '저장하지 못했습니다: ' + String(e.message).slice(0, 80) });
  }
});

app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  req.body = req.body || {};
  const url = (req.body.url || '').trim();
  if (!req.file && !url) return res.status(400).json({ error: '음악 파일이나 유튜브 URL 중 하나는 필요합니다' });
  if (!MOCK && !process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'Gemini API 키가 없습니다. 화면 위쪽 「설정 · Gemini API 키」에서 키를 넣어 주세요.' });

  let parts = String(req.body.parts || 'piano').split(',').map(s => s.trim()).filter(p => PART_IDS.includes(p));
  if (!parts.length) parts = ['piano'];
  const opts = {
    model: (req.body.model || DEFAULT_MODEL).trim(),
    bpmOverride: Number(req.body.bpm) > 0 ? Number(req.body.bpm) : null,
    chunkSec: Math.min(60, Math.max(10, Number(req.body.chunkSec) || 30)),
    splitPitch: Math.min(84, Math.max(36, Number(req.body.splitPitch) || 60)),
    hint: (req.body.hint || '').trim().slice(0, 300),
    parts,
    stems: req.body.stems === '1' || req.body.stems === 'true',
  };
  const job = createJob({ title: req.file ? path.parse(req.file.originalname).name : '' });
  job.dir = path.join(DATA, 'jobs', job.id);
  await fs.mkdir(job.dir, { recursive: true });
  job.abort = new AbortController();
  res.json({ jobId: job.id });
  runPipeline(job, { file: req.file, url, ...opts }).catch(err => {
    if (job.cancelled) { job.status = 'cancelled'; job.message = '중지됨'; log(job, '사용자가 중지했습니다'); return; }
    job.status = 'error';
    job.error = String(err?.message || err);
    job.message = '실패: ' + job.error;
    console.error(`[job ${job.id}]`, err);
  });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '작업이 없습니다' });
  if (['done', 'error', 'cancelled'].includes(job.status)) return res.json({ ok: true, status: job.status });
  job.cancelled = true;
  job.message = '중지하는 중';
  job.abort?.abort();
  res.json({ ok: true, status: 'cancelling' });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '작업이 없습니다' });
  res.json(publicView(job));
});

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'transcription';
}
function attach(res, req, name, type) {
  res.setHeader('Content-Type', type);
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
}
/** 요청 옵션(easy, solfege)에 맞는 파트 목록 */
function partsFor(job, { easy }) {
  const r = job.result;
  if (easy) return [{ id: 'piano', name: 'Piano (easy)', notes: r.easy, splitPitch: r.splitPitch }];
  return r.partIds.map(id => ({ id, name: PART_NAMES[id], notes: r.parts[id], drums: r.parts[id], splitPitch: r.splitPitch }));
}

app.get('/api/jobs/:id/audio', (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.files?.playback) return res.status(404).json({ error: '파일이 없습니다' });
  attach(res, req, `${safeName(job.title)}.mp3`, 'audio/mpeg');
  res.sendFile(job.files.playback);
});
app.get('/api/jobs/:id/musicxml', (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.result) return res.status(404).json({ error: '결과가 없습니다' });
  const easy = req.query.easy === '1', solfege = req.query.solfege === '1';
  const r = job.result;
  const xml = buildMusicXML({ title: r.title + (easy ? ' (쉬운 악보)' : ''), bpm: r.bpm, key: r.key, timeSignature: r.timeSignature, parts: partsFor(job, { easy }), chords: r.chords, solfege });
  attach(res, req, `${safeName(job.title)}${easy ? '-easy' : ''}${solfege ? '-solfege' : ''}.musicxml`, 'application/vnd.recordare.musicxml+xml');
  res.send(xml);
});
app.get('/api/jobs/:id/midi', (req, res) => {
  const job = getJob(req.params.id);
  if (!job?.result) return res.status(404).json({ error: '결과가 없습니다' });
  const easy = req.query.easy === '1';
  const r = job.result;
  attach(res, req, `${safeName(job.title)}${easy ? '-easy' : ''}.mid`, 'audio/midi');
  res.send(buildMidi({ bpm: r.bpm, timeSignature: r.timeSignature, parts: partsFor(job, { easy }), title: r.title }));
});

function setStatus(job, status, progress, message) { job.status = status; job.progress = progress; job.message = message; }
function log(job, msg) {
  job.logs.push(`${new Date().toLocaleTimeString('ko-KR', { hour12: false })} ${msg}`);
  console.log(`[job ${job.id}] ${msg}`);
}

async function runPipeline(job, { file, url, model, bpmOverride, chunkSec, splitPitch, hint, parts, stems }) {
  const t0 = Date.now();
  const checkCancel = () => { if (job.cancelled) throw new Error('cancelled'); };
  const concurrency = /flash|lite/i.test(model) ? 4 : 3;
  let source;
  if (url) {
    setStatus(job, 'downloading', 0.02, '유튜브에서 오디오를 받는 중');
    const dl = await downloadFromUrl(url, job.dir);
    source = dl.filePath; job.title = dl.title;
    log(job, `다운로드 완료: ${dl.title}`);
  } else {
    source = file.path;
  }
  checkCancel();
  setStatus(job, 'preparing', 0.06, '오디오를 변환하고 나누는 중');
  const duration = await probeDuration(source);
  if (duration > MAX_DURATION_SEC) throw new Error(`오디오가 너무 깁니다 (${Math.round(duration / 60)}분). 15분 이하만 지원합니다.`);
  const playback = await makePlayback(source, path.join(job.dir, 'playback.mp3'));
  job.files.playback = playback;

  // 스템 분리(선택): 파트별로 다른 오디오를 Gemini에 준다
  // sources: [{label, parts, file, stemLabel}]
  let sources;
  if (stems) {
    if (!(await demucsAvailable(ROOT))) throw new Error('스템 분리(Demucs)가 설치돼 있지 않습니다. README의 3단계 설치를 먼저 하세요.');
    setStatus(job, 'separating', 0.08, '악기별로 소리를 분리하는 중 (Demucs, 몇 분 걸림)');
    const stemFiles = await separateStems(ROOT, playback, path.join(job.dir, 'stems'), { signal: job.abort.signal, log: m => log(job, m) });
    checkCancel();
    sources = [];
    if (parts.includes('piano')) sources.push({ label: '피아노(드럼 제외 믹스)', parts: ['piano'], file: stemFiles.no_drums, stemLabel: 'mix without drums' });
    if (parts.includes('bass')) sources.push({ label: '베이스', parts: ['bass'], file: stemFiles.bass, stemLabel: 'bass' });
    if (parts.includes('guitar')) sources.push({ label: '기타', parts: ['guitar'], file: stemFiles.guitar, stemLabel: 'guitar' });
    if (parts.includes('drums')) sources.push({ label: '드럼', parts: ['drums'], file: stemFiles.drums, stemLabel: 'drums' });
    if (!parts.includes('piano')) sources.push({ label: '코드·가사', parts: [], file: stemFiles.no_drums, stemLabel: 'mix without drums' });
  } else {
    sources = [{ label: '전체', parts, file: playback, stemLabel: null }];
  }

  const jobs = [];
  for (const src of sources) {
    const chunks = await splitChunks(src.file, path.join(job.dir, 'chunks', src.parts.join('_') || 'mix'), chunkSec);
    for (const c of chunks) jobs.push({ src, chunk: c });
  }
  log(job, `길이 ${duration.toFixed(1)}초, 호출 ${jobs.length}건 (${chunkSec}초 단위, 파트: ${parts.map(p => PART_LABELS[p]).join('·')}${stems ? ', 스템 분리' : ''})`);
  checkCancel();

  setStatus(job, 'transcribing', 0.1, `Gemini 채보 중 (0/${jobs.length})`);
  const results = new Array(jobs.length);
  let done = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      checkCancel();
      const i = next++;
      const { src, chunk } = jobs[i];
      const r = await transcribeChunk(chunk, { apiKey: process.env.GEMINI_API_KEY, model, hint, mock: MOCK, signal: job.abort.signal, parts: src.parts, stemLabel: src.stemLabel, log: m => log(job, m) });
      results[i] = { ...r, offsetSec: chunk.offsetSec, durationSec: chunk.durationSec, srcLabel: src.label };
      done++;
      const counts = ['notes', 'bass', 'guitar', 'drums'].map(k => r[k]?.length ? `${k === 'notes' ? '피아노' : PART_LABELS[k]} ${r[k].length}` : null).filter(Boolean).join(', ');
      log(job, `${src.label} ${chunk.index + 1}: ${counts || '음 없음'}, 코드 ${r.chords.length}, ${r.bpm ?? '?'} BPM, ${r.key ?? '?'}`);
      setStatus(job, 'transcribing', 0.1 + 0.78 * (done / jobs.length), `Gemini 채보 중 (${done}/${jobs.length})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  checkCancel();
  // 조 보정: 음원에서 잰 음별 에너지와 비교해, Gemini가 통째로 옮겨 적은 조각을 되돌린다
  let keyFix = null;
  if (!MOCK) {
    setStatus(job, 'keyfix', 0.89, '음원에서 조를 재서 맞추는 중');
    try {
      keyFix = correctKeys(results, await audioChroma(playback));
      const moved = keyFix.perChunk.map((p, i) => p.shift ? `${results[i].srcLabel} ${i + 1}: ${p.shift > 0 ? '+' : ''}${p.shift}` : null).filter(Boolean);
      log(job, `조 보정: 음원 기준 ${keyFix.target ?? '판단 불가'}${moved.length ? ` · 옮긴 조각 ${moved.join(', ')}` : ' · 옮길 필요 없음'}`);
    } catch (e) {
      log(job, `조 보정 건너뜀: ${String(e.message).slice(0, 80)}`);
    }
  }
  setStatus(job, 'building', 0.9, '악보와 MIDI를 만드는 중');
  // 스템 분리 때는 코드·가사·BPM은 피아노/믹스 쪽만 믿는다
  const metaResults = stems ? results.filter(r => /믹스|코드/.test(r.srcLabel)) : results;
  const merged = mergeAndQuantize(results.map(r => (stems && !metaResults.includes(r)) ? { ...r, chords: [], lyrics: [], bpm: null, key: null, timeSignature: null } : r), { bpmOverride });
  const partIds = parts.filter(id => merged.parts[id]?.length);
  if (!partIds.length) throw new Error('채보된 음표가 없습니다. 음악이 또렷한 구간인지 확인해 주세요.');
  const title = job.title || 'Transcription';
  const easy = buildEasyNotes({ ...merged }, splitPitch);
  job.result = {
    title, duration, model, mock: MOCK, stems,
    keyFix: keyFix ? { applied: keyFix.applied, target: keyFix.target, shifts: keyFix.perChunk.map(p => p.shift) } : null,
    bpm: merged.bpm, key: merged.key, timeSignature: merged.timeSignature, splitPitch,
    partIds, parts: merged.parts, chords: merged.chords, lyrics: merged.lyrics, easy,
    noteCount: partIds.reduce((n, id) => n + merged.parts[id].length, 0),
    notes: merged.parts.piano || [],
    description: null,
    processingSec: 0,
  };
  await fs.writeFile(path.join(job.dir, 'raw.json'), JSON.stringify(results.map(r => ({ src: r.srcLabel, offsetSec: r.offsetSec, bpm: r.bpm, key: r.key, timeSignature: r.timeSignature, raw: r.raw })), null, 2));

  setStatus(job, 'describing', 0.95, '곡 해설을 쓰는 중');
  try {
    const chordProgression = merged.chords.slice(0, 48).map(c => c.name).join(' ');
    const partCounts = partIds.map(id => `${PART_LABELS[id]} ${merged.parts[id].length}음`).join(', ');
    const lyricsSample = merged.lyrics.slice(0, 6).map(l => l.text).join(' / ');
    job.result.description = await describeSong({ title, duration, key: merged.key, timeSignature: merged.timeSignature, bpm: merged.bpm, chordProgression, partCounts, lyricsSample }, { apiKey: process.env.GEMINI_API_KEY, model, mock: MOCK, signal: job.abort.signal });
  } catch (e) {
    if (job.cancelled) throw e;
    log(job, `곡 해설 실패(건너뜀): ${String(e.message).slice(0, 80)}`);
  }
  job.result.processingSec = +((Date.now() - t0) / 1000).toFixed(1);
  setStatus(job, 'done', 1, '채보 완료');
  await persistJob(job);
  log(job, `완료: ${job.result.noteCount}음, ${merged.bpm} BPM, ${merged.key}, ${merged.timeSignature}, 코드 ${merged.chords.length}개, 가사 ${merged.lyrics.length}줄, ${job.result.processingSec}초`);
}

app.listen(PORT, () => {
  console.log(`Gemini Piano Transcriber: http://localhost:${PORT}  (model=${DEFAULT_MODEL}, key=${process.env.GEMINI_API_KEY ? 'set' : 'MISSING'}, mock=${MOCK})`);
});
try {
  const { key, crt } = await ensureCert();
  const httpsServer = https.createServer({ key: readFileSync(key), cert: readFileSync(crt) }, app);
  await new Promise((resolve, reject) => {
    httpsServer.once('error', err => {
      if (HTTPS_PORT !== 3443) { console.log(`${HTTPS_PORT}번을 못 열어(${err.code}) 3443번으로 https를 엽니다`); HTTPS_PORT = 3443; httpsServer.once('error', reject); httpsServer.listen(3443, resolve); }
      else reject(err);
    });
    httpsServer.listen(HTTPS_PORT, resolve);
  });
  httpsReady = true;
  // 휴대폰에서 주소만 치면(http) https로 보내 주는 80번 안내 서버
  const redirectServer = http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    res.writeHead(301, { Location: `https://${host}${HTTPS_PORT === 443 ? '' : ':' + HTTPS_PORT}${req.url}` }); res.end();
  });
  await new Promise(resolve => { redirectServer.once('error', e => { console.log(`${REDIRECT_PORT}번 안내 서버는 못 열었습니다(${e.code})`); resolve(); }); redirectServer.listen(REDIRECT_PORT, () => { redirectReady = true; resolve(); }); });
  for (const u of lanPhoneUrls()) console.log(`휴대폰(같은 와이파이)에서 공유까지 쓰려면: ${u}  ← 처음 한 번 "안전하지 않음" 경고에서 세부사항 보기 → 방문/계속`);
} catch (e) {
  console.log(`https를 켜지 못했습니다: ${String(e.message).split('\n')[0]}`);
  console.log('  → 컴퓨터에서 쓰는 데는 문제없습니다. 휴대폰에서 카톡·메일 공유 창을 쓰려면 https가 필요합니다(맥·리눅스는 openssl 기본 포함, 윈도우는 Git for Windows나 winget install ShiningLight.OpenSSL.Light 설치).');
  for (const u of lanUrls()) console.log(`휴대폰(같은 와이파이)에서: ${u}`);
}
