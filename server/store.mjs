// File-per-item store shared by the web UI (through the HTTP API) and agents (through MCP → HTTP).
//
// Every project keeps its cards in its own code repo, in <repo>/.kanban/ (see attachRepo):
//
//   <repo>/.kanban/project.json
//   <repo>/.kanban/items/<n>/item.md            front matter (YAML) + markdown body
//   <repo>/.kanban/items/<n>/activity.jsonl     append-only, one JSON object per line
//   <repo>/.kanban/items/<n>/attachments/<file> uploaded files; the folder listing is the source of truth
//
// .kanban/ is part of the code repo, so the board ships with the project (commit cards with your code). If
// .kanban/ has its own .git it is a nested repo that the server also auto-commits and syncs. There is no
// central board store. The config dir holds only machine-local state:
//
//   <config>/actors.json      who can be assigned (humans and agents)
//   <config>/.registry.json   project id -> code repo folder
//
// The boards are indexed in memory. Mutations persist only what changed, each .kanban/ is watched so hand
// edits / `git pull` are picked up, and gitsync.mjs auto-commits each one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { DEFAULT_ACTORS, DEFAULT_STATUSES, normRepo, normRepos } from './model.mjs';
import * as gitsync from './gitsync.mjs';
import { appendLines } from './fsutil.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expand = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
export const CONFIG_DIR = path.resolve(expand(process.env.KANBAN_CONFIG_DIR || '~/.config/agentic-kanban'));
// Boards used to live in one central data dir. Actors and the repo registry are copied out of it once.
const LEGACY_DIR = path.resolve(expand(process.env.KANBAN_DATA_DIR || '~/Developer/kanban-data'));

export { AGENT_STATES, PRIORITIES, SIZES, DEFAULT_STATUSES } from './model.mjs';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const listeners = new Set();
const log = (...a) => console.warn('[store]', ...a);

/* ---------- (de)serialisation ---------- */

const ITEM_ORDER = ['number', 'title', 'status', 'rank', 'priority', 'size', 'labels', 'assignees', 'agent', 'createdAt', 'updatedAt'];

const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));

export function normalizeItem(raw, number, fallbackTime) {
  const t = fallbackTime ?? new Date().toISOString();
  const r = raw ?? {};
  return {
    number: Number(r.number ?? number),
    title: str(r.title, `Item ${r.number ?? number}`),
    body: str(r.body),
    status: str(r.status, 'todo'),
    rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : 0,
    priority: r.priority ?? null,
    size: r.size ?? null,
    labels: Array.isArray(r.labels) ? r.labels.map(String) : [],
    assignees: Array.isArray(r.assignees) ? r.assignees.map(String) : [],
    agent: { state: 'idle', ...(r.agent && typeof r.agent === 'object' ? r.agent : {}) },
    activity: Array.isArray(r.activity) ? r.activity : [],
    attachments: [], // derived from the item's attachments folder (see listAttachments), never stored in the .md
    createdAt: str(r.createdAt, t),
    updatedAt: str(r.updatedAt, str(r.createdAt, t)),
  };
}

function normalizeProject(raw, id) {
  const r = raw ?? {};
  return {
    id,
    name: str(r.name, id),
    description: str(r.description),
    visibility: r.visibility === 'public' ? 'public' : 'private',
    repos: normRepos(r.repos),
    statuses: Array.isArray(r.statuses) && r.statuses.length ? r.statuses : structuredClone(DEFAULT_STATUSES),
    createdAt: str(r.createdAt, new Date().toISOString()),
    items: [],
  };
}

export function itemToMarkdown(it) {
  const front = {};
  for (const k of ITEM_ORDER) front[k] = it[k] === undefined ? null : it[k];
  const yaml = YAML.stringify(front, { lineWidth: 0 });
  const body = it.body ?? '';
  return `---\n${yaml}---\n\n${body}${body ? '\n' : ''}`;
}

export function markdownToItem(text, number, fallbackTime) {
  const m = /^---\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  let front = {};
  let body = text;
  if (m) {
    try {
      front = YAML.parse(m[1]) ?? {};
    } catch (e) {
      throw new Error(`bad front matter: ${e.message}`);
    }
    body = m[2].replace(/^\r?\n/, '').replace(/\r\n/g, '\n');
    if (body.endsWith('\n')) body = body.slice(0, -1);
  }
  return normalizeItem({ ...front, body, number }, number, fallbackTime);
}

