// File-per-item store shared by the web UI (through the HTTP API) and agents (through MCP → HTTP).
//
//   <dir>/actors.json
//   <dir>/<projectId>/project.json
//   <dir>/<projectId>/items/<n>.md              front matter (YAML) + markdown body
//   <dir>/<projectId>/items/<n>.activity.jsonl  append-only, one JSON object per line
//
// The whole board is indexed in memory. Mutations persist only what changed, the data dir is watched
// so hand edits / `git pull` are picked up, and gitsync.mjs auto-commits the dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { seed } from './seed.mjs';
import { DEFAULT_STATUSES, normRepos } from './model.mjs';
import * as gitsync from './gitsync.mjs';
import { appendLines } from './fsutil.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expand = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
export const DATA_DIR = path.resolve(expand(process.env.KANBAN_DATA_DIR || '~/Developer/kanban-data'));

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
const p = {
  actors: () => path.join(DATA_DIR, 'actors.json'),
  dir: (pid) => path.join(DATA_DIR, checkId(pid)),
  project: (pid) => path.join(DATA_DIR, checkId(pid), 'project.json'),
  items: (pid) => path.join(DATA_DIR, checkId(pid), 'items'),
  md: (pid, n) => path.join(DATA_DIR, checkId(pid), 'items', `${checkNum(n)}.md`),
  log: (pid, n) => path.join(DATA_DIR, checkId(pid), 'items', `${checkNum(n)}.activity.jsonl`),
};

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
  if (bad) setProblem(key, { kind: 'bad-activity', path: path.relative(DATA_DIR, file), message: `${path.relative(DATA_DIR, file)}: skipped ${bad} unparseable line(s)` });
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
    const m = /^(\d+)\.md$/.exec(f);
    if (!m) continue;
    const n = Number(m[1]);
    const key = `item:${pid}/${n}`;
    if (String(n) !== m[1] || !validNumber(n)) {
      setProblem(key, { kind: 'unreadable-item', project: pid, number: null, path: `${pid}/items/${f}`, message: `${pid}/items/${f}: not a canonical item filename; ignored` });
      continue;
    }
    try {
      const it = readItem(pid, n);
      if (it) proj.items.push(it);
      clearProblem(key);
    } catch (e) {
      setProblem(key, { kind: 'unreadable-item', project: pid, number: n, path: `${pid}/items/${f}`, message: `${pid}/items/${f}: ${e.message} (left untouched)` });
    }
  }
  proj.items.sort((a, b) => a.number - b.number);
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
  const projects = [];
  for (const d of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    if (!safeId(d.name)) {
      if (fs.existsSync(path.join(DATA_DIR, d.name, 'project.json'))) {
        setProblem(`project:${d.name}`, { kind: 'skipped-project', path: d.name, message: `${d.name}: folder name is not a valid project id; skipped` });
      }
      continue;
    }
    try {
      const proj = readProject(d.name);
      if (proj) projects.push(proj);
    } catch (e) {
      log(`skipping project ${d.name}: ${e.message}`);
    }
  }
  return { version: 1, actors, projects: sortProjects(projects) };
}

const projectMeta = ({ items, ...meta }) => meta;
const writeProjectMeta = (proj) => writeAtomic(p.project(proj.id), JSON.stringify(projectMeta(proj), null, 2) + '\n');
function writeItemFull(pid, it) {
  writeAtomic(p.md(pid, it.number), itemToMarkdown(it));
  writeAtomic(p.log(pid, it.number), jsonl(it.activity ?? []));
}

function writeEverything(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeAtomic(p.actors(), JSON.stringify(s.actors, null, 2) + '\n');
  for (const proj of s.projects) {
    if (!safeId(proj.id)) throw new Error(`unsafe project id "${proj.id}"`);
    writeProjectMeta(proj);
    for (const it of proj.items) writeItemFull(proj.id, it);
  }
}

/* ---------- one writer per data dir ---------- */

const LOCK = path.join(DATA_DIR, '.kanban.lock');
function acquireLock() {
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
      if (alive) throw new Error(`Data dir ${DATA_DIR} is already in use by process ${pid}. Stop it first (or set KANBAN_DATA_DIR).`);
      if (pid === process.pid) return;
      log(`taking over stale lock from process ${pid}`);
      fs.rmSync(LOCK, { force: true });
    }
  }
  throw new Error(`Could not lock ${DATA_DIR}`);
}

