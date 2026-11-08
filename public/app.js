// Gemini 채보 프론트엔드
const $ = id => document.getElementById(id);
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const PART_LABEL = { piano: '피아노', bass: '베이스', guitar: '기타', drums: '드럼' };
const PART_COLOR = { piano: '#6b8cff', bass: '#ffb86b', guitar: '#7ed9a0' };
const SOLFEGE = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
const DRUM_ROWS = ['crash', 'ride', 'hihat_open', 'hihat', 'tom_hi', 'tom_mid', 'tom_low', 'snare', 'kick'];
const DRUM_LABEL = { kick: '킥', snare: '스네어', hihat: '하이햇', hihat_open: '오픈 하이햇', tom_hi: '하이 탐', tom_mid: '미드 탐', tom_low: '로우 탐', crash: '크래시', ride: '라이드' };

// ---------- 서버 상태 ----------
let health = {};
fetch('/api/health').then(r => r.json()).then(h => {
  health = h;
  const parts = [];
  parts.push(h.mock ? '<span class="bad">모의 모드(MOCK_GEMINI=1): Gemini를 호출하지 않습니다</span>' : (h.hasKey ? `모델 ${h.model}` : '<span class="bad">GEMINI_API_KEY가 없습니다. .env에 키를 넣고 서버를 다시 시작하세요.</span>'));
  if (!h.ffmpeg) parts.push('<span class="bad">ffmpeg 없음</span>');
  if (!h.ytdlp) parts.push('<span class="bad">yt-dlp 없음 (유튜브 URL 사용 불가)</span>');
  parts.push(h.demucs ? '스템 분리 가능' : '<span class="muted">스템 분리 미설치 (README 3단계)</span>');
  $('health').innerHTML = parts.join(' · ');
  if (!h.demucs) { $('stems').disabled = true; $('stemsLabel').classList.add('disabled'); }
  const httpsUrl = (h.lanHttps || [])[0];
  const phoneUrl = (h.phone || [])[0] || httpsUrl;
  // 휴대폰에서 http로 열었으면(공유 창이 못 뜨는 상태) https로 가는 안내를 맨 위에
  if (httpsUrl && !window.isSecureContext && location.hostname !== 'localhost') {
    const b = $('httpsBanner');
    b.innerHTML = `휴대폰에서 카카오톡·메일 공유를 쓰려면 <a id="gotoHttps" href="${httpsUrl}/${location.hash}">https로 열기 →</a> (처음 한 번 "안전하지 않음" 경고가 뜨면 세부사항 보기 → 방문/계속)`;
    b.classList.remove('hidden');
  }
  if (httpsUrl) $('lanHint').innerHTML = `휴대폰에서 같은 와이파이로 <a href="${httpsUrl}/${location.hash}">${phoneUrl.replace(/^https?:\/\//, '')}</a> 를 열면 공유 버튼이 카카오톡·메일 공유 창을 바로 띄웁니다. 자동으로 <b>https</b>로 넘어가고, 처음 한 번 "안전하지 않음" 경고에서 <b>계속(방문)</b>을 누르면 됩니다. http 주소에서는 공유 창이 열리지 않습니다.`;
  else if (h.lan && h.lan.length) $('lanHint').textContent = `휴대폰 공유 창은 https에서만 열립니다. 서버에 openssl이 없어 https를 켜지 못했습니다.`;
}).catch(() => { $('health').textContent = '서버에 연결할 수 없습니다'; });

