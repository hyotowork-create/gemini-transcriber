// 화면(휴대폰 포함)에서 Gemini API 키를 바꾸기 위한 도구.
// 원칙: 저장된 키는 끝 4자리만 보여 준다 · 새 키는 저장 전에 검사한다 · 같은 네트워크(사설 IP)에서 온 요청만 받는다.
import fs from 'node:fs/promises';
import path from 'node:path';

/** 화면에 보여 줄 가린 키 */
export function maskKey(key) {
  if (!key) return null;
  return `…${String(key).slice(-4)}`;
}

/** 키 모양 검사(구글 API 키는 보통 AIza로 시작하는 39자) */
export function looksLikeKey(key) {
  const k = String(key || '').trim();
  return /^[A-Za-z0-9_\-.]{20,200}$/.test(k);
}

/** 같은 와이파이·핫스팟·테일스케일·이 컴퓨터에서 온 요청인지 */
export function isPrivateAddress(ip) {
  if (!ip) return false;
  let a = String(ip).trim();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a === '127.0.0.1' || a.startsWith('127.')) return true;
  if (/^fe80:/i.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a)) return true; // IPv6 링크 로컬·사설
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [p, q] = [Number(m[1]), Number(m[2])];
  if (p === 10) return true;
  if (p === 172 && q >= 16 && q <= 31) return true;   // 아이폰 핫스팟 172.20.10.x 포함
  if (p === 192 && q === 168) return true;
  if (p === 100 && q >= 64 && q <= 127) return true;  // 테일스케일
  if (p === 169 && q === 254) return true;
  return false;
}

/** .env 내용에서 GEMINI_API_KEY 줄만 바꾸거나 더한다. 다른 줄은 그대로 */
export function updateEnvText(text, key) {
  const line = `GEMINI_API_KEY=${key}`;
  const lines = String(text || '').split(/\r?\n/);
  let found = false;
  const out = lines.map(l => {
    if (/^\s*GEMINI_API_KEY\s*=/.test(l)) { found = true; return line; }
    return l;
  });
  if (!found) {
    if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, line);
    else out.push(line);
  }
  let s = out.join('\n');
  if (!s.endsWith('\n')) s += '\n';
  return s;
}

/**
 * 키를 검사한 뒤 .env에 저장하고 지금 돌고 있는 서버에도 바로 적용한다.
 * validate(key) → { ok, warning?, error? }
 */
export async function saveKey(root, key, validate) {
  const k = String(key || '').trim();
  if (!looksLikeKey(k)) return { ok: false, error: '키 모양이 아닙니다. AI Studio에서 복사한 키 전체를 붙여 넣어 주세요.' };
  const v = await validate(k);
  if (!v.ok) return { ok: false, error: v.error || '키를 확인하지 못했습니다.' };
  const envPath = path.join(root, '.env');
  let text = '';
  try { text = await fs.readFile(envPath, 'utf8'); }
  catch {
    try { text = await fs.readFile(path.join(root, '.env.example'), 'utf8'); } catch { text = ''; }
  }
  const tmp = envPath + '.tmp';
  await fs.writeFile(tmp, updateEnvText(text, k), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, envPath);
  process.env.GEMINI_API_KEY = k;
  return { ok: true, warning: v.warning || null, hint: maskKey(k) };
}
