// Demucs 스템 분리 (3단계). 프로젝트 안 .venv에 설치된 demucs를 쓴다.
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const MODEL = 'htdemucs_6s'; // vocals, drums, bass, guitar, piano, other

export function demucsBin(root) { return path.join(root, '.venv', 'bin', 'demucs'); }
export async function demucsAvailable(root) {
  try { await fs.access(demucsBin(root)); return true; } catch { return false; }
}

/** @returns {{vocals, drums, bass, guitar, piano, other, no_drums}} 파일 경로 */
export async function separateStems(root, input, outDir, { signal, log = () => {} } = {}) {
  await fs.mkdir(outDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(demucsBin(root), ['-n', MODEL, '-d', 'cpu', '--mp3', '--mp3-bitrate', '128', '-o', outDir, input], { stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    const onData = d => { const s = d.toString(); const m = s.match(/(\d+)%\|/g); if (m) { const pct = m[m.length - 1]; if (pct !== last) { last = pct; log(`Demucs ${pct.replace('|', '')}`); } } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const onAbort = () => { child.kill('SIGTERM'); reject(new Error('cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', code => { signal?.removeEventListener('abort', onAbort); code === 0 ? resolve() : reject(new Error(`Demucs 실패 (code ${code})`)); });
  });
  const base = path.join(outDir, MODEL, path.parse(input).name);
  const stems = {};
  for (const s of ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']) {
    const f = path.join(base, `${s}.mp3`);
    await fs.access(f);
    stems[s] = f;
  }
  // 드럼 뺀 믹스 (피아노 편곡·코드·가사용)
  const noDrums = path.join(base, 'no_drums.mp3');
  await run('ffmpeg', ['-y', '-i', stems.vocals, '-i', stems.bass, '-i', stems.guitar, '-i', stems.piano, '-i', stems.other,
    '-filter_complex', 'amix=inputs=5:normalize=0', '-b:a', '128k', noDrums]);
  stems.no_drums = noDrums;
  return stems;
}