// ---------- 입력 ----------
const drop = $('drop'), fileInput = $('file');
let chosenFile = null;
function setFile(f) {
  chosenFile = f || null;
  drop.classList.toggle('has', !!f);
  $('dropText').textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)} MB)` : '음악 파일을 끌어다 놓거나 클릭해서 선택';
  if (f) $('url').value = '';
}
fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) setFile(f); });
$('url').addEventListener('input', () => { if ($('url').value.trim()) setFile(null); });

$('start').addEventListener('click', async () => {
  const url = $('url').value.trim();
  const msg = $('inputMsg');
  msg.className = 'msg';
  if (!chosenFile && !url) { msg.textContent = '파일을 고르거나 URL을 넣어 주세요'; msg.classList.add('err'); return; }
  const parts = [...document.querySelectorAll('.part:checked')].map(c => c.value);
  if (!parts.length) { msg.textContent = '악기를 하나 이상 고르세요'; msg.classList.add('err'); return; }
  const fd = new FormData();
  if (chosenFile) fd.append('file', chosenFile); else fd.append('url', url);
  for (const k of ['model', 'bpm', 'chunkSec', 'splitPitch', 'hint']) fd.append(k, $(k).value);
  fd.append('parts', parts.join(','));
  fd.append('stems', $('stems').checked ? '1' : '0');
  if ($('fast').checked) fd.set('model', 'gemini-3.5-flash-lite');
  $('start').disabled = true;
  msg.textContent = '보내는 중…';
  try {
    const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    msg.textContent = '';
    stopPlayback();
    $('resultCard').classList.add('hidden');
    $('progressCard').classList.remove('hidden');
    poll(j.jobId);
  } catch (e) {
    msg.textContent = e.message; msg.classList.add('err');
    $('start').disabled = false;
  }
});

// ---------- 진행 상황 ----------
let pollTimer = null, jobStart = 0, currentJobId = null;
$('cancel').addEventListener('click', async () => {
  if (!currentJobId) return;
  $('cancel').disabled = true; $('cancel').textContent = '중지하는 중…';
  try { await fetch(`/api/jobs/${currentJobId}/cancel`, { method: 'POST' }); } catch (e) { /* 폴링이 상태를 보여준다 */ }
});
function poll(id) {
  currentJobId = id;
  $('cancel').disabled = false; $('cancel').textContent = '중지'; $('cancel').classList.remove('hidden');
  $('bar').style.background = '';
  jobStart = Date.now();
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const j = await (await fetch(`/api/jobs/${id}`)).json();
      $('bar').style.width = `${Math.round(j.progress * 100)}%`;
      $('status').textContent = j.message;
      $('elapsed').textContent = `${Math.round((Date.now() - jobStart) / 1000)}초 경과`;
      $('logs').textContent = j.logs.join('\n');
      $('logs').scrollTop = $('logs').scrollHeight;
      if (j.status === 'done') { clearInterval(pollTimer); $('start').disabled = false; $('cancel').classList.add('hidden'); showResult(id, j); }
      if (j.status === 'error' || j.status === 'cancelled') {
        clearInterval(pollTimer); $('start').disabled = false; $('status').textContent = j.message;
        $('bar').style.background = j.status === 'error' ? 'var(--danger)' : '#555'; $('cancel').classList.add('hidden');
      }
    } catch (e) { /* 다음 폴링에서 재시도 */ }
  }, 1000);
}

// ---------- 결과 ----------
let R = null, jobId = null;
let timeline = [];              // 재생용 이벤트 {kind, p|piece, startSec, durSec}
const partOn = { piano: true, bass: true, guitar: true, drums: true };
const audio = $('audio');

function showResult(id, j) {
  history.replaceState(null, '', `#job=${id}`);
  jobId = id; R = j.result;
  $('progressCard').classList.add('hidden');
  $('resultCard').classList.remove('hidden');
  $('rTitle').textContent = R.title;
  const partsTxt = R.partIds.map(p => `${PART_LABEL[p]} ${R.parts[p].length.toLocaleString()}음`).join(' · ');
  $('rMeta').textContent = `${fmt(R.duration)} · ${R.key} · ${R.timeSignature} · 약 ${R.bpm} BPM · ${partsTxt} · 코드 ${R.chords.length}개${R.lyrics.length ? ` · 가사 ${R.lyrics.length}줄` : ''} · 처리 ${R.processingSec}초 · ${R.mock ? '모의 모드' : R.model}${R.stems ? ' · 스템 분리' : ''}`;
  if (R.description) {
    $('desc').classList.remove('hidden');
    $('descSummary').textContent = R.description.summary || '';
    $('descStructure').textContent = R.description.structure || '';
    $('descDifficulty').textContent = R.description.difficulty || '';
    $('descTips').textContent = R.description.tips || '';
  } else $('desc').classList.add('hidden');
  $('easyWrap').classList.toggle('hidden', !R.partIds.includes('piano') && !R.partIds.includes('guitar'));
  $('drumsTab').classList.toggle('hidden', !R.partIds.includes('drums'));
  $('partToggles').innerHTML = R.partIds.map(p => `<button data-part="${p}" class="${partOn[p] ? '' : 'off'}">${PART_LABEL[p]}</button>`).join('');
  $('partToggles').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { partOn[b.dataset.part] = !partOn[b.dataset.part]; b.classList.toggle('off'); rebuildTimeline(); }));
  updateDownloadLinks();
  audio.src = `/api/jobs/${id}/audio`;
  audio.volume = $('volOrig').value / 100;
  audio.playbackRate = rate;
  $('tEnd').textContent = fmt(R.duration);
  $('seek').value = 0;
  $('sharePanel').classList.add('hidden');
  sheetCache.clear(); osmd = null; $('sheet').innerHTML = ''; leadPages = null; $('lead').innerHTML = '';
  rebuildTimeline();
  switchTab('roll');
  resizeRoll(); drawRoll();
}
function updateDownloadLinks() {
  const q = `${$('easy').checked ? '&easy=1' : ''}${$('solfege').checked ? '&solfege=1' : ''}`;
  $('dlMidi').href = `/api/jobs/${jobId}/midi?download=1${$('easy').checked ? '&easy=1' : ''}`;
  $('dlXml').href = `/api/jobs/${jobId}/musicxml?download=1${q}`;
}
function rebuildTimeline() {
  timeline = [];
  const easy = $('easy').checked;
  for (const id of R.partIds) {
    if (!partOn[id]) continue;
    if (id === 'drums') { for (const d of R.parts.drums) timeline.push({ kind: 'drums', piece: d.piece, startSec: d.startSec, durSec: 0.2 }); continue; }
    const src = (id === 'piano' && easy) ? R.easy : R.parts[id];
    for (const n of src) timeline.push({ kind: id, p: n.p, startSec: n.startSec, durSec: n.durSec });
  }
  timeline.sort((a, b) => a.startSec - b.startSec);
  if (!audio.paused) seekSched(audio.currentTime + 0.02);
}
$('easy').addEventListener('change', () => { updateDownloadLinks(); rebuildTimeline(); drawRoll(); if (activeTab === 'sheet') loadSheet(); });
$('solfege').addEventListener('change', () => { updateDownloadLinks(); drawRoll(); if (activeTab === 'sheet') loadSheet(); });

