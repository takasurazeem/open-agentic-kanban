// Keeps the data dir in a git repo: debounced auto-commits, and (when a remote exists) pull/push.
// Every failure is logged and swallowed; git trouble must never take the board down.
// KANBAN_GIT_SYNC=0 disables everything here.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appendLines } from './fsutil.mjs';

const ENABLED = process.env.KANBAN_GIT_SYNC !== '0';
const DELAY = Number(process.env.KANBAN_COMMIT_DELAY_MS ?? 60_000);
const MAX_WAIT = Number(process.env.KANBAN_COMMIT_MAX_MS ?? 300_000);
const PULL_EVERY = Number(process.env.KANBAN_PULL_INTERVAL_MS ?? 300_000);
const log = (...a) => console.warn('[git]', ...a);

let dir = null;
let notes = new Map(); // item/project key -> Set of notes, in first-seen order
let firstAt = 0;
let timer = null;
let queue = Promise.resolve(); // serialises all git work
const st = { remote: null, lastCommitAt: null, lastPullAt: null, lastPushAt: null, lastError: null, conflicts: [] };

export function status() {
  return { enabled: ENABLED, ...st, pending: notes.size > 0, conflicts: st.conflicts.slice(-10) };
}

const env = () => {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  try {
    if (execFileSync('git', ['config', 'user.email'], { cwd: dir, encoding: 'utf8' }).trim()) return e;
  } catch {}
  return { ...e, GIT_AUTHOR_NAME: 'Agentic Kanban', GIT_AUTHOR_EMAIL: 'kanban@localhost', GIT_COMMITTER_NAME: 'Agentic Kanban', GIT_COMMITTER_EMAIL: 'kanban@localhost' };
};