const stable = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );

/* ---------- disk helpers ---------- */

const safeId = (id) => typeof id === 'string' && id.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
const validNumber = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1e9;
const checkId = (id) => {
  if (!safeId(id)) throw new HttpError(400, `Invalid project id "${id}"`);
  return id;
};
const checkNum = (n) => {
  if (!validNumber(n)) throw new HttpError(400, `Invalid item number "${n}"`);
  return n;
};

/** Board folder inside a code repo. */
export const BOARD_DIR = '.kanban';
// Projects that live in a code repo instead of the central data dir: id -> { path: <repo root> }.
// Machine-local (absolute paths), so it is kept out of the data dir's git repo.
let registry = {};
const REGISTRY_FILE = path.join(CONFIG_DIR, '.registry.json');
/** Where a project's project.json and items/ live: its repo's .kanban/ folder. */
const projDir = (pid) => {
  checkId(pid);
  const r = registry[pid];
  if (!r) throw new HttpError(404, `No project "${pid}"`);
  return path.join(r.path, BOARD_DIR);
};
const p = {
  actors: () => path.join(CONFIG_DIR, 'actors.json'),
  dir: (pid) => projDir(pid),
  project: (pid) => path.join(projDir(pid), 'project.json'),
  items: (pid) => path.join(projDir(pid), 'items'),
  md: (pid, n) => path.join(projDir(pid), 'items', String(checkNum(n)), 'item.md'),
  log: (pid, n) => path.join(projDir(pid), 'items', String(checkNum(n)), 'activity.jsonl'),
  itemDir: (pid, n) => path.join(projDir(pid), 'items', String(checkNum(n))),
  attachments: (pid, n) => path.join(projDir(pid), 'items', String(checkNum(n)), 'attachments'),
};

/* ---------- attachments ---------- */

export const MAX_ATTACHMENT_BYTES = (Number(process.env.KANBAN_MAX_ATTACHMENT_MB) || 10) * 1024 * 1024;

/** The files in an item's attachments folder. The folder is the source of truth (hand-drop files in if you like). */
export function listAttachments(pid, n) {
  const dir = p.attachments(pid, n);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of entries) {
    if (!d.isFile() || d.name.startsWith('.')) continue; // skips temp files and .DS_Store
    try {
      const st = fs.statSync(path.join(dir, d.name));
      out.push({ name: d.name, size: st.size, modifiedAt: st.mtime.toISOString() });
    } catch {}
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A safe single path segment: no directories, control characters or leading dots. */
function cleanFileName(raw) {
  let s = path.basename(String(raw ?? '').replace(/\\/g, '/')).normalize('NFC');
  s = s.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim().replace(/^\.+/, '');
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 20);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  if (!s) throw new HttpError(400, 'A file name is required');
  return s;
}