// ---------- 재생: <audio>가 시계, 채보는 WebAudio 신디사이저 ----------
let ctx = null, synthGain = null, noiseBuf = null;
let schedIdx = 0, schedTimer = null;
const LOOKAHEAD = 0.3;
let rate = 1;
$('speed').addEventListener('change', e => { rate = Number(e.target.value); audio.playbackRate = rate; if (!audio.paused) seekSched(audio.currentTime + 0.02); });
function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    synthGain = ctx.createGain();
    synthGain.gain.value = $('volSynth').value / 100;
    synthGain.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}
function env(g, when, peak, decayTo, decayTime, dur, release) {
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.008);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, decayTo), when + Math.min(decayTime, dur));
  g.gain.setValueAtTime(Math.max(0.0001, decayTo), when + dur);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur + release);
}
function osc(type, freq, dest, when, stop) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.connect(dest); o.start(when); o.stop(stop); return o; }
function noise(dest, when, stop, filterType, freq) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq;
  s.connect(f); f.connect(dest); s.start(when); s.stop(stop); return s;
}
function playEvent(e, when) {
  const dur = Math.max(0.08, e.durSec / rate);
  const g = ctx.createGain(); g.connect(synthGain);
  const end = when + dur + 0.3;
  if (e.kind === 'drums') {
    const t = when;
    switch (e.piece) {
      case 'kick': { const o = osc('sine', 150, g, t, t + 0.3); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); env(g, t, 0.9, 0.3, 0.1, 0.18, 0.1); break; }
      case 'snare': { noise(g, t, t + 0.25, 'highpass', 1200); osc('triangle', 190, g, t, t + 0.15); env(g, t, 0.5, 0.15, 0.08, 0.12, 0.1); break; }
      case 'hihat': { noise(g, t, t + 0.1, 'highpass', 7000); env(g, t, 0.25, 0.05, 0.03, 0.04, 0.03); break; }
      case 'hihat_open': { noise(g, t, t + 0.5, 'highpass', 6000); env(g, t, 0.25, 0.08, 0.15, 0.3, 0.15); break; }
      case 'crash': { noise(g, t, t + 1.4, 'bandpass', 5000); env(g, t, 0.35, 0.1, 0.4, 0.9, 0.4); break; }
      case 'ride': { noise(g, t, t + 0.6, 'bandpass', 8000); osc('sine', 3200, g, t, t + 0.4); env(g, t, 0.18, 0.06, 0.15, 0.3, 0.2); break; }
      case 'tom_hi': { const o = osc('sine', 260, g, t, t + 0.35); o.frequency.exponentialRampToValueAtTime(160, t + 0.2); env(g, t, 0.6, 0.2, 0.1, 0.2, 0.1); break; }
      case 'tom_mid': { const o = osc('sine', 190, g, t, t + 0.4); o.frequency.exponentialRampToValueAtTime(110, t + 0.25); env(g, t, 0.6, 0.2, 0.1, 0.25, 0.1); break; }
      case 'tom_low': { const o = osc('sine', 130, g, t, t + 0.5); o.frequency.exponentialRampToValueAtTime(75, t + 0.3); env(g, t, 0.7, 0.2, 0.12, 0.3, 0.1); break; }
    }
    return;
  }
  const freq = 440 * Math.pow(2, (e.p - 69) / 12);
  if (e.kind === 'bass') {
    osc('sine', freq, g, when, end); const g2 = ctx.createGain(); g2.gain.value = 0.35; g2.connect(g); osc('triangle', freq, g2, when, end);
    env(g, when, 0.5, 0.25, 0.3, dur, 0.08);
  } else if (e.kind === 'guitar') {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(freq * 6, when); f.frequency.exponentialRampToValueAtTime(freq * 1.5, when + 0.4); f.connect(g);
    osc('sawtooth', freq, f, when, end); const g2 = ctx.createGain(); g2.gain.value = 0.4; g2.connect(g); osc('triangle', freq, g2, when, end);
    env(g, when, 0.22, 0.05, 0.5, dur, 0.1);
  } else {
    osc('triangle', freq, g, when, end); const g2 = ctx.createGain(); g2.gain.value = 0.25; g2.connect(g); osc('sine', freq * 2, g2, when, end);
    const peak = 0.22 * (e.p < 48 ? 0.8 : 1);
    env(g, when, peak, peak * 0.35, 0.4, dur, 0.12);
  }
}
function seekSched(t) {
  let lo = 0, hi = timeline.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (timeline[m].startSec < t) lo = m + 1; else hi = m; }
  schedIdx = lo;
}
function schedule() {
  const t = audio.currentTime;
  const horizon = t + LOOKAHEAD * rate;
  while (schedIdx < timeline.length && timeline[schedIdx].startSec < horizon) {
    const e = timeline[schedIdx++];
    playEvent(e, ctx.currentTime + Math.max(0, (e.startSec - t) / rate));
  }
}
function startPlayback() {
  ensureCtx();
  seekSched(audio.currentTime + 0.02);
  audio.play();
  clearInterval(schedTimer);
  schedTimer = setInterval(schedule, 100);
  $('play').textContent = '❚❚';
}
function stopPlayback() {
  audio.pause();
  clearInterval(schedTimer); schedTimer = null;
  $('play').textContent = '▶';
}
$('play').addEventListener('click', () => { if (!R) return; audio.paused ? startPlayback() : stopPlayback(); });
audio.addEventListener('ended', stopPlayback);
let seeking = false;
audio.addEventListener('timeupdate', () => { if (!seeking) $('seek').value = Math.round(audio.currentTime / (R?.duration || 1) * 1000); $('tCur').textContent = fmt(audio.currentTime); });
$('seek').addEventListener('input', () => { seeking = true; $('tCur').textContent = fmt($('seek').value / 1000 * R.duration); });
$('seek').addEventListener('change', () => { seeking = false; seekTo($('seek').value / 1000 * R.duration); });
function seekTo(t) {
  audio.currentTime = Math.max(0, Math.min(R.duration, t));
  $('tCur').textContent = fmt(audio.currentTime);
  $('seek').value = Math.round(audio.currentTime / (R.duration || 1) * 1000);
  if (!audio.paused) seekSched(audio.currentTime + 0.02);
}
$('volOrig').addEventListener('input', e => { audio.volume = e.target.value / 100; });
$('volSynth').addEventListener('input', e => { if (synthGain) synthGain.gain.value = e.target.value / 100; });