/* ---------- startup: load, migrate or seed ---------- */

function importSource() {
  const candidates = [process.env.KANBAN_IMPORT_JSON, path.join(root, 'data', 'board.json')].filter(Boolean).map((f) => path.resolve(expand(f)));
  return candidates.find((f) => fs.existsSync(f));
}

function loadOrInit() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  acquireLock();
  // Pull remote changes first so a fresh machine picks up the existing board.
  gitsync.init(DATA_DIR);
  const hasProjects = fs.readdirSync(DATA_DIR, { withFileTypes: true }).some((d) => d.isDirectory() && safeId(d.name) && fs.existsSync(p.project(d.name)));
  if (!hasProjects && !fs.existsSync(p.actors())) {
    const src = importSource();
    let s;
    if (src) {
      s = JSON.parse(fs.readFileSync(src, 'utf8'));
      // The old file kept projects in array order; keep that order via strictly increasing createdAt.
      let last = '';
      s.projects = (s.projects ?? []).map((proj) => {
        let at = proj.createdAt ?? new Date().toISOString();
        if (at <= last) at = new Date(Date.parse(last) + 1).toISOString();
        last = at;
        const out = normalizeProject({ ...proj, createdAt: at }, proj.id);
        out.items = (proj.items ?? []).map((it) => normalizeItem(it, it.number));
        return out;
      });
      s.actors = s.actors ?? [];
      log(`migrating ${src} -> ${DATA_DIR}`);
    } else {
      s = seed();
    }
    writeEverything(s);
    gitsync.changed(["initial board import"]);
  }
  return readAll();
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
        throw new HttpError(409, `${proj.id}/items/${it.number}.md already exists on disk; refusing to overwrite it`);
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
    fs.rmSync(p.dir(old.id), { recursive: true, force: true });
    for (const k of [...sigs.keys()]) if (k.startsWith(p.dir(old.id) + path.sep)) sigs.delete(k);
    note(`project ${old.id}`, 'project deleted');
  }
  for (const proj of next.projects) {
    const old = prevById.get(proj.id);
    if (!old) {
      writeProjectMeta(proj);
      for (const it of proj.items) writeItemFull(proj.id, it);
      note(`project ${proj.id}`, `project created (${proj.items.length} items)`);
      continue;
    }
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
  gitsync.changed(notes);
  emit(event);
  return result;
}

/** Next free item number: above everything in memory, quarantined, or merely present on disk. */
export function nextItemNumber(proj) {
  let max = Math.max(0, ...proj.items.map((i) => i.number));
  for (const pr of problems.values()) if (pr.project === proj.id && validNumber(pr.number)) max = Math.max(max, pr.number);
  try {
    for (const f of fs.readdirSync(p.items(proj.id))) {
      const m = /^(\d+)\./.exec(f);
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
  const m = second === 'items' && parts.length === 3 ? /^(\d+)\.(md|activity\.jsonl)$/.exec(third) : null;
  if (!m || String(Number(m[1])) !== m[1] || !validNumber(Number(m[1]))) return null;
  const n = Number(m[1]);
  const key = `item:${first}/${n}`;
  let fresh;
  try {
    fresh = readItem(first, n);
    clearProblem(key);
  } catch (e) {
    setProblem(key, { kind: 'unreadable-item', project: first, number: n, path: `${first}/items/${n}.md`, message: `${first}/items/${n}.md: ${e.message} (left untouched)` });
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
  gitsync.changed([note]);
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
    for (const d of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || !safeId(d.name)) continue;
      const pid = d.name;
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
        for (const f of fs.readdirSync(p.items(pid))) if (/^[1-9]\d*\.(md|activity\.jsonl)$/.test(f)) files.add(f);
      } catch {}
      for (const it of proj.items) {
        files.add(`${it.number}.md`);
        files.add(`${it.number}.activity.jsonl`);
      }
      for (const f of files) {
        if (!validNumber(Number(f.split('.')[0]))) continue;
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

try {
  const w = fs.watch(DATA_DIR, { recursive: true }, onFsEvent);
  w.on('error', (e) => log('watcher error:', e.message));
  w.unref?.();
} catch (e) {
  log('cannot watch data dir:', e.message);
}

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