function freeName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/** Write a file into the item's attachments folder and refresh `item.attachments`. Never overwrites. */
export function saveAttachment(pid, item, rawName, buf) {
  if (!buf.length) throw new HttpError(400, 'The file is empty');
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(413, `Attachments can be at most ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
  }
  const dir = p.attachments(pid, item.number);
  const name = freeName(dir, cleanFileName(rawName));
  writeAtomic(path.join(dir, name), buf);
  item.attachments = listAttachments(pid, item.number);
  return item.attachments.find((a) => a.name === name);
}

export function deleteAttachment(pid, item, name) {
  const found = listAttachments(pid, item.number).find((a) => a.name === name);
  if (!found) throw new HttpError(404, `No attachment "${name}" on #${item.number}`);
  const dir = p.attachments(pid, item.number);
  removeFile(path.join(dir, found.name));
  for (const d of [dir, p.itemDir(pid, item.number)]) {
    try {
      fs.rmdirSync(d); // only succeeds when empty
    } catch {}
  }
  item.attachments = listAttachments(pid, item.number);
}

/** Absolute path and size of an attachment, matched by exact name against the folder listing. */
export function attachmentFile(pid, number, name) {
  const found = listAttachments(pid, Number(number)).find((a) => a.name === name);
  if (!found) throw new HttpError(404, `No attachment "${name}" on #${number}`);
  return { file: path.join(p.attachments(pid, Number(number)), found.name), name: found.name, size: found.size };
}

// Signature (mtime:size) of every file as last read or written by us; a mismatch means someone else changed it.
const sigs = new Map();
const sigOf = (f) => {
  try {
    const st = fs.statSync(f);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
};
const track = (f) => sigs.set(f, sigOf(f));

// Things we could not load or that look wrong; reported by GET /api/sync and never overwritten.
const problems = new Map();
const setProblem = (key, o) => {
  problems.set(key, o);
  log(o.message);
};
const clearProblem = (key) => problems.delete(key);
export const getProblems = () => [...problems.values()];

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  track(file);
}

function append(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  appendLines(file, text);
  track(file);
}

function removeFile(file) {
  fs.rmSync(file, { force: true });
  sigs.set(file, null);
}

const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

function readActivity(file) {
  track(file);
  const text = readText(file);
  if (!text) return [];
  const out = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  const key = `bad-activity:${file}`;
  if (bad) setProblem(key, { kind: 'bad-activity', path: file, message: `${file.replace(os.homedir(), '~')}: skipped ${bad} unparseable line(s)` });
  else clearProblem(key);
  return out;
}

function readItem(pid, n) {
  track(p.md(pid, n));
  const text = readText(p.md(pid, n));
  if (text == null) return null;
  let t;
  try {
    t = fs.statSync(p.md(pid, n)).birthtime.toISOString();
  } catch {}
  const it = markdownToItem(text, n, t);
  it.activity = readActivity(p.log(pid, n));
  it.attachments = listAttachments(pid, n);
  return it;
}

function readProjectMeta(pid) {
  track(p.project(pid));
  const text = readText(p.project(pid));
  if (text == null) return null;
  return normalizeProject(JSON.parse(text), pid);
}

function readProject(pid) {
  const proj = readProjectMeta(pid);
  if (!proj) return null;
  let names = [];
  try {
    names = fs.readdirSync(p.items(pid));
  } catch {}
  for (const f of names) {
    const m = /^(\d+)$/.exec(f);
    if (!m || !fs.existsSync(path.join(p.items(pid), f, 'item.md'))) continue; // a card is a folder holding item.md
    const n = Number(m[1]);
    const key = `item:${pid}/${n}`;
    if (String(n) !== m[1] || !validNumber(n)) {
      setProblem(key, { kind: 'unreadable-item', project: pid, number: null, path: `${pid}/items/${f}`, message: `${pid}/items/${f}: not a canonical item folder name; ignored` });
      continue;
    }
    try {
      const it = readItem(pid, n);
      if (it) proj.items.push(it);
      clearProblem(key);
    } catch (e) {
      setProblem(key, { kind: 'unreadable-item', project: pid, number: n, path: `${pid}/items/${f}/item.md`, message: `${pid}/items/${f}/item.md: ${e.message} (left untouched)` });
    }
  }
  proj.items.sort((a, b) => a.number - b.number);
  if (registry[pid]) proj.repoPath = registry[pid].path; // not stored in project.json
  return proj;
}

const sortProjects = (arr) => arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

function readAll() {
  let actors = [];
  track(p.actors());
  try {
    actors = JSON.parse(readText(p.actors()) ?? '[]');
  } catch (e) {
    log('bad actors.json:', e.message);
  }
  return { version: 1, actors, projects: [] };
}

const projectMeta = ({ items, repoPath, ...meta }) => meta;
const writeProjectMeta = (proj) => writeAtomic(p.project(proj.id), JSON.stringify(projectMeta(proj), null, 2) + '\n');
function writeItemFull(pid, it) {
  writeAtomic(p.md(pid, it.number), itemToMarkdown(it));
  writeAtomic(p.log(pid, it.number), jsonl(it.activity ?? []));
}

/* ---------- one server per config dir ---------- */

function acquireLock(dir = CONFIG_DIR) {
  const LOCK = path.join(dir, '.kanban.lock');
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      process.on('exit', () => {
        try {
          if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK);
        } catch {}
      });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readText(LOCK));
      let alive = false;
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (err) {
          alive = err.code === 'EPERM';
        }
      }
      if (alive) throw new Error(`${dir} is already in use by process ${pid}. Stop it first (or set KANBAN_CONFIG_DIR).`);
      if (pid === process.pid) return;
      log(`taking over stale lock from process ${pid}`);
      fs.rmSync(LOCK, { force: true });
    }
  }
  throw new Error(`Could not lock ${dir}`);
}