// ---------- 피아노 롤 ----------
const canvas = $('roll'), cx = canvas.getContext('2d');
const LOW = 21, HIGH = 108, KEYW = 56;
let pxPerSec = 80, viewStart = 0;
const isBlack = p => [1, 3, 6, 8, 10].includes(p % 12);
function rollNotes() {
  const out = [];
  for (const id of R.partIds) {
    if (id === 'drums' || !partOn[id]) continue;
    const src = (id === 'piano' && $('easy').checked) ? R.easy : R.parts[id];
    for (const n of src) out.push({ ...n, kind: id });
  }
  return out;
}
function resizeRoll() {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.height = ($('solfege').checked ? 88 * 11 : 560) + 'px';
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { resizeRoll(); drawRoll(); });
$('zoom').addEventListener('input', e => { pxPerSec = +e.target.value; drawRoll(); });
$('solfege').addEventListener('change', () => { resizeRoll(); if ($('solfege').checked) $('rollPane').scrollTop = (HIGH - 72) * 11; });
canvas.addEventListener('click', e => { if (!R) return; const x = e.offsetX; if (x < KEYW) return; seekTo(viewStart + (x - KEYW) / pxPerSec); drawRoll(); });
canvas.addEventListener('wheel', e => {
  if (!R) return;
  const dx = e.shiftKey ? e.deltaY : e.deltaX;
  if (Math.abs(dx) < 1) return;
  e.preventDefault();
  $('follow').checked = false;
  viewStart = Math.max(0, viewStart + dx / pxPerSec * 0.5);
  drawRoll();
}, { passive: false });

