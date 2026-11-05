import { DEFAULT_STATUSES } from './model.mjs';

const STATUS_MAP = { todo: 'todo', progress: 'in_progress', done: 'done' };

export const DEFAULT_ACTORS = [
  { id: 'you', kind: 'human', name: 'You' },
  { id: 'claude', kind: 'agent', name: 'Claude', model: 'claude-opus-5-5' },
];

/** Convert a project in the old localStorage format (POST /api/import) into the current model. */
export function fromLegacyProject(p, statuses) {
  const created = new Date().toISOString();
  return {
    id: p.id,
    name: p.name,
    description: '',
    visibility: p.visibility === 'Public' ? 'public' : 'private',
    statuses: structuredClone(statuses),
    createdAt: created,
    items: p.cards.map((c, i) => ({
      number: c.number,
      title: c.title,
      body: c.body ?? '',
      status: STATUS_MAP[c.columnId] ?? 'todo',
      rank: i + 1,
      priority: c.priority ?? null,
      size: null,
      labels: (c.labels ?? []).filter((l) => l !== 'done'),
      assignees: [],
      agent: { state: 'idle' },
      activity: [{ id: `ev_seed_${p.id}_${c.number}`, at: created, actor: 'you', kind: 'created', text: '' }],
      createdAt: created,
      updatedAt: created,
    })),
  };
}

const demoItems = [
  {
    title: 'Welcome to your board',
    status: 'todo',
    labels: ['docs'],
    priority: 'Medium',
    body: `Items are **markdown**. You can use lists, \`inline code\` and tables:

| Status | Meaning |
| --- | --- |
| Todo | not started |
| In progress | someone is on it |
| In review | waiting for a human |

- [ ] Drag this card to another column
- [ ] Open the **Table** view
- [ ] Try the filter \`assignee:claude\``,
  },
  {
    title: 'Sketch the handoff flow',
    status: 'in_progress',
    labels: ['design'],
    priority: 'High',
    size: 'S',
    body: `Mermaid diagrams render inline:

\`\`\`mermaid
flowchart LR
  A[Assign an agent] --> Q[Queued]
  Q --> R[Running]
  R --> V[Needs review]
  V --> D[Done]
\`\`\``,
  },
  {
    title: 'Add a code sample to the docs',
    status: 'todo',
    labels: ['docs'],
    priority: 'Low',
    body: 'Fenced code is highlighted:\n\n```js\nconst board = await fetch("/api/state").then((r) => r.json());\nconsole.log(board.projects.length);\n```',
  },
  {
    title: 'Try the agent workflow',
    status: 'todo',
    labels: ['enhancement'],
    priority: 'High',
    size: 'M',
    assignees: ['claude'],
    agent: { state: 'queued' },
    body: 'Assigned to `claude` and **queued**. With the MCP server connected, ask Claude to run `next_item` and `claim_item` to pick this up.',
  },
  {
    title: 'Ship the first release',
    status: 'done',
    labels: ['release'],
    priority: null,
    body: 'Finished items land in **Done** once a human approves them.',
  },
];

export function seed() {
  const t = new Date().toISOString();
  const rank = {};
  return {
    version: 1,
    actors: structuredClone(DEFAULT_ACTORS),
    projects: [
      {
        id: 'demo',
        name: 'Demo project',
        description: 'A small example board. Delete it whenever you like.',
        visibility: 'private',
        statuses: structuredClone(DEFAULT_STATUSES),
        createdAt: t,
        items: demoItems.map((d, i) => {
          rank[d.status] = (rank[d.status] ?? 0) + 1;
          return {
            number: i + 1,
            title: d.title,
            body: d.body,
            status: d.status,
            rank: rank[d.status],
            priority: d.priority ?? null,
            size: d.size ?? null,
            labels: d.labels ?? [],
            assignees: d.assignees ?? [],
            agent: d.agent ?? { state: d.status === 'done' ? 'done' : 'idle' },
            activity: [{ id: `ev_seed_demo_${i + 1}`, at: t, actor: 'you', kind: 'created', text: '' }],
            createdAt: t,
            updatedAt: t,
          };
        }),
      },
    ],
  };
}