/* ---------- boards that live in code repos ---------- */

function readRegistry() {
  try {
    const j = JSON.parse(readText(REGISTRY_FILE) ?? '{}');
    const out = {};
    for (const [id, v] of Object.entries(j.projects ?? {})) if (safeId(id) && typeof v?.path === 'string') out[id] = { path: v.path };
    return out;
  } catch (e) {
    log('bad .registry.json:', e.message);
    return {};
  }
}
const writeRegistry = () => writeAtomic(REGISTRY_FILE, JSON.stringify({ projects: registry }, null, 2) + '\n');

const roots = new Map(); // project id -> { sync, watcher }; sync is null when the code repo itself tracks .kanban/

/** Route change notes ("demo#4: claude → running") to the git repo that holds that project. */
function notifyChanged(notes) {
  const groups = new Map();
  for (const n of notes) {
    const pid = /^([^:#\s]+)/.exec(n)?.[1];
    const sync = roots.get(pid)?.sync;
    if (sync) groups.set(sync, [...(groups.get(sync) ?? []), n]);
  }
  for (const [sync, list] of groups) sync.changed(list);
}

const gitOut = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function watchDir(dir, prefix) {
  try {
    const w = fs.watch(dir, { recursive: true }, (type, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (rel === '.git' || rel.startsWith('.git' + path.sep)) return;
      onFsEvent(type, prefix ? path.join(prefix, rel) : rel);
    });
    w.on('error', (e) => log('watcher error:', e.message));
    w.unref?.();
    return w;
  } catch (e) {
    log('cannot watch', dir, e.message);
    return null;
  }
}

/** Keep the server's lock and temp files out of git, and merge activity logs line by line. */
function ensureBoardFiles(dir) {
  const put = (name, text) => {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) fs.writeFileSync(f, text);
  };
  put('.gitignore', '.DS_Store\n.*.tmp-*\n.kanban.lock\n');
  put('.gitattributes', '*.jsonl merge=union\n');
}

/**
 * By default a board is just a folder in its code repo: it is tracked and shipped with the project, and you
 * commit card changes together with code. If .kanban/ is its own git repo (it has a .git), the server also
 * auto-commits and syncs it, so it can have a private remote of its own.
 */
function startRoot(pid) {
  const dir = projDir(pid);
  ensureBoardFiles(dir);
  let sync = null;
  if (fs.existsSync(path.join(dir, '.git'))) {
    sync = gitsync.create(dir, { label: pid, readme: gitsync.BOARD_README });
    sync.init();
  }
  roots.set(pid, { sync, watcher: watchDir(dir, pid) });
}

function stopRoot(pid) {
  const r = roots.get(pid);
  if (!r) return;
  const lock = path.join(projDir(pid), '.kanban.lock');
  roots.delete(pid);
  r.watcher?.close();
  Promise.resolve(r.sync?.stop()).finally(() => {
    try {
      if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
    } catch {}
  });
}

/** Stop using a repo-hosted board without touching its files. */
function detachRoot(pid) {
  stopRoot(pid);
  delete registry[pid];
  writeRegistry();
}

function loadRepoProject(pid) {
  const key = `project:${pid}`;
  const where = registry[pid].path;
  if (!fs.existsSync(p.project(pid))) {
    setProblem(key, { kind: 'missing-board', path: where, message: `${pid}: no board in ${where}/${BOARD_DIR}; skipped (still registered)` });
    return null;
  }
  try {
    acquireLock(projDir(pid));
    migrateItemLayout(pid);
    startRoot(pid);
    clearProblem(key);
    return readProject(pid);
  } catch (e) {
    setProblem(key, { kind: 'locked-board', path: where, message: `${pid}: ${e.message}; skipped` });
    return null;
  }
}

/**
 * Older boards kept items/<n>.md and items/<n>.activity.jsonl side by side. Each card is now a folder,
 * items/<n>/, holding item.md, activity.jsonl and attachments/, so a card is one self-contained unit.
 * Boards in the old layout are renamed in place the first time they load.
 */
function migrateItemLayout(pid) {
  const dir = p.items(pid);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of names) {
    const m = /^([1-9]\d*)\.(md|activity\.jsonl)$/.exec(f);
    if (!m) continue;
    const to = path.join(dir, m[1], m[2] === 'md' ? 'item.md' : 'activity.jsonl');
    if (fs.existsSync(to)) {
      setProblem(`layout:${pid}/${f}`, { kind: 'layout', path: `${pid}/items/${f}`, message: `${pid}/items/${f}: ${m[1]}/${path.basename(to)} already exists; left in place` });
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(path.join(dir, f), to);
  }
}

/** The git repo root that contains `raw`, or an HttpError. */
function resolveRepo(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'path is required');
  const dir = path.resolve(expand(raw.trim()));
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new HttpError(400, `${dir} does not exist`);
  }
  if (!st.isDirectory()) throw new HttpError(400, `${dir} is not a folder`);
  try {
    return fs.realpathSync(gitOut(dir, 'rev-parse', '--show-toplevel'));
  } catch {
    throw new HttpError(400, `${dir} is not inside a git repository`);
  }
}