function drawRoll() {
  if (!R) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const kh = h / (HIGH - LOW + 1);
  const yOf = p => (HIGH - p) * kh;
  const t = audio.currentTime;
  const visSec = (w - KEYW) / pxPerSec;
  if ($('follow').checked && (t < viewStart || t > viewStart + visSec * 0.7)) viewStart = Math.max(0, t - visSec * 0.3);
  cx.clearRect(0, 0, w, h);
  for (let p = LOW; p <= HIGH; p++) { cx.fillStyle = isBlack(p) ? '#0b0d12' : '#11141b'; cx.fillRect(KEYW, yOf(p), w - KEYW, kh); }
  const secPerBeat = 60 / R.bpm;
  const beatsPerBar = Number(R.timeSignature.split('/')[0]) * 4 / Number(R.timeSignature.split('/')[1]);
  const barSec = secPerBeat * beatsPerBar;
  for (let b = Math.floor(viewStart / barSec); b * barSec < viewStart + visSec; b++) {
    const x = KEYW + (b * barSec - viewStart) * pxPerSec;
    cx.fillStyle = '#1f2430'; cx.fillRect(x, 0, 1, h);
    if (pxPerSec * secPerBeat > 14) for (let k = 1; k < beatsPerBar; k++) { cx.fillStyle = '#161a23'; cx.fillRect(x + k * secPerBeat * pxPerSec, 0, 1, h); }
    cx.fillStyle = '#4a5063'; cx.font = '10px sans-serif'; cx.fillText(String(b + 1), x + 3, 10);
    const ch = R.chords.find(c => Math.abs(c.startSec - b * barSec) < secPerBeat / 2);
    if (ch) { cx.fillStyle = '#9fb3ff'; cx.font = 'bold 12px sans-serif'; cx.fillText(ch.name, x + 3, 24); }
  }
  const active = new Set();
  const showNames = $('solfege').checked;
  for (const n of rollNotes()) {
    const x0 = KEYW + (n.startSec - viewStart) * pxPerSec;
    const x1 = x0 + Math.max(2, n.durSec * pxPerSec - 1);
    if (x1 < KEYW || x0 > w) continue;
    const on = t >= n.startSec && t < n.startSec + n.durSec;
    if (on) active.add(n.p);
    cx.fillStyle = on ? '#ffffff' : PART_COLOR[n.kind];
    const xa = Math.max(KEYW, x0), xb = Math.min(w, x1);
    cx.fillRect(xa, yOf(n.p) + 1, xb - xa, Math.max(1, kh - 2));
    if (showNames && xb - xa > 16 && kh >= 9) { cx.fillStyle = on ? '#000' : '#0b0d12'; cx.font = `${Math.min(10, kh - 2)}px sans-serif`; cx.fillText(SOLFEGE[n.p % 12], xa + 2, yOf(n.p) + kh - 2); }
  }
  const px = KEYW + (t - viewStart) * pxPerSec;
  if (px >= KEYW && px <= w) { cx.fillStyle = '#ffffffaa'; cx.fillRect(px, 0, 1.5, h); }
  cx.fillStyle = '#f4f4f4'; cx.fillRect(0, 0, KEYW, h);
  for (let p = LOW; p <= HIGH; p++) {
    if (isBlack(p)) continue;
    cx.fillStyle = active.has(p) ? '#9fb3ff' : '#f4f4f4';
    cx.fillRect(0, yOf(p) - (isBlack(p + 1) ? kh / 2 : 0), KEYW, kh + (isBlack(p + 1) ? kh / 2 : 0) + (isBlack(p - 1) ? kh / 2 : 0));
    cx.fillStyle = '#d0d0d0'; cx.fillRect(0, yOf(p) + kh + (isBlack(p - 1) ? kh / 2 : 0) - 1, KEYW, 1);
    if (showNames && kh >= 9) { cx.fillStyle = '#555'; cx.font = '9px sans-serif'; cx.fillText(SOLFEGE[p % 12] + (p % 12 === 0 ? (p / 12 - 1) : ''), 3, yOf(p) + kh - 1); }
    else if (p % 12 === 0) { cx.fillStyle = '#777'; cx.font = '9px sans-serif'; cx.fillText('C' + (p / 12 - 1), 3, yOf(p) + kh - 1); }
  }
  for (let p = LOW; p <= HIGH; p++) { if (!isBlack(p)) continue; cx.fillStyle = active.has(p) ? '#3b5bdb' : '#1a1a1a'; cx.fillRect(0, yOf(p), KEYW * 0.6, kh); }
  cx.fillStyle = '#2a2f3c'; cx.fillRect(KEYW - 1, 0, 1, h);
}

