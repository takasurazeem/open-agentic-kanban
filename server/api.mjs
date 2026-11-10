// HTTP API used by both the web UI and the MCP server. Mounted as Vite middleware in dev
// (one port for everything) and by server/index.mjs in production.
import fs from 'node:fs';
import path from 'node:path';
import {
  getState, mutate, subscribe, HttpError, now, slugify,
  findProject, findItem, findActor, pushActivity, nextItemNumber, getProblems,
  saveAttachment, deleteAttachment, attachmentFile, MAX_ATTACHMENT_BYTES, attachRepo,
} from './store.mjs';
import * as gitsync from './gitsync.mjs';
import { AGENT_STATES, PRIORITIES, SIZES, DEFAULT_STATUSES, STATUS_COLORS, normRepos } from './model.mjs';

const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Low: 3 };

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** A file to stream back instead of a JSON body. */
class FileResponse {
  constructor({ file, name, size }) {
    Object.assign(this, { file, name, size });
  }
}

// Types that are safe to show in the browser. Everything else is sent as a download.
const INLINE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

function sendFile(req, res, f) {
  const inline = INLINE_TYPES[path.extname(f.name).toLowerCase()];
  const encoded = encodeURIComponent(f.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  // Single byte ranges, so video/audio can seek and text previews can stay small.
  let start = 0, end = f.size - 1;
  const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  res.statusCode = 200;
  if (rm && (rm[1] || rm[2])) {
    start = rm[1] ? Number(rm[1]) : Math.max(0, f.size - Number(rm[2]));
    end = rm[1] && rm[2] ? Math.min(Number(rm[2]), f.size - 1) : f.size - 1;
    if (start > end || start >= f.size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${f.size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${f.size}`);
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', inline ?? 'application/octet-stream');
  res.setHeader('Content-Length', end - start + 1);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`);
  // Uploaded files are untrusted: never let the browser guess a type or run scripts from them.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Chrome's PDF viewer does not work inside a CSP sandbox; PDFs are not scripted HTML, so skip it for them.
  if (inline !== 'application/pdf') {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'");
  }
  res.setHeader('Cache-Control', 'private, no-cache');
  const stream = fs.createReadStream(f.file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function readBody(req, maxBytes = Infinity) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new HttpError(413, `Request body is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

function actorOr(s, id, fallback = 'you') {
  const a = id ?? fallback;
  if (!findActor(s, a)) throw new HttpError(400, `Unknown actor "${a}". Known: ${s.actors.map((x) => x.id).join(', ')}`);
  return a;
}

function oneOf(value, allowed, field) {
  if (value == null) return value;
  if (!allowed.includes(value)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function nextRank(p, status) {
  const ranks = p.items.filter((i) => i.status === status).map((i) => i.rank ?? 0);
  return (ranks.length ? Math.max(...ranks) : 0) + 1;
}

/** Item summary for list endpoints: drops the body and activity to keep agent context small. */
function summary(p, it) {
  const { body, activity, attachments, ...rest } = it;
  return {
    project: p.id, ...rest,
    comments: activity.filter((a) => a.kind === 'comment').length,
    attachmentCount: (attachments ?? []).length,
  };
}

function applyItemPatch(s, p, it, patch, actor) {
  const changed = [];
  if (patch.title != null && patch.title.trim() && patch.title !== it.title) {
    pushActivity(it, actor, 'renamed', '', { from: it.title, to: patch.title.trim() });
    it.title = patch.title.trim();
  }
  if (patch.body != null && patch.body !== it.body) {
    it.body = patch.body;
    changed.push('description');
  }
  if (patch.status != null && patch.status !== it.status) {
    if (!p.statuses.some((x) => x.id === patch.status)) {
      throw new HttpError(400, `status must be one of: ${p.statuses.map((x) => x.id).join(', ')}`);
    }
    pushActivity(it, actor, 'status', '', { from: it.status, to: patch.status });
    it.status = patch.status;
    if (patch.rank == null) it.rank = nextRank(p, patch.status);
  }
  if (patch.rank != null) it.rank = Number(patch.rank);
  if (patch.priority !== undefined && patch.priority !== it.priority) {
    it.priority = oneOf(patch.priority, PRIORITIES, 'priority');
    changed.push('priority');
  }
  if (patch.size !== undefined && patch.size !== it.size) {
    it.size = oneOf(patch.size, SIZES, 'size');
    changed.push('size');
  }
  if (patch.labels != null) {
    const labels = [...new Set(patch.labels.map((l) => String(l).trim()).filter(Boolean))];
    if (labels.join() !== it.labels.join()) {
      it.labels = labels;
      changed.push('labels');
    }
  }
  if (patch.assignees != null) {
    for (const a of patch.assignees) actorOr(s, a);
    const added = patch.assignees.filter((a) => !it.assignees.includes(a));
    const removed = it.assignees.filter((a) => !patch.assignees.includes(a));
    if (added.length || removed.length) {
      it.assignees = [...patch.assignees];
      pushActivity(it, actor, 'assigned', '', { added, removed });
      // Assigning an agent to an idle item queues it for that agent.
      const agentAdded = added.some((a) => findActor(s, a)?.kind === 'agent');
      if (agentAdded && ['idle', 'done'].includes(it.agent.state)) {
        setAgent(it, actor, { state: 'queued' });
      }
      if (!it.assignees.some((a) => findActor(s, a)?.kind === 'agent') && it.agent.state === 'queued') {
        setAgent(it, actor, { state: 'idle' });
      }
    }
  }
  if (changed.length) pushActivity(it, actor, 'edited', '', { fields: changed });
  it.updatedAt = now();
}

function setAgent(it, actor, { state, note, model, branch, prUrl, sessionUrl }, p) {
  const prev = it.agent.state;
  if (state != null) oneOf(state, AGENT_STATES, 'state');
  const links = {};
  for (const [k, v] of Object.entries({ branch, prUrl, sessionUrl, model })) {
    if (v !== undefined && v !== it.agent[k]) links[k] = v;
  }
  it.agent = { ...it.agent, ...links, ...(state ? { state } : {}), updatedAt: now() };
  if (state && state !== prev) {
    pushActivity(it, actor, 'agent', note ?? '', { from: prev, to: state });
    if (state === 'running') it.agent.by = actor;
  } else if (note) {
    pushActivity(it, actor, 'log', note);
  }
  const linkKeys = Object.keys(links).filter((k) => k !== 'model' && links[k]);
  if (linkKeys.length) pushActivity(it, actor, 'link', '', Object.fromEntries(linkKeys.map((k) => [k, links[k]])));

  // Keep the board's Status in step with what the agent is doing.
  if (p && state && state !== prev) {
    const has = (id) => p.statuses.some((x) => x.id === id);
    const move = (to) => {
      if (it.status !== to && has(to)) {
        pushActivity(it, actor, 'status', '', { from: it.status, to });
        it.status = to;
        it.rank = nextRank(p, to);
      }
    };
    if (state === 'running' && (it.status === 'todo' || it.status === 'backlog')) move('in_progress');
    if (state === 'needs_review') move('in_review');
  }
}

function itemMatches(it, q) {
  if (q.status && it.status !== q.status) return false;
  if (q.assignee && !it.assignees.includes(q.assignee)) return false;
  if (q.agent_state && it.agent.state !== q.agent_state) return false;
  if (q.label && !it.labels.includes(q.label)) return false;
  if (q.q) {
    const t = q.q.toLowerCase();
    if (!`${it.title}\n${it.body}`.toLowerCase().includes(t)) return false;
  }
  return true;
}

const routes = [];
const route = (method, pattern, fn, opts = {}) => {
  const keys = [];
  const re = new RegExp(
    `^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`,
  );
  routes.push({ method, re, keys, fn, maxBody: opts.maxBody });
};

route('GET', '/api/state', () => getState());

route('GET', '/api/sync', () => ({ ...gitsync.status(), problems: getProblems() }));

route('POST', '/api/actors', ({ body }) =>
  mutate((s) => {
    const id = slugify(body.id ?? body.name ?? '');
    if (!body.name) throw new HttpError(400, 'name is required');
    if (findActor(s, id)) throw new HttpError(409, `Actor "${id}" exists`);
    const a = { id, name: body.name, kind: body.kind === 'human' ? 'human' : 'agent', ...(body.model ? { model: body.model } : {}) };
    s.actors.push(a);
    return a;
  }, { type: 'actors' }),
);

route('GET', '/api/projects', () =>
  getState().projects.map(({ items, ...p }) => ({
    ...p,
    counts: Object.fromEntries(p.statuses.map((st) => [st.id, items.filter((i) => i.status === st.id).length])),
    agentsActive: items.filter((i) => i.agent.state === 'running').length,
  })),
);

/**
 * Create a project by pointing at a code repo: the board in <repo>/.kanban/ is used if it exists,
 * otherwise one is created there.
 */
route('POST', '/api/projects', ({ body }) => {
  if (!body.path) throw new HttpError(400, 'path (a git repo) is required: boards live in <repo>/.kanban/');
  const { project, created } = attachRepo(body.path, { name: body.name });
  const { items, ...meta } = project;
  return { ...meta, created, itemCount: items.length };
});

route('PATCH', '/api/projects/:pid', ({ params, body }) =>
  mutate((s) => {
    const p = findProject(s, params.pid);
    if (body.name?.trim()) p.name = body.name.trim();
    if (body.description != null) p.description = body.description;
    if (body.visibility) p.visibility = body.visibility === 'public' ? 'public' : 'private';
    if (Array.isArray(body.repos)) p.repos = normRepos(body.repos);
    if (Array.isArray(body.statuses)) {
      if (!body.statuses.length) throw new HttpError(400, 'A project needs at least one status');
      const ids = new Set();
      p.statuses = body.statuses.map((st) => {
        const id = st.id || slugify(st.name).replace(/-/g, '_');
        if (ids.has(id)) throw new HttpError(400, `Duplicate status "${id}"`);
        ids.add(id);
        return { id, name: st.name, color: STATUS_COLORS.includes(st.color) ? st.color : 'gray', description: st.description ?? '' };
      });
      for (const it of p.items) if (!ids.has(it.status)) it.status = p.statuses[0].id;
    }
    return p;
  }, { type: 'project', project: params.pid }),
);

route('DELETE', '/api/projects/:pid', ({ params }) =>
  mutate((s) => {
    findProject(s, params.pid);
    s.projects = s.projects.filter((p) => p.id !== params.pid);
    return { ok: true };
  }, { type: 'project', project: params.pid }),
);

route('GET', '/api/projects/:pid/items', ({ params, query }) => {
  const p = findProject(getState(), params.pid);
  return p.items.filter((it) => itemMatches(it, query)).map((it) => summary(p, it));
});

route('POST', '/api/projects/:pid/items', ({ params, body }) =>
  mutate((s) => {
    const p = findProject(s, params.pid);
    const actor = actorOr(s, body.actor);
    if (!body.title?.trim()) throw new HttpError(400, 'title is required');
    const status = body.status ?? p.statuses[0].id;
    const it = {
      number: nextItemNumber(p),
      title: body.title.trim(), body: body.body ?? '', status, rank: nextRank(p, status),
      priority: oneOf(body.priority ?? null, [...PRIORITIES, null], 'priority'),
      size: oneOf(body.size ?? null, [...SIZES, null], 'size'),
      labels: [...new Set((body.labels ?? []).map(String))], assignees: [], agent: { state: 'idle' },
      activity: [], attachments: [], createdAt: now(), updatedAt: now(),
    };
    pushActivity(it, actor, 'created');
    p.items.push(it);
    if (body.assignees?.length) applyItemPatch(s, p, it, { assignees: body.assignees }, actor);
    return it;
  }, { type: 'item', project: params.pid }),
);

route('GET', '/api/projects/:pid/items/:n', ({ params }) => {
  const p = findProject(getState(), params.pid);
  return { project: p.id, ...findItem(p, params.n) };
});

route('PATCH', '/api/projects/:pid/items/:n', ({ params, body }) =>
  mutate((s) => {
    const p = findProject(s, params.pid);
    const it = findItem(p, params.n);
    applyItemPatch(s, p, it, body, actorOr(s, body.actor));
    return it;
  }, { type: 'item', project: params.pid, number: Number(params.n) }),
);

route('DELETE', '/api/projects/:pid/items/:n', ({ params }) =>
  mutate((s) => {
    const p = findProject(s, params.pid);
    findItem(p, params.n);
    p.items = p.items.filter((i) => i.number !== Number(params.n));
    return { ok: true };
  }, { type: 'item', project: params.pid, number: Number(params.n) }),
);

route('POST', '/api/projects/:pid/items/:n/comments', ({ params, body }) =>
  mutate((s) => {
    const it = findItem(findProject(s, params.pid), params.n);
    if (!body.text?.trim()) throw new HttpError(400, 'text is required');
    pushActivity(it, actorOr(s, body.actor), 'comment', body.text.trim());
    return it;
  }, { type: 'item', project: params.pid, number: Number(params.n) }),
);

/**
 * Attachments live in <project>/items/<n>/attachments/. Upload as JSON so the API keeps its
 * "JSON only" rule: { name, content: <base64>, actor? }. Files are downloaded with
 * GET .../attachments/<name>.
 */
route(
  'POST', '/api/projects/:pid/items/:n/attachments',
  ({ params, body }) =>
    mutate((s) => {
      const p = findProject(s, params.pid);
      const it = findItem(p, params.n);
      const actor = actorOr(s, body.actor);
      if (typeof body.content !== 'string' || !body.content) throw new HttpError(400, 'content (base64) is required');
      const buf = Buffer.from(body.content.replace(/^data:[^,]*;base64,/, ''), 'base64');
      const meta = saveAttachment(p.id, it, body.name, buf);
      pushActivity(it, actor, 'attachment', meta.name, { action: 'added', name: meta.name, size: meta.size });
      return meta;
    }, { type: 'item', project: params.pid, number: Number(params.n) }),
  { maxBody: Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 64 * 1024 },
);

route('GET', '/api/projects/:pid/items/:n/attachments/:name', ({ params }) => {
  const p = findProject(getState(), params.pid);
  const it = findItem(p, params.n);
  return new FileResponse(attachmentFile(p.id, it.number, params.name));
});

route('DELETE', '/api/projects/:pid/items/:n/attachments/:name', ({ params, query }) =>
  mutate((s) => {
    const p = findProject(s, params.pid);
    const it = findItem(p, params.n);
    const actor = actorOr(s, query.actor);
    deleteAttachment(p.id, it, params.name);
    pushActivity(it, actor, 'attachment', params.name, { action: 'removed', name: params.name });
    return { ok: true };
  }, { type: 'item', project: params.pid, number: Number(params.n) }),
);

route('PATCH', '/api/projects/:pid/items/:n/agent', ({ params, body }) =>
  mutate((s) => {
    const p = findProject(s, params.pid);
    const it = findItem(p, params.n);
    setAgent(it, actorOr(s, body.actor), body, p);
    return it;
  }, { type: 'item', project: params.pid, number: Number(params.n) }),
);

route('POST', '/api/projects/:pid/items/:n/claim', ({ params, body }) =>
  mutate((s) => {
    const p = findProject(s, params.pid);
    const it = findItem(p, params.n);
    const agent = actorOr(s, body.agent ?? body.actor, 'claude');
    if (it.agent.state === 'running' && it.agent.by && it.agent.by !== agent) {
      throw new HttpError(409, `#${it.number} is already being worked on by ${it.agent.by}`);
    }
    if (!it.assignees.includes(agent)) {
      it.assignees.push(agent);
      pushActivity(it, agent, 'assigned', '', { added: [agent], removed: [] });
    }
    setAgent(it, agent, { state: 'running', note: body.note, model: body.model, sessionUrl: body.sessionUrl, branch: body.branch }, p);
    return it;
  }, { type: 'item', project: params.pid, number: Number(params.n) }),
);

/**
 * The next item an agent should pick up: queued items assigned to it (or unassigned and queued),
 * most urgent first, then oldest. Pass include_todo=1 to fall back to unassigned Todo items.
 */
route('GET', '/api/next', ({ query }) => {
  const s = getState();
  const agent = query.agent ?? 'claude';
  // include_todo falls back to the Todo column (not Backlog, which holds work that isn't planned yet).
  const todoId = (p) => (p.statuses.some((x) => x.id === 'todo') ? 'todo' : p.statuses[0].id);
  const projects = query.project ? [findProject(s, query.project)] : s.projects;
  const candidates = [];
  for (const p of projects) {
    for (const it of p.items) {
      const mine = it.assignees.includes(agent);
      const free = !it.assignees.some((a) => findActor(s, a)?.kind === 'agent');
      if (it.agent.state === 'queued' && (mine || free)) candidates.push({ p, it, tier: 0 });
      else if (query.include_todo && it.status === todoId(p) && it.agent.state === 'idle' && free) {
        candidates.push({ p, it, tier: 1 });
      }
    }
  }
  candidates.sort(
    (a, b) =>
      a.tier - b.tier ||
      (PRIORITY_RANK[a.it.priority] ?? 4) - (PRIORITY_RANK[b.it.priority] ?? 4) ||
      a.it.createdAt.localeCompare(b.it.createdAt),
  );
  const top = candidates[0];
  return top ? { project: top.p.id, ...top.it } : null;
});

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'hello', version: getState().version })}\n\n`);
  const off = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    off();
    clearInterval(ping);
  });
}

/** Connect-style middleware: handles /api/*, passes everything else to `next`. */
export async function apiMiddleware(req, res, next) {
  const url = new URL(req.url, 'http://local');
  if (!url.pathname.startsWith('/api/')) return next?.();
  if (url.pathname === '/api/events') return sse(req, res);
  try {
    // Only JSON requests may change anything. Browsers can't send application/json cross-site without a
    // CORS preflight (which we never grant), so other web pages can't drive this API.
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, { error: 'Content-Type must be application/json' });
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req, r.maxBody) : {};
      const result = await r.fn({ params, body, query: Object.fromEntries(url.searchParams) });
      if (result instanceof FileResponse) return sendFile(req, res, result);
      return send(res, 200, result);
    }
    send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
  } catch (e) {
    send(res, e.status ?? 500, { error: e.message });
  }
}