function registerRepo(pid, repo) {
  registry[pid] = { path: repo };
  writeRegistry();
}

const repoOwner = (repo) => Object.entries(registry).find(([, v]) => v.path === repo)?.[0];

/**
 * Point a code repo at the board: use <repo>/.kanban/ if it already has a board, otherwise create one.
 * Returns the project (with its items) and whether a new board was created.
 */
export function attachRepo(rawPath, { name } = {}) {
  reconcile();
  const repo = resolveRepo(rawPath);
  const owner = repoOwner(repo);
  if (owner) throw new HttpError(409, `${repo} is already the board "${owner}"`);
  const kdir = path.join(repo, BOARD_DIR);
  const metaFile = path.join(kdir, 'project.json');
  let rawMeta = null;
  if (fs.existsSync(metaFile)) {
    try {
      rawMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    } catch (e) {
      throw new HttpError(409, `${metaFile} is not valid JSON (${e.message}); fix or remove it first`);
    }
  }
  const base = safeId(rawMeta?.id) ? rawMeta.id : slugify(name || rawMeta?.name || path.basename(repo));
  let id = base;
  for (let i = 2; state.projects.some((x) => x.id === id) || registry[id]; i++) id = `${base}-${i}`;

  fs.mkdirSync(path.join(kdir, 'items'), { recursive: true });
  acquireLock(kdir);
  registerRepo(id, repo);
  try {
    if (!rawMeta) {
      let remote = '';
      try {
        remote = normRepo(gitOut(repo, 'remote', 'get-url', 'origin'));
      } catch {}
      const meta = normalizeProject({ name: name?.trim() || path.basename(repo), repos: remote ? [remote] : [], createdAt: now() }, id);
      writeProjectMeta(meta);
    }
    migrateItemLayout(id);
    startRoot(id);
    const proj = readProject(id);
    state.projects.push(proj);
    sortProjects(state.projects);
    state.version = (state.version ?? 0) + 1;
    notifyChanged([`${id}: ${rawMeta ? 'board attached' : 'board created'}`]);
    emit({ type: 'project', project: id });
    return { project: proj, created: !rawMeta };
  } catch (e) {
    stopRoot(id);
    delete registry[id];
    writeRegistry();
    throw e;
  }
}

/* ---------- startup ---------- */

/** One-time: copy actors and the repo registry out of the old central data dir (which is left untouched). */
function migrateLegacy() {
  if (LEGACY_DIR === CONFIG_DIR) return;
  for (const f of ['actors.json', '.registry.json']) {
    const from = path.join(LEGACY_DIR, f);
    const to = path.join(CONFIG_DIR, f);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      log(`copied ${from} -> ${to}`);
    }
  }
}

function loadOrInit() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  acquireLock();
  migrateLegacy();
  registry = readRegistry();
  if (!fs.existsSync(p.actors())) writeAtomic(p.actors(), JSON.stringify(DEFAULT_ACTORS, null, 2) + '\n');
  // Projects still sitting in the old central folder are not loaded; say so instead of hiding them.
  try {
    for (const d of fs.readdirSync(LEGACY_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && safeId(d.name) && !registry[d.name] && fs.existsSync(path.join(LEGACY_DIR, d.name, 'project.json'))) {
        setProblem(`legacy:${d.name}`, {
          kind: 'legacy-project', path: path.join(LEGACY_DIR, d.name),
          message: `${d.name}: still in the old data folder ${LEGACY_DIR}; copy it into its repo's ${BOARD_DIR}/ and attach that repo`,
        });
      }
    }
  } catch {}
  const s = readAll();
  for (const pid of Object.keys(registry)) {
    const proj = loadRepoProject(pid);
    if (proj) s.projects.push(proj);
  }
  sortProjects(s.projects);
  return s;
}

