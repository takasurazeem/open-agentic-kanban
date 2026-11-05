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
import { DEFAULT_STATUSES } from './model.mjs';
import * as gitsync from './gitsync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expand = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
export const DATA_DIR = path.resolve(expand(process.env.KANBAN_DATA_DIR || '~/Developer/kanban-data'));

export { AGENT_STATES, PRIORITIES, SIZES, DEFAULT_STATUSES } from './model.mjs';

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
  return normalizeItem({ ...front, number: front.number ?? number, body }, number, fallbackTime);
}

const stable = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );

/* ---------- disk helpers ---------- */

const ownWrites = new Set(); // paths we touched very recently (informational; reloads are content-compared)
const safeId = (id) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(id));
const p = {
  actors: () => path.join(DATA_DIR, 'actors.json'),
  dir: (pid) => path.join(DATA_DIR, pid),
  project: (pid) => path.join(DATA_DIR, pid, 'project.json'),
  items: (pid) => path.join(DATA_DIR, pid, 'items'),
  md: (pid, n) => path.join(DATA_DIR, pid, 'items', `${n}.md`),
  log: (pid, n) => path.join(DATA_DIR, pid, 'items', `${n}.activity.jsonl`),
};

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  ownWrites.add(file);
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
  const text = readText(file);
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      log('skipping bad activity line in', file);
    }
  }
  return out;
}

function readItem(pid, n) {
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
    try {
      const it = readItem(pid, Number(m[1]));
      if (it) proj.items.push(it);
    } catch (e) {
      log(`skipping ${pid}/items/${f}: ${e.message}`);
    }
  }
  proj.items.sort((a, b) => a.number - b.number);
  return proj;
}

const sortProjects = (arr) => arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

function readAll() {
  let actors = [];
  try {
    actors = JSON.parse(readText(p.actors()) ?? '[]');
  } catch (e) {
    log('bad actors.json:', e.message);
  }
  const projects = [];
  for (const d of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
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

/* ---------- startup: load, migrate or seed ---------- */

function importSource() {
  const candidates = [process.env.KANBAN_IMPORT_JSON, path.join(root, 'data', 'board.json')].filter(Boolean).map((f) => path.resolve(expand(f)));
  return candidates.find((f) => fs.existsSync(f));
}

function loadOrInit() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Pull remote changes first so a fresh machine picks up the existing board.
  gitsync.init(DATA_DIR);
  const hasProjects = fs.readdirSync(DATA_DIR, { withFileTypes: true }).some((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(p.project(d.name)));
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

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function emit(event) {
  for (const l of listeners) l({ ...event, version: state.version });
}

/** Persist only the differences between `prev` and `next`; returns human-readable change notes. */
function persist(prev, next) {
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
    note(`project ${old.id}`, 'project deleted');
  }
  for (const proj of next.projects) {
    if (!safeId(proj.id)) throw new HttpError(400, `Invalid project id "${proj.id}"`);
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
      const mdChanged = md !== itemToMarkdown(o);
      if (mdChanged) {
        writeAtomic(p.md(proj.id, it.number), md);
        if (it.status !== o.status) note(key, `status → ${it.status}`);
        if (it.agent.state !== o.agent.state) note(key, `${it.agent.by ?? 'agent'} → ${it.agent.state}`);
        if (!notes.has(key) || it.title !== o.title || it.body !== o.body) note(key, 'edited');
      }
      const a = it.activity, b = o.activity;
      const appendOnly = a.length >= b.length && b.every((e, i) => e === a[i] || stable(e) === stable(a[i]));
      if (appendOnly) {
        if (a.length > b.length) {
          fs.mkdirSync(p.items(proj.id), { recursive: true });
          fs.appendFileSync(p.log(proj.id, it.number), jsonl(a.slice(b.length)));
          ownWrites.add(p.log(proj.id, it.number));
          if (a.slice(b.length).some((e) => e.kind === 'comment')) note(key, 'commented');
          else if (!notes.has(key)) note(key, 'activity');
        }
      } else {
        writeAtomic(p.log(proj.id, it.number), jsonl(a));
      }
    }
    for (const o of old.items) {
      if (seen.has(o.number)) continue;
      fs.rmSync(p.md(proj.id, o.number), { force: true });
      fs.rmSync(p.log(proj.id, o.number), { force: true });
      note(`${proj.id}#${o.number}`, 'deleted');
    }
  }
  return [...notes].map(([k, v]) => `${k.replace(/^project /, '')}: ${[...new Set(v)].join(', ')}`);
}

/** Run `fn` against a draft of the state, persist what changed, and broadcast `event`. */
export function mutate(fn, event) {
  const draft = structuredClone(state);
  const result = fn(draft);
  draft.version = (state.version ?? 0) + 1;
  const prev = state;
  const notes = persist(prev, draft); // throws before swapping state if a write fails
  state = draft;
  gitsync.changed(notes);
  emit(event);
  return result;
}

/* ---------- watching the data dir (hand edits, git pull) ---------- */

function applyExternal(rel) {
  const parts = rel.split(path.sep);
  if (parts[0].startsWith('.') && parts[0] !== '.') return null;
  if (parts.some((x) => x.startsWith('.') || x.includes('.tmp-'))) return null;
  const [first, second, third] = parts;
  if (parts.length === 1 && first === 'actors.json') {
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
  if (!m) return null;
  const n = Number(m[1]);
  let fresh;
  try {
    fresh = readItem(first, n);
  } catch (e) {
    log(`bad ${first}/items/${third}:`, e.message);
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
