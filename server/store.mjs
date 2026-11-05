// JSON-file store shared by the web UI (through the HTTP API) and agents (through MCP → HTTP).
// One file, written atomically; every mutation bumps `version` and is broadcast to listeners.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_FILE = process.env.KANBAN_DATA ?? path.join(root, 'data', 'board.json');

export { AGENT_STATES, PRIORITIES, SIZES, DEFAULT_STATUSES } from './model.mjs';

const listeners = new Set();
let state = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    const s = seed();
    write(s);
    return s;
  }
}

function write(s) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Pick up edits made by another process (e.g. a second server instance) before mutating.
function refresh() {
  try {
    const disk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if ((disk.version ?? 0) > (state.version ?? 0)) state = disk;
  } catch {}
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  refresh();
  return state;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Run `fn` against a draft of the state, persist, and broadcast `event`. */
export function mutate(fn, event) {
  refresh();
  const draft = structuredClone(state);
  const result = fn(draft);
  draft.version = (draft.version ?? 0) + 1;
  state = draft;
  write(state);
  for (const l of listeners) l({ ...event, version: state.version });
  return result;
}

export const now = () => new Date().toISOString();
export const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function findProject(s, projectId) {
  const p = s.projects.find((x) => x.id === projectId);
  if (!p) throw new HttpError(404, `No project "${projectId}"`);
  return p;
}

export function findItem(p, number) {
  const it = p.items.find((x) => x.number === Number(number));
  if (!it) throw new HttpError(404, `No item #${number} in "${p.id}"`);
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
