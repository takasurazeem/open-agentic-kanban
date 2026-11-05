// Keeps the data dir in a git repo: debounced auto-commits, and (when a remote exists) pull/push.
// Every failure is logged and swallowed; git trouble must never take the board down.
// KANBAN_GIT_SYNC=0 disables everything here.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ENABLED = process.env.KANBAN_GIT_SYNC !== '0';
const DELAY = Number(process.env.KANBAN_COMMIT_DELAY_MS ?? 60_000);
const MAX_WAIT = Number(process.env.KANBAN_COMMIT_MAX_MS ?? 300_000);
const PULL_EVERY = Number(process.env.KANBAN_PULL_INTERVAL_MS ?? 300_000);
const log = (...a) => console.warn('[git]', ...a);

let dir = null;
let notes = new Map(); // item/project key -> Set of notes, in first-seen order
let firstAt = 0;
let timer = null;
let queue = Promise.resolve(); // serialises git commands
let hasRemote = false;

const env = () => {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  try {
    const have = execFileSync('git', ['config', 'user.email'], { cwd: dir, encoding: 'utf8' }).trim();
    if (have) return e;
  } catch {}
  return { ...e, GIT_AUTHOR_NAME: 'Agentic Kanban', GIT_AUTHOR_EMAIL: 'kanban@localhost', GIT_COMMITTER_NAME: 'Agentic Kanban', GIT_COMMITTER_EMAIL: 'kanban@localhost' };
};

const git = (...args) =>
  new Promise((resolve, reject) =>
    execFile('git', args, { cwd: dir, env: env(), timeout: 120_000, maxBuffer: 16e6 }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`)) : resolve(stdout),
    ),
  );
const gitSync = (...args) => execFileSync('git', args, { cwd: dir, env: env(), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
const enqueue = (fn) => (queue = queue.then(fn, fn).catch((e) => log(e.message)));

function hasUpstream() {
  try {
    gitSync('rev-parse', '--abbrev-ref', '@{u}');
    return true;
  } catch {
    return false;
  }
}

/** Called once at startup, before the board is loaded. Synchronous on purpose. */
export function init(dataDir) {
  if (!ENABLED) return;
  dir = dataDir;
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      gitSync('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(dir, '.gitattributes'), '*.jsonl merge=union\n');
      fs.writeFileSync(path.join(dir, '.gitignore'), '.DS_Store\n.*.tmp-*\n');
      fs.writeFileSync(path.join(dir, 'README.md'), README);
      gitSync('add', '-A');
      gitSync('commit', '-q', '-m', 'Initialize kanban data repo');
    }
    hasRemote = gitSync('remote').trim().length > 0;
    if (hasRemote) pullSync();
  } catch (e) {
    log('init failed:', e.stderr?.toString().trim() || e.message);
  }
  if (hasRemote) setInterval(() => enqueue(pull), PULL_EVERY).unref();
}

function pullSync() {
  if (!hasUpstream()) return log('no upstream configured; skipping pull');
  try {
    gitSync('pull', '--rebase', '--autostash');
  } catch (e) {
    log('pull failed:', e.stderr?.toString().trim() || e.message);
    try { gitSync('rebase', '--abort'); } catch {}
  }
}

async function pull() {
  if (!hasRemote || !hasUpstream()) return;
  try {
    await git('pull', '--rebase', '--autostash');
  } catch (e) {
    log(e.message);
    await git('rebase', '--abort').catch(() => {});
  }
}

async function push() {
  if (!hasRemote) return;
  try {
    if (hasUpstream()) await git('push');
    else {
      const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
      const remote = (await git('remote')).split('\n')[0].trim();
      await git('push', '-u', remote, branch);
    }
  } catch (e) {
    log(e.message, '- retrying after a pull');
    await pull();
    await git('push').catch((e2) => log(e2.message));
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

async function commitNow() {
  if (!ENABLED || !dir) return;
  const { subject, body } = message();
  notes = new Map();
  firstAt = 0;
  try {
    await git('add', '-A');
    if (!(await git('status', '--porcelain')).trim()) return;
    await git('commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
    await push();
  } catch (e) {
    log(e.message);
  }
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
  timer = setTimeout(() => enqueue(commitNow), Math.max(0, Math.min(DELAY, firstAt + MAX_WAIT - t)));
  timer.unref?.();
}

/** Commit anything pending right now (used on shutdown and in tests). */
export function flush() {
  clearTimeout(timer);
  if (!ENABLED || !dir) return Promise.resolve();
  return enqueue(commitNow);
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