const git = (...args) =>
  new Promise((resolve, reject) =>
    execFile('git', args, { cwd: dir, env: env(), timeout: 120_000, maxBuffer: 64e6 }, (err, stdout, stderr) =>
      err ? reject(Object.assign(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`), { stdout, stderr })) : resolve(stdout),
    ),
  );
const gitSync = (...args) => execFileSync('git', args, { cwd: dir, env: env(), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
const show = (spec) => git('show', spec).catch(() => null);

function enqueue(fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      st.lastError = null;
    } catch (e) {
      st.lastError = e.message;
      log(e.message);
    }
  });
  return queue;
}

/** Called once at startup, before the board is loaded. Sets the repo up; the first sync runs async. */
export function init(dataDir) {
  if (!ENABLED) return;
  dir = dataDir;
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      gitSync('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(dir, '.gitattributes'), '*.jsonl merge=union\n');
      fs.writeFileSync(path.join(dir, '.gitignore'), '.DS_Store\n.*.tmp-*\n.kanban.lock\n');
      fs.writeFileSync(path.join(dir, 'README.md'), README);
      gitSync('add', '-A');
      gitSync('commit', '-q', '-m', 'Initialize kanban data repo');
    }
    // Keep the lock file out of git even in repos created before it existed.
    const exclude = path.join(dir, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.includes('.kanban.lock')) fs.appendFileSync(exclude, (cur && !cur.endsWith('\n') ? '\n' : '') + '.kanban.lock\n.conflicts/\n');
  } catch (e) {
    st.lastError = `init failed: ${e.stderr?.toString().trim() || e.message}`;
    log(st.lastError);
  }
  setInterval(() => enqueue(cycle), PULL_EVERY).unref();
  enqueue(cycle);
}

/* ---------- one sync cycle: commit -> fetch -> merge -> push ---------- */

async function recover() {
  const gd = path.join(dir, '.git');
  if (fs.existsSync(path.join(gd, 'rebase-merge')) || fs.existsSync(path.join(gd, 'rebase-apply'))) await git('rebase', '--abort');
  if (fs.existsSync(path.join(gd, 'MERGE_HEAD'))) await git('merge', '--abort');
}

const unmerged = async () => {
  const out = await git('ls-files', '-u', '-z');
  const files = new Map();
  for (const rec of out.split('\0').filter(Boolean)) {
    const m = /^\d+ [0-9a-f]+ (\d)\t(.*)$/s.exec(rec);
    if (m) files.set(m[2], new Set([...(files.get(m[2]) ?? []), Number(m[1])]));
  }
  return files;
};

async function commitPending() {
  if ((await unmerged()).size) throw new Error('unmerged paths present; refusing to commit');
  const { subject, body } = message();
  await git('add', '-A');
  if (!(await git('status', '--porcelain')).trim()) return false;
  notes = new Map();
  firstAt = 0;
  await git('commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
  st.lastCommitAt = new Date().toISOString();
  return true;
}

async function cycle() {
  if (!ENABLED || !dir) return;
  await recover();
  await commitPending();
  const remotes = (await git('remote')).split('\n').map((x) => x.trim()).filter(Boolean);
  st.remote = remotes[0] ?? null; // re-checked every cycle, so a remote added later just starts working
  if (!st.remote) return;
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  await git('fetch', '--quiet', st.remote);
  st.lastPullAt = new Date().toISOString();
  const up = `${st.remote}/${branch}`;
  const hasUp = await git('rev-parse', '--verify', '--quiet', `refs/remotes/${up}`).then(() => true, () => false);
  const counts = async () => (await git('rev-list', '--left-right', '--count', `HEAD...${up}`)).trim().split(/\s+/).map(Number);
  if (hasUp) {
    const [, behind] = await counts();
    if (behind > 0) await mergeRemote(up);
  }
  const ahead = hasUp ? (await counts())[0] : 1;
  if (ahead > 0) {
    await git('push', '-u', st.remote, branch);
    st.lastPushAt = new Date().toISOString();
  }
}

/* ---------- merging with conflict resolution (local wins, remote is recorded) ---------- */

const fenced = (text) => {
  let f = '```';
  while (text.includes(f)) f += '`';
  return `${f}\n${text.replace(/\n$/, '')}\n${f}`;
};
const noteEntry = (text) => JSON.stringify({ id: `ev_conflict_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), actor: 'you', kind: 'log', text }) + '\n';
const NOTE = 'Conflicting edit from another device was not applied:';

function nextFree(pid) {
  let max = 0;
  for (const f of fs.readdirSync(path.join(dir, pid, 'items'))) {
    const m = /^(\d+)\./.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function mergeRemote(up) {
  try {
    await git('merge', '--no-edit', up);
    return;
  } catch (e) {
    const files = await unmerged().catch(() => new Map());
    if (!files.size) {
      await git('merge', '--abort').catch(() => {});
      throw e;
    }
    try {
      await resolve(files);
      await git('add', '-A');
      if ((await unmerged()).size) throw new Error('conflicts remain after resolution');
      await git('commit', '-q', '--no-edit');
    } catch (e2) {
      await git('merge', '--abort').catch(() => {});
      throw new Error(`merge failed and was aborted: ${e2.message}`);
    }
  }
}

async function resolve(files) {
  const abs = (f) => path.join(dir, f);
  const items = [], rest = [];
  for (const [file, stages] of files) (/^[^/]+\/items\/\d+\.md$/.test(file) ? items : rest).push([file, stages]);
  const bothAdded = new Set();
  for (const [file, stages] of items) if (stages.has(2) && stages.has(3) && !stages.has(1)) bothAdded.add(file.replace(/\.md$/, '.activity.jsonl'));
  for (const [file, stages] of rest) {
    if (bothAdded.has(file)) continue;
    if (file.endsWith('.jsonl')) {
      const ours = (await show(`HEAD:${file}`)) ?? '';
      const theirs = (await show(`MERGE_HEAD:${file}`)) ?? '';
      const lines = [...new Set([...ours.split('\n'), ...theirs.split('\n')].filter((l) => l.trim()))];
      fs.writeFileSync(abs(file), lines.map((l) => l + '\n').join(''));
    } else {
      // project.json, actors.json, anything else: local wins, the remote copy is kept under .conflicts/
      if (stages.has(3)) {
        const theirs = await git('show', `:3:${file}`);
        const out = abs(`.conflicts/${file.replace(/\//g, '__')}.${Date.now()}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, theirs);
      }
      if (stages.has(2)) fs.writeFileSync(abs(file), await git('show', `:2:${file}`));
      else {
        await git('rm', '-q', '--cached', '--', file);
        fs.rmSync(abs(file), { force: true });
      }
      st.conflicts.push(`${file}: remote version saved in .conflicts/`);
    }
  }
  for (const [file, stages] of items) {
    const [, pid, n] = /^([^/]+)\/items\/(\d+)\.md$/.exec(file);
    const act = `${pid}/items/${n}.activity.jsonl`;
    if (!stages.has(2)) {
      // Deleted here, edited there: keep the deletion.
      await git('rm', '-q', '--cached', '--', file);
      fs.rmSync(abs(file), { force: true });
      st.conflicts.push(`${file}: deleted locally, remote edit dropped`);
    } else if (!stages.has(3)) {
      fs.writeFileSync(abs(file), await git('show', `:2:${file}`));
    } else if (!stages.has(1)) {
      // Both sides created the same number: keep ours, give theirs the next free number.
      const ours = await git('show', `:2:${file}`);
      const theirs = await git('show', `:3:${file}`);
      const m = nextFree(pid);
      const oursLog = (await show(`HEAD:${act}`)) ?? '';
      const theirsLog = (await show(`MERGE_HEAD:${act}`)) ?? '';
      fs.writeFileSync(abs(file), ours);
      fs.writeFileSync(abs(act), oursLog);
      fs.writeFileSync(abs(`${pid}/items/${m}.md`), theirs.replace(/^number:.*$/m, `number: ${m}`));
      fs.writeFileSync(abs(`${pid}/items/${m}.activity.jsonl`), theirsLog);
      appendLines(abs(`${pid}/items/${m}.activity.jsonl`), noteEntry(`Another device also created #${n} (${pid}). It was kept here as #${m}; the local #${n} was left unchanged.`));
      st.conflicts.push(`${pid}#${n}: remote copy saved as #${m}`);
    } else {
      fs.writeFileSync(abs(file), await git('show', `:2:${file}`));
      const theirs = await git('show', `:3:${file}`);
      fs.mkdirSync(path.dirname(abs(act)), { recursive: true });
      appendLines(abs(act), noteEntry(`${NOTE}\n\n${fenced(theirs)}`));
      st.conflicts.push(`${pid}#${n}: remote edit recorded in activity`);
    }
  }
}

function message() {
  const parts = [...notes].map(([k, v]) => (k === 'misc' ? [...v].join(', ') : `${k}: ${[...v].join(', ')}`));
  const all = parts.join('; ');
  if (all.length <= 72) return { subject: all || 'Update board', body: '' };
  let subject = '';
  let used = 0;
  for (const p of parts) {
    if ((subject ? `${subject}; ${p}` : p).length > 60) break;
    subject = subject ? `${subject}; ${p}` : p;
    used++;
  }
  if (!subject) subject = parts[0].slice(0, 60);
  const rest = parts.length - used;
  return { subject: rest > 0 ? `${subject} (+${rest} more)` : subject, body: parts.join('\n') };
}

/** Record that something changed; entries look like "demo#4: claude → needs_review". */
export function changed(list = []) {
  if (!ENABLED || !dir) return;
  for (const n of list) {
    const m = /^([^:]+): (.*)$/.exec(n);
    const [k, v] = m ? [m[1], m[2]] : ['misc', n];
    notes.set(k, new Set([...(notes.get(k) ?? []), v]));
  }
  const t = Date.now();
  if (!firstAt) firstAt = t;
  clearTimeout(timer);
  timer = setTimeout(() => enqueue(cycle), Math.max(0, Math.min(DELAY, firstAt + MAX_WAIT - t)));
  timer.unref?.();
}

/** Commit and sync anything pending right now (used on shutdown and in tests). */
export function flush() {
  clearTimeout(timer);
  if (!ENABLED || !dir) return Promise.resolve();
  return enqueue(cycle);
}

const README = `# Kanban data

Private data for the Agentic Kanban board. Auto-committed by the board server; hand edits are fine.

\`\`\`
actors.json                          who can be assigned (humans and agents)
<project>/project.json               name, description, visibility, statuses
<project>/items/<n>.md               one item: YAML front matter + markdown body
<project>/items/<n>.activity.jsonl   the item's timeline, append-only (one JSON object per line)
\`\`\`

Missing front-matter fields get defaults. \`*.jsonl\` files merge with the \`union\` strategy.
`;