// ---------- 드럼 그리드 ----------
const dg = $('drumGrid'), dcx = dg.getContext('2d');
function drawDrumGrid() {
  if (!R || !R.parts.drums) return;
  const dpr = window.devicePixelRatio || 1;
  const w = dg.clientWidth, h = dg.clientHeight;
  if (dg.width !== Math.round(w * dpr)) { dg.width = Math.round(w * dpr); dg.height = Math.round(h * dpr); }
  dcx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const LABELW = 90, rowH = (h - 20) / DRUM_ROWS.length;
  const secPerBeat = 60 / R.bpm, stepSec = secPerBeat / 4;
  const beatsPerBar = Number(R.timeSignature.split('/')[0]) * 4 / Number(R.timeSignature.split('/')[1]);
  const stepsPerBar = beatsPerBar * 4;
  const stepW = Math.max(6, (pxPerSec * stepSec));
  const t = audio.currentTime;
  const visSteps = (w - LABELW) / stepW;
  let start = Math.floor(viewStart / stepSec);
  if ($('follow').checked) { const cur = t / stepSec; if (cur < start || cur > start + visSteps * 0.7) start = Math.max(0, Math.floor(cur - visSteps * 0.3)); viewStart = start * stepSec; }
  dcx.clearRect(0, 0, w, h);
  dcx.fillStyle = '#0b0d12'; dcx.fillRect(0, 0, w, h);
  for (let s = start; s < start + visSteps + 1; s++) {
    const x = LABELW + (s - start) * stepW;
    const inBar = s % stepsPerBar;
    dcx.fillStyle = inBar === 0 ? '#2a3040' : (inBar % 4 === 0 ? '#1a1f2a' : '#12151c');
    dcx.fillRect(x, 20, 1, h - 20);
    if (inBar === 0) { dcx.fillStyle = '#4a5063'; dcx.font = '10px sans-serif'; dcx.fillText(String(s / stepsPerBar + 1), x + 3, 12); }
  }
  DRUM_ROWS.forEach((piece, i) => {
    const y = 20 + i * rowH;
    dcx.fillStyle = i % 2 ? '#0f1218' : '#0b0d12'; dcx.fillRect(LABELW, y, w - LABELW, rowH);
    dcx.fillStyle = '#8b91a1'; dcx.font = '12px sans-serif'; dcx.fillText(DRUM_LABEL[piece], 8, y + rowH / 2 + 4);
  });
  for (const d of R.parts.drums) {
    const s = Math.round(d.startSec / stepSec);
    if (s < start - 1 || s > start + visSteps + 1) continue;
    const i = DRUM_ROWS.indexOf(d.piece); if (i < 0) continue;
    const x = LABELW + (s - start) * stepW, y = 20 + i * rowH;
    const on = t >= d.startSec && t < d.startSec + stepSec;
    dcx.fillStyle = on ? '#fff' : (d.piece === 'kick' ? '#ff8e8e' : d.piece === 'snare' ? '#ffd166' : '#6b8cff');
    dcx.beginPath(); dcx.roundRect(x + 1, y + 3, stepW - 2, rowH - 6, 3); dcx.fill();
  }
  const px = LABELW + (t / stepSec - start) * stepW;
  if (px >= LABELW && px <= w) { dcx.fillStyle = '#ffffffaa'; dcx.fillRect(px, 0, 1.5, h); }
}
dg.addEventListener('click', e => { if (!R) return; const x = e.offsetX; if (x < 90) return; const stepSec = 60 / R.bpm / 4; seekTo(viewStart + (x - 90) / Math.max(6, pxPerSec * stepSec) * stepSec); });

(function raf() {
  if (R) { if (activeTab === 'roll') drawRoll(); else if (activeTab === 'drums') drawDrumGrid(); }
  requestAnimationFrame(raf);
})();

// ---------- 탭 ----------
let activeTab = 'roll';
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of ['roll', 'sheet', 'lead', 'drums']) $(t + 'Pane').classList.toggle('hidden', name !== t);
  $('zoomWrap').classList.toggle('hidden', name !== 'roll' && name !== 'drums');
  if (name === 'roll') { resizeRoll(); drawRoll(); }
  if (name === 'sheet') loadSheet();
  if (name === 'lead') renderLead();
}

