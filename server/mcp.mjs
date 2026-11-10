#!/usr/bin/env node
// MCP server (stdio) that lets an agent work the board. It talks to the running app over HTTP,
// so every change an agent makes appears live in the UI.
//   KANBAN_URL   where the app runs (default http://localhost:5173)
//   KANBAN_AGENT the actor id this agent acts as (default "claude")
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AGENT_STATES, PRIORITIES, SIZES, repoMatches } from './model.mjs';

// Settings come from --url= / --agent= arguments or KANBAN_URL / KANBAN_AGENT (arguments win), so
// harnesses that only allow plain args (or treat env values as secrets) can configure it too.
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const BASE = (arg('url') ?? process.env.KANBAN_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const AGENT = arg('agent') ?? process.env.KANBAN_AGENT ?? 'claude';

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`The board is not reachable at ${BASE}. Start it with "npm run dev" in the project folder.`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const ok = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.message }] });
const tool = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

/** Full item, with activity trimmed to the most recent entries to keep context small. */
function brief(it, activityLimit = 15) {
  const { activity, ...rest } = it;
  return { ...rest, activity: activity.slice(-activityLimit), olderActivity: Math.max(0, activity.length - activityLimit) };
}

const ref = {
  project: z.string().describe('Project id, e.g. "kanban" (see list_projects)'),
  number: z.number().int().describe('Item number within the project, e.g. 3 for #3'),
};

const server = new McpServer({ name: 'open-agentic-kanban', version: '0.2.0' });

server.registerTool(
  'list_projects',
  { description: 'List projects with their statuses and item counts per status.', inputSchema: {} },
  tool(() => api('GET', '/projects')),
);

server.registerTool(
  'find_project',
  {
    description:
      'Find the board project for a code repo. Pass the repo\'s absolute folder path (best: it matches boards that live in the repo\'s ' +
      '.kanban/ folder), its git remote URL, its "owner/name", or its folder name. Returns the matching projects, or none: then ask the ' +
      'user whether to create one with create_project (pass the repo path so the cards are stored in the repo).',
    inputSchema: { repo: z.string().describe('absolute folder path, git remote URL, owner/name, or folder name') },
  },
  tool(async ({ repo }) => {
    const all = await api('GET', '/projects');
    const inside = (dir, root) => dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);
    const hits = all.filter((p) => (p.repoPath && repo.startsWith('/') && inside(repo, p.repoPath)) || repoMatches(p.repos, repo));
    return hits.length ? hits : `No project is linked to "${repo}".`;
  }),
);

server.registerTool(
  'create_project',
  {
    description:
      'Create a board project. Pass `path` (absolute folder of a git repo) to keep its cards in that repo\'s .kanban/ folder: ' +
      'an existing board there is used, otherwise one is created. Without `path` the project lives in the central data folder. ' +
      'Optionally link code repos so agents in those repos find it with find_project.',
    inputSchema: {
      name: z.string().optional().describe('required without `path`; defaults to the repo folder name'),
      path: z.string().optional().describe('absolute path of a git repo to host the board'),
      description: z.string().optional(),
      repos: z.array(z.string()).optional().describe('git remote URLs, owner/name, or folder names'),
    },
  },
  tool(async (body) => {
    const p = await api('POST', '/projects', body);
    const where = p.repoPath ? ` in ${p.repoPath}/.kanban${p.created === false ? ' (existing board, ' + p.itemCount + ' items)' : ''}` : '';
    return `${p.created === false ? 'Attached' : 'Created'} project "${p.id}"${where}${p.repos?.length ? `, linked to ${p.repos.join(', ')}` : ''}.`;
  }),
);

server.registerTool(
  'link_repo',
  {
    description: 'Link (or unlink) a code repo to an existing project, so find_project matches it.',
    inputSchema: {
      project: z.string(),
      repo: z.string().describe('git remote URL, owner/name, or folder name'),
      unlink: z.boolean().optional(),
    },
  },
  tool(async ({ project, repo, unlink }) => {
    const all = await api('GET', '/projects');
    const p = all.find((x) => x.id === project);
    if (!p) throw new Error(`No project "${project}"`);
    const cur = p.repos ?? [];
    const next = unlink ? cur.filter((r) => !repoMatches([r], repo)) : [...cur, repo];
    const res = await api('PATCH', `/projects/${encodeURIComponent(project)}`, { repos: next });
    return `${project} repos: ${(res.repos ?? []).join(', ') || 'none'}`;
  }),
);