let state = loadOrInit();

/* ---------- public API ---------- */

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

function emit(event) {
  for (const l of listeners) l({ ...event, version: state.version });
}

/** Reject drafts that would write unsafe paths, clobber unreadable files, or reuse a number. */
function validate(prev, next) {
  const prevById = new Map(prev.projects.map((x) => [x.id, x]));
  for (const proj of next.projects) {
    const old = prevById.get(proj.id);
    if (!old) checkId(proj.id);
    const oldItems = new Map((old?.items ?? []).map((x) => [x.number, x]));
    for (const it of proj.items) {
      const o = oldItems.get(it.number);
      if (o && stable(o) === stable(it)) continue;
      checkId(proj.id);
      checkNum(it.number);
      if (!o && fs.existsSync(p.md(proj.id, it.number))) {
        throw new HttpError(409, `${proj.id}/items/${it.number}/item.md already exists on disk; refusing to overwrite it`);
      }
      if (problems.has(`item:${proj.id}/${it.number}`)) {
        throw new HttpError(409, `${proj.id}#${it.number} has an unreadable file on disk; fix it by hand first`);
      }
    }
  }
}

/** Persist only the differences between `prev` and `next`; returns human-readable change notes. */
function persist(prev, next) {
  validate(prev, next);
  const notes = new Map(); // key -> string[]
  const note = (key, text) => notes.set(key, [...(notes.get(key) ?? []), text]);

  if (stable(prev.actors) !== stable(next.actors)) {
    writeAtomic(p.actors(), JSON.stringify(next.actors, null, 2) + '\n');
    note('actors', 'updated');
  }
  const prevById = new Map(prev.projects.map((x) => [x.id, x]));
  const nextIds = new Set(next.projects.map((x) => x.id));
  for (const old of prev.projects) {
    if (nextIds.has(old.id)) continue;
    if (registry[old.id]) {
      // A board inside a code repo is only unregistered; its files (and git history) stay where they are.
      note(`project ${old.id}`, `project detached (files stay in ${registry[old.id].path}/${BOARD_DIR})`);
      detachRoot(old.id);
    }
  }
  for (const proj of next.projects) {
    const old = prevById.get(proj.id);
    if (!old) throw new HttpError(400, 'Projects are created by pointing at a git repo (attachRepo)');
    if (stable(projectMeta(old)) !== stable(projectMeta(proj))) {
      writeProjectMeta(proj);
      note(`project ${proj.id}`, 'project settings updated');
    }
    const oldItems = new Map(old.items.map((x) => [x.number, x]));
    const seen = new Set();
    for (const it of proj.items) {
      seen.add(it.number);
      const key = `${proj.id}#${it.number}`;
      const o = oldItems.get(it.number);
      if (!o) {
        writeItemFull(proj.id, it);
        note(key, 'created');
        continue;
      }
      const md = itemToMarkdown(it);
      if (md !== itemToMarkdown(o)) {
        writeAtomic(p.md(proj.id, it.number), md);
        if (it.status !== o.status) note(key, `status → ${it.status}`);
        if (it.agent.state !== o.agent.state) note(key, `${it.agent.by ?? 'agent'} → ${it.agent.state}`);
        if (!notes.has(key) || it.title !== o.title || it.body !== o.body) note(key, 'edited');
      }
      const a = it.activity, b = o.activity;
      const appendOnly = a.length >= b.length && b.every((e, i) => e === a[i] || stable(e) === stable(a[i]));
      if (appendOnly) {
        if (a.length > b.length) {
          append(p.log(proj.id, it.number), jsonl(a.slice(b.length)));
          if (a.slice(b.length).some((e) => e.kind === 'comment')) note(key, 'commented');
          else if (!notes.has(key)) note(key, 'activity');
        }
      } else {
        writeAtomic(p.log(proj.id, it.number), jsonl(a));
      }
    }
    for (const o of old.items) {
      if (seen.has(o.number)) continue;
      removeFile(p.md(proj.id, o.number));
      removeFile(p.log(proj.id, o.number));
      fs.rmSync(p.itemDir(proj.id, o.number), { recursive: true, force: true }); // its attachments
      for (const k of [...sigs.keys()]) if (k.startsWith(p.itemDir(proj.id, o.number) + path.sep)) sigs.delete(k);
      note(`${proj.id}#${o.number}`, 'deleted');
    }
  }
  return [...notes].map(([k, v]) => `${k.replace(/^project /, '')}: ${[...new Set(v)].join(', ')}`);
}