// ---------- 악보 (OSMD) ----------
let osmd = null, sheetLoading = null;
const sheetCache = new Map(); // variant → xml
function sheetVariant() { return `${$('easy').checked ? 1 : 0}${$('solfege').checked ? 1 : 0}`; }
async function loadSheet() {
  const variant = sheetVariant();
  if (osmd && osmd._variant === variant) return;
  if (sheetLoading) { await sheetLoading; if (osmd && osmd._variant === variant) return; }
  sheetLoading = (async () => {
    $('sheetMsg').textContent = '악보를 그리는 중…';
    try {
      if (!window.opensheetmusicdisplay) throw new Error('악보 라이브러리(OSMD)를 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
      let xml = sheetCache.get(variant);
      if (!xml) { xml = await (await fetch(`/api/jobs/${jobId}/musicxml?easy=${variant[0]}&solfege=${variant[1]}`)).text(); sheetCache.set(variant, xml); }
      $('sheet').innerHTML = '';
      osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay($('sheet'), { autoResize: false, backend: 'svg', drawTitle: true, drawComposer: false, drawPartNames: true, pageFormat: 'A4_P', pageBackgroundColor: '#FFFFFF' });
      await osmd.load(xml);
      osmd.render();
      osmd._variant = variant;
      $('sheetMsg').textContent = '';
    } catch (e) {
      $('sheetMsg').textContent = '악보 표시 실패: ' + e.message;
      osmd = null;
    } finally { sheetLoading = null; }
  })();
  return sheetLoading;
}

// ---------- 코드·가사 리드시트 (캔버스 → PDF) ----------
let leadPages = null;
function renderLead() {
  if (leadPages) return;
  const W = 1240, H = 1754, M = 80, BARS = 4, ROWH = 150;
  const beatsPerBar = Number(R.timeSignature.split('/')[0]) * 4 / Number(R.timeSignature.split('/')[1]);
  const secPerBeat = 60 / R.bpm, barSec = secPerBeat * beatsPerBar;
  const totalBars = Math.max(1, Math.ceil(R.duration / barSec));
  const chordsIn = b => R.chords.filter(c => c.beat >= b * beatsPerBar && c.beat < (b + 1) * beatsPerBar);
  const lyricsIn = b => R.lyrics.filter(l => l.startSec >= b * barSec && l.startSec < (b + 1) * barSec);
  const uniq = [...new Set(R.chords.map(c => c.name))];
  const pages = [];
  let page = null, y = 0;
  const newPage = () => {
    page = document.createElement('canvas'); page.width = W; page.height = H;
    const c = page.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    pages.push(page); y = M;
    if (pages.length === 1) {
      c.fillStyle = '#000'; c.font = 'bold 36px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
      c.fillText(R.title.length > 40 ? R.title.slice(0, 39) + '…' : R.title, M, y + 36); y += 56;
      c.font = '20px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; c.fillStyle = '#444';
      c.fillText(`${R.key} · ${R.timeSignature} · ♩= ${R.bpm}${uniq.length ? ` · 사용 코드 ${uniq.length}개: ${uniq.slice(0, 12).join('  ')}${uniq.length > 12 ? ' …' : ''}` : ''}`, M, y + 20); y += 50;
      if (!R.chords.length && !R.lyrics.length) { c.fillStyle = '#888'; c.fillText('이 곡에서는 코드와 가사가 잡히지 않았습니다.', M, y + 20); y += 40; }
    }
  };
  newPage();
  const barW = (W - 2 * M) / BARS;
  for (let b = 0; b < totalBars; b++) {
    if (b % BARS === 0) { if (y + ROWH > H - M) newPage(); }
    const c = page.getContext('2d');
    const x = M + (b % BARS) * barW;
    c.strokeStyle = '#999'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x, y + 40); c.lineTo(x, y + ROWH - 20); c.stroke();
    if (b % BARS === BARS - 1 || b === totalBars - 1) { c.beginPath(); c.moveTo(x + barW, y + 40); c.lineTo(x + barW, y + ROWH - 20); c.stroke(); }
    c.strokeStyle = '#ccc'; c.beginPath(); c.moveTo(x, y + 40); c.lineTo(x + barW, y + 40); c.stroke();
    c.fillStyle = '#999'; c.font = '13px sans-serif'; c.fillText(String(b + 1), x + 4, y + 36);
    c.fillStyle = '#000'; c.font = 'bold 26px "Helvetica Neue", Arial, sans-serif';
    for (const ch of chordsIn(b)) { const frac = (ch.beat - b * beatsPerBar) / beatsPerBar; c.fillText(ch.name, x + 10 + frac * (barW - 20), y + 30); }
    c.fillStyle = '#222'; c.font = '17px "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    let ly = y + 68, line = '';
    const words = lyricsIn(b).map(l => l.text).join(' ');
    for (const word of words.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + word : word;
      if (c.measureText(test).width > barW - 16 && line) { c.fillText(line, x + 8, ly); ly += 22; line = word; if (ly > y + ROWH - 24) { line += '…'; break; } }
      else line = test;
    }
    if (line) c.fillText(line, x + 8, ly);
    if (b % BARS === BARS - 1) y += ROWH;
  }
  pages.forEach((p, i) => { const c = p.getContext('2d'); c.fillStyle = '#999'; c.font = '13px sans-serif'; c.fillText(`${i + 1} / ${pages.length} · Gemini 채보`, W - M - 140, H - 40); });
  $('lead').innerHTML = '';
  for (const p of pages) $('lead').appendChild(p);
  leadPages = pages;
}
function leadPdfBlob() {
  renderLead();
  const pdf = new jspdf.jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
  leadPages.forEach((p, i) => { if (i > 0) pdf.addPage('a4', 'p'); pdf.addImage(p.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 210, 297); });
  return pdf.output('blob');
}
$('dlLead').addEventListener('click', () => { if (!R) return; saveBlob(leadPdfBlob(), `${safeTitle()} 리드시트.pdf`); });

