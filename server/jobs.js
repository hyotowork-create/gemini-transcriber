// 메모리 작업 저장소
import crypto from 'node:crypto';

const jobs = new Map();

export function createJob(init = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id, status: 'queued', progress: 0, message: '대기 중', title: init.title || '',
    createdAt: Date.now(), logs: [], result: null, error: null, dir: init.dir, files: {},
  };
  jobs.set(id, job);
  // 오래된 작업 정리 (최근 50개 유지)
  if (jobs.size > 50) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    jobs.delete(oldest.id);
  }
  return job;
}

export function getJob(id) { return jobs.get(id) || null; }

/** 완료된 작업을 디스크에 남겨 재시작 뒤에도 열 수 있게 한다 */
export async function persistJob(job) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { id, status, progress, message, title, logs, result, createdAt, files } = job;
  await fs.writeFile(path.join(job.dir, 'job.json'), JSON.stringify({ id, status, progress, message, title, logs, result, createdAt, files }), 'utf8');
}

export async function restoreJobs(jobsDir) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  let n = 0;
  for (const name of await fs.readdir(jobsDir).catch(() => [])) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(jobsDir, name, 'job.json'), 'utf8'));
      if (j.status !== 'done') continue;
      jobs.set(j.id, { ...j, dir: path.join(jobsDir, name), error: null });
      n++;
    } catch { /* 저장 안 된 작업은 건너뛴다 */ }
  }
  return n;
}

export function publicView(job) {
  const { id, status, progress, message, title, logs, result, error, createdAt } = job;
  return { id, status, progress, message, title, logs: logs.slice(-20), result, error, createdAt };
}