/** Run `fn` against a draft of the state, persist what changed, and broadcast `event`. */
export function mutate(fn, event) {
  reconcile(); // always start from what is on disk
  const draft = structuredClone(state);
  const result = fn(draft);
  draft.version = (state.version ?? 0) + 1;
  const prev = state;
  const notes = persist(prev, draft); // throws before swapping state if validation fails
  state = draft;
  notifyChanged(notes);
  emit(event);
  return result;
}

/** Next free item number: above everything in memory, quarantined, or merely present on disk. */
export function nextItemNumber(proj) {
  let max = Math.max(0, ...proj.items.map((i) => i.number));
  for (const pr of problems.values()) if (pr.project === proj.id && validNumber(pr.number)) max = Math.max(max, pr.number);
  try {
    for (const f of fs.readdirSync(p.items(proj.id))) {
      const m = /^(\d+)(\.|$)/.exec(f); // <n>.md, <n>.activity.jsonl, or the <n>/ attachments folder
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {}
  return max + 1;
}

/* ---------- picking up outside changes (hand edits, git pull) ---------- */

function applyExternal(rel) {
  const parts = rel.split(path.sep);
  if (parts.some((x) => x.startsWith('.') || x.includes('.tmp-'))) return null;
  const [first, second, third] = parts;
  if (parts.length === 1 && first === 'actors.json') {
    track(p.actors());
    let actors;
    try {
      actors = JSON.parse(readText(p.actors()) ?? '[]');
    } catch (e) {
      log('bad actors.json:', e.message);
      return null;
    }
    if (stable(actors) === stable(state.actors)) return null;
    state.actors = actors;
    return { type: 'actors', note: 'actors edited externally' };
  }
  if (!safeId(first)) return null;
  const idx = state.projects.findIndex((x) => x.id === first);
  const exists = fs.existsSync(p.project(first));
  if (!exists) {
    if (idx < 0) return null;
    state.projects.splice(idx, 1);
    return { type: 'project', project: first, note: `${first}: project removed externally` };
  }
  const reloadProject = () => {
    const fresh = readProject(first);
    if (!fresh) return null;
    if (idx >= 0 && stable(state.projects[idx]) === stable(fresh)) return null;
    if (idx >= 0) state.projects[idx] = fresh;
    else {
      state.projects.push(fresh);
      sortProjects(state.projects);
    }
    return { type: 'project', project: first, note: `${first}: project edited externally` };
  };
  if (idx < 0 || parts.length === 1) return reloadProject();
  const proj = state.projects[idx];
  if (second === 'project.json' && parts.length === 2) {
    let meta;
    try {
      meta = readProjectMeta(first);
    } catch (e) {
      log(`bad ${first}/project.json:`, e.message);
      return null;
    }
    if (!meta || stable(projectMeta(meta)) === stable(projectMeta(proj))) return null;
    Object.assign(proj, projectMeta(meta));
    return { type: 'project', project: first, note: `${first}: settings edited externally` };
  }
  if (second === 'items' && parts[3] === 'attachments' && /^[1-9]\d*$/.test(third ?? '')) {
    const an = Number(third);
    const owner = proj.items.find((x) => x.number === an);
    if (!owner) return null;
    const fresh = listAttachments(first, an);
    if (stable(fresh) === stable(owner.attachments ?? [])) return null; // our own write
    owner.attachments = fresh;
    return { type: 'item', project: first, number: an, note: `${first}#${an}: attachments changed externally` };
  }
  const isCardFile = second === 'items' && parts.length === 4 && /^[1-9]\d*$/.test(third ?? '') && /^(item\.md|activity\.jsonl)$/.test(parts[3]);
  if (!isCardFile || !validNumber(Number(third))) return null;
  const n = Number(third);
  const key = `item:${first}/${n}`;
  let fresh;
  try {
    fresh = readItem(first, n);
    clearProblem(key);
  } catch (e) {
    setProblem(key, { kind: 'unreadable-item', project: first, number: n, path: `${first}/items/${n}/item.md`, message: `${first}/items/${n}/item.md: ${e.message} (left untouched)` });
    return null;
  }
  const at = proj.items.findIndex((x) => x.number === n);
  if (!fresh) {
    if (at < 0) return null;
    proj.items.splice(at, 1);
    return { type: 'item', project: first, number: n, note: `${first}#${n}: deleted externally` };
  }
  if (at >= 0 && stable(proj.items[at]) === stable(fresh)) return null;
  if (at >= 0) proj.items[at] = fresh;
  else proj.items.push(fresh), proj.items.sort((a, b) => a.number - b.number);
  return { type: 'item', project: first, number: n, note: `${first}#${n}: edited externally` };
}

function handleExternal(rel) {
  let ev;
  try {
    ev = applyExternal(rel);
  } catch (e) {
    log('reload failed for', rel, e.message);
  }
  if (!ev) return; // our own write, or nothing relevant changed
  const { note, ...event } = ev;
  state.version = (state.version ?? 0) + 1;
  notifyChanged([note]);
  emit(event);
}

/** Reload anything whose file differs from what we last read or wrote (covers the watcher's delay). */
function reconcile() {
  const dirty = new Set();
  const chk = (file, rel) => {
    if (sigOf(file) !== (sigs.get(file) ?? null)) dirty.add(rel);
  };
  try {
    chk(p.actors(), 'actors.json');
    const onDisk = new Set();
    const ids = new Set(Object.keys(registry));
    for (const pid of ids) {
      if (!fs.existsSync(p.project(pid))) continue;
      onDisk.add(pid);
      const proj = state.projects.find((x) => x.id === pid);
      if (!proj) {
        dirty.add(pid);
        continue;
      }
      chk(p.project(pid), `${pid}/project.json`);
      const files = new Set();
      try {
        for (const f of fs.readdirSync(p.items(pid))) {
          if (!/^[1-9]\d*$/.test(f)) continue;
          files.add(`${f}/item.md`);
          files.add(`${f}/activity.jsonl`);
        }
      } catch {}
      for (const it of proj.items) {
        files.add(`${it.number}/item.md`);
        files.add(`${it.number}/activity.jsonl`);
      }
      for (const f of files) {
        if (!validNumber(Number(f.split('/')[0]))) continue;
        chk(path.join(p.items(pid), f), `${pid}/items/${f}`);
      }
    }
    for (const proj of state.projects) if (!onDisk.has(proj.id)) dirty.add(proj.id);
  } catch (e) {
    log('reconcile failed:', e.message);
  }
  for (const rel of dirty) handleExternal(rel);
}

const pending = new Map();
function onFsEvent(_type, filename) {
  if (!filename) return;
  const rel = String(filename);
  if (rel === '.git' || rel.startsWith('.git' + path.sep)) return;
  clearTimeout(pending.get(rel));
  pending.set(
    rel,
    setTimeout(() => {
      pending.delete(rel);
      handleExternal(rel);
    }, 150),
  );
}

watchDir(CONFIG_DIR, ''); // picks up hand edits to actors.json

/* ---------- helpers used by api.mjs ---------- */

export const now = () => new Date().toISOString();
export const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function findProject(s, projectId) {
  const proj = s.projects.find((x) => x.id === projectId);
  if (!proj) throw new HttpError(404, `No project "${projectId}"`);
  return proj;
}

export function findItem(proj, number) {
  const it = proj.items.find((x) => x.number === Number(number));
  if (!it) throw new HttpError(404, `No item #${number} in "${proj.id}"`);
  return it;
}

export function findActor(s, id) {
  return s.actors.find((a) => a.id === id);
}

export function pushActivity(item, actor, kind, text, meta) {
  item.activity.push({ id: uid('ev'), at: now(), actor, kind, text: text ?? '', ...(meta ? { meta } : {}) });
  item.updatedAt = now();
}

export function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'project'
  );
}
