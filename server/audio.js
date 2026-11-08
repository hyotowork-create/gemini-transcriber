// 오디오 준비: 유튜브 다운로드(yt-dlp), 재생용 변환·길이 측정·분할(ffmpeg)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);

export async function hasBinary(name) {
  try {
    await run('which', [name]);
    return true;
  } catch {
    return false;
  }
}

/** 유튜브(또는 yt-dlp가 지원하는 사이트) URL에서 오디오를 받는다. {filePath, title} */
export async function downloadFromUrl(url, outDir) {
  const template = path.join(outDir, 'source.%(ext)s');
  const { stdout } = await run('yt-dlp', [
    '--no-playlist',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '-o', template,
    '--print', 'after_move:%(title)s',
    '--print', 'after_move:filepath',
    '--no-simulate',
    url,
  ], { maxBuffer: 10 * 1024 * 1024 });
  const lines = stdout.trim().split('\n').map(s => s.trim()).filter(Boolean);
  const filePath = lines[lines.length - 1];
  const title = lines.length >= 2 ? lines[lines.length - 2] : '제목 없음';
  await fs.access(filePath);
  return { filePath, title };
}

/** ffprobe로 길이(초) */
export async function probeDuration(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ]);
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d)) throw new Error('오디오 길이를 읽을 수 없습니다');
  return d;
}

/** 브라우저 재생용 mp3 (스테레오 44.1k) */
export async function makePlayback(input, output) {
  await run('ffmpeg', ['-y', '-i', input, '-vn', '-ac', '2', '-ar', '44100', '-b:a', '128k', output]);
  return output;
}

/** Gemini 전송용으로 모노 저음질 mp3를 chunkSec 단위로 자른다. [{index, filePath, offsetSec, durationSec}] */
export async function splitChunks(input, outDir, chunkSec) {
  await fs.mkdir(outDir, { recursive: true });
  const pattern = path.join(outDir, 'chunk_%03d.mp3');
  await run('ffmpeg', [
    '-y', '-i', input, '-vn', '-ac', '1', '-ar', '22050', '-b:a', '64k',
    '-f', 'segment', '-segment_time', String(chunkSec), '-reset_timestamps', '1',
    pattern,
  ]);
  const files = (await fs.readdir(outDir)).filter(f => /^chunk_\d+\.mp3$/.test(f)).sort();
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(outDir, files[i]);
    const durationSec = await probeDuration(filePath);
    chunks.push({ index: i, filePath, offsetSec: offset, durationSec });
    offset += durationSec;
  }
  return chunks;
}