// ---------- PDF / 공유 ----------
function safeTitle() { return R.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'transcription'; }
function saveBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }
async function makePdfBlob() {
  if (activeTab !== 'sheet') switchTab('sheet');
  await loadSheet();
  if (!osmd) throw new Error('악보가 준비되지 않았습니다');
  const backends = osmd.Drawer.Backends;
  const pdf = new jspdf.jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
  for (let i = 0; i < backends.length; i++) { if (i > 0) pdf.addPage('a4', 'p'); await pdf.svg(backends[i].getSvgElement(), { x: 0, y: 0, width: 210, height: 297 }); }
  return pdf.output('blob');
}
$('dlPdf').addEventListener('click', async () => {
  if (!R) return;
  const btn = $('dlPdf'); btn.disabled = true; btn.textContent = 'PDF 만드는 중…';
  try { saveBlob(await makePdfBlob(), `${safeTitle()}${$('easy').checked ? ' (쉬운 악보)' : ''}${$('solfege').checked ? ' (계이름)' : ''}.pdf`); }
  catch (e) { console.error(e); alert('PDF 자동 생성에 실패해 브라우저 인쇄 창을 엽니다. "PDF로 저장"을 고르세요.\n(' + e.message + ')'); window.print(); }
  finally { btn.disabled = false; btn.textContent = '악보 PDF 받기'; }
});
async function collectShareFiles() {
  const name = safeTitle();
  const q = `${$('easy').checked ? '&easy=1' : ''}${$('solfege').checked ? '&solfege=1' : ''}`;
  const [pdf, midi, xml] = await Promise.all([makePdfBlob(), fetch(`/api/jobs/${jobId}/midi?x=1${$('easy').checked ? '&easy=1' : ''}`).then(r => r.blob()), fetch(`/api/jobs/${jobId}/musicxml?x=1${q}`).then(r => r.blob())]);
  const files = [
    new File([pdf], `${name}.pdf`, { type: 'application/pdf' }),
    new File([midi], `${name}.mid`, { type: 'audio/midi' }),
    new File([xml], `${name}.musicxml`, { type: 'application/vnd.recordare.musicxml+xml' }),
  ];
  if (R.chords.length || R.lyrics.length) files.splice(1, 0, new File([leadPdfBlob()], `${name} 리드시트.pdf`, { type: 'application/pdf' }));
  return files;
}
$('share').addEventListener('click', async () => {
  if (!R) return;
  const btn = $('share'); btn.disabled = true; btn.textContent = '파일 준비 중…';
  try {
    const files = await collectShareFiles();
    const data = { title: `${R.title} 악보`, text: `${R.title} — 채보 (${R.key}, ${R.timeSignature}, ${R.bpm} BPM)`, files };
    if (navigator.share && navigator.canShare && navigator.canShare(data)) await navigator.share(data);
    else if (navigator.share && navigator.canShare && navigator.canShare({ files: [files[0]] })) await navigator.share({ title: data.title, text: data.text, files: [files[0]] });
    else showSharePanel();
  } catch (e) { if (e.name !== 'AbortError') { console.error(e); showSharePanel(); } }
  finally { btn.disabled = false; btn.textContent = '공유 (카톡·메일)'; }
});
function showSharePanel() {
  $('sharePanel').classList.remove('hidden');
  const why = !window.isSecureContext ? '지금 주소가 http라서 휴대폰 공유 창을 열 수 없습니다. 아래 https 주소로 다시 여세요.'
    : !navigator.share ? '이 브라우저는 공유 창(Web Share)을 지원하지 않습니다.' : '이 브라우저는 파일 공유를 지원하지 않습니다.';
  $('shareWhy').textContent = why;
  const subject = encodeURIComponent(`${R.title} 악보`);
  const body = encodeURIComponent(`${R.title}\n채보: ${R.key}, ${R.timeSignature}, 약 ${R.bpm} BPM, ${R.noteCount}음\n\n(악보 PDF·MIDI·MusicXML 파일을 첨부해 주세요)\n${location.href}`);
  $('mailLink').href = `mailto:?subject=${subject}&body=${body}`;
}
$('copyLink').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); $('copyLink').textContent = '복사됨'; setTimeout(() => $('copyLink').textContent = '결과 링크 복사', 1500); }
  catch { prompt('이 주소를 복사하세요', location.href); }
});
$('dlAll').addEventListener('click', async () => { for (const f of await collectShareFiles()) { saveBlob(f, f.name); await new Promise(r => setTimeout(r, 400)); } });

// ---------- 주소의 #job=ID 로 기존 결과 다시 열기 ----------
(function () { const m = location.hash.match(/job=([a-f0-9]+)/); if (m) { $('progressCard').classList.remove('hidden'); poll(m[1]); } })();