server.registerTool(
  'list_items',
  {
    description: 'List items in a project (no body or activity). Filter by status id, assignee id, agent state, label, or text.',
    inputSchema: {
      project: ref.project,
      status: z.string().optional(),
      assignee: z.string().optional().describe(`Actor id; use "${AGENT}" for your own items`),
      agent_state: z.enum(AGENT_STATES).optional(),
      label: z.string().optional(),
      q: z.string().optional().describe('Text to search in title and body'),
    },
  },
  tool(({ project, ...q }) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null)).toString();
    return api('GET', `/projects/${encodeURIComponent(project)}/items${qs ? `?${qs}` : ''}`);
  }),
);

server.registerTool(
  'get_item',
  { description: 'Read one item: its markdown body, fields, agent state and recent activity (comments, status changes, logs).', inputSchema: ref },
  tool(async ({ project, number }) => brief(await api('GET', `/projects/${encodeURIComponent(project)}/items/${number}`))),
);

server.registerTool(
  'next_item',
  {
    description:
      'Find the next item queued for you: queued items assigned to you (or to no agent), most urgent first. ' +
      'Returns null when nothing is queued. Call claim_item before starting work on it.',
    inputSchema: {
      project: z.string().optional().describe('Limit to one project'),
      include_todo: z.boolean().optional().describe('Also consider unassigned items in the first status (Todo) when nothing is queued'),
    },
  },
  tool(async ({ project, include_todo }) => {
    const qs = new URLSearchParams({ agent: AGENT, ...(project ? { project } : {}), ...(include_todo ? { include_todo: '1' } : {}) });
    const it = await api('GET', `/next?${qs}`);
    return it ? brief(it) : 'Nothing is queued for you.';
  }),
);

server.registerTool(
  'claim_item',
  {
    description:
      'Start working on an item: assigns you, sets agent state to "running" and moves it from Todo to In progress. ' +
      'Fails if another agent is already running it.',
    inputSchema: {
      ...ref,
      note: z.string().optional().describe('What you are about to do (shown in the timeline)'),
      sessionUrl: z.string().optional().describe('Link to your session, if you have one'),
      branch: z.string().optional(),
      model: z.string().optional(),
    },
  },
  tool(async ({ project, number, ...rest }) =>
    brief(await api('POST', `/projects/${encodeURIComponent(project)}/items/${number}/claim`, { agent: AGENT, ...rest }), 5),
  ),
);

server.registerTool(
  'report_progress',
  {
    description:
      'Post a progress update and optionally change your agent state or attach links. ' +
      'States: running (working), blocked (need a human — say why in note), needs_review (finished; moves the item to In review), ' +
      'done, idle (stopping without finishing). Use this often so the human can follow along.',
    inputSchema: {
      ...ref,
      note: z.string().optional().describe('Markdown update for the timeline'),
      state: z.enum(AGENT_STATES).optional(),
      branch: z.string().optional(),
      prUrl: z.string().optional(),
      sessionUrl: z.string().optional(),
    },
  },
  tool(async ({ project, number, ...rest }) =>
    brief(await api('PATCH', `/projects/${encodeURIComponent(project)}/items/${number}/agent`, { actor: AGENT, ...rest }), 5),
  ),
);

server.registerTool(
  'comment',
  { description: 'Add a markdown comment to an item, e.g. to answer a question from the human.', inputSchema: { ...ref, text: z.string() } },
  tool(async ({ project, number, text }) => {
    await api('POST', `/projects/${encodeURIComponent(project)}/items/${number}/comments`, { actor: AGENT, text });
    return 'Comment added.';
  }),
);

server.registerTool(
  'update_item',
  {
    description: 'Edit an item: title, markdown body, status id, priority, size, labels, assignees (actor ids).',
    inputSchema: {
      ...ref,
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.string().optional(),
      priority: z.enum(PRIORITIES).nullable().optional(),
      size: z.enum(SIZES).nullable().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
    },
  },
  tool(async ({ project, number, ...patch }) =>
    brief(await api('PATCH', `/projects/${encodeURIComponent(project)}/items/${number}`, { actor: AGENT, ...patch }), 5),
  ),
);

server.registerTool(
  'create_item',
  {
    description: 'Create an item, e.g. to split work or record a follow-up you found. Assign it to an agent to queue it.',
    inputSchema: {
      project: ref.project,
      title: z.string(),
      body: z.string().optional(),
      status: z.string().optional(),
      priority: z.enum(PRIORITIES).optional(),
      size: z.enum(SIZES).optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
    },
  },
  tool(async ({ project, ...body }) => {
    const it = await api('POST', `/projects/${encodeURIComponent(project)}/items`, { actor: AGENT, ...body });
    return `Created ${project}#${it.number}: ${it.title}`;
  }),
);

await server.connect(new StdioServerTransport());
