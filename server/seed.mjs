import { seedProjects } from './legacy-seed.mjs';
import { DEFAULT_STATUSES } from './model.mjs';

const STATUS_MAP = { todo: 'todo', progress: 'in_progress', done: 'done' };

export const DEFAULT_ACTORS = [
  { id: 'you', kind: 'human', name: 'You' },
  { id: 'claude', kind: 'agent', name: 'Claude', model: 'claude-opus-5-5' },
];

/** Convert a project in the old localStorage format into the current model. */
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

export function seed() {
  const statuses = DEFAULT_STATUSES;
  return {
    version: 1,
    actors: structuredClone(DEFAULT_ACTORS),
    projects: seedProjects.map((p) => fromLegacyProject(p, statuses)),
  };
}
