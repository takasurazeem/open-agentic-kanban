import type { Actor, Item, Project } from './types';

/**
 * GitHub-style filter syntax:
 *   status:todo  assignee:claude  assignee:@agents  label:bug  priority:high  size:m
 *   agent:running  agent:blocked  is:needs-you  -label:bug  plus free text.
 * Values with spaces can be quoted: status:"in progress".
 */
interface Term {
  key: string | null;
  value: string;
  negate: boolean;
}

function tokenize(q: string): Term[] {
  const terms: Term[] = [];
  const re = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const value = (m[3] ?? m[4] ?? '').toLowerCase();
    if (!value && !m[2]) continue;
    terms.push({ negate: m[1] === '-', key: m[2]?.toLowerCase() ?? null, value });
  }
  return terms;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

function termMatches(t: Term, it: Item, p: Project, actors: Actor[]): boolean {
  const v = norm(t.value);
  switch (t.key) {
    case 'status': {
      const st = p.statuses.find((s) => s.id === it.status);
      return norm(it.status) === v || (!!st && norm(st.name) === v);
    }
    case 'assignee':
      if (v === '@agents' || v === 'agents') return it.assignees.some((a) => actors.find((x) => x.id === a)?.kind === 'agent');
      if (v === 'none') return it.assignees.length === 0;
      return it.assignees.some((a) => norm(a) === v.replace(/^@/, ''));
    case 'label':
      return it.labels.some((l) => norm(l) === v);
    case 'priority':
      return norm(it.priority ?? 'none') === v;
    case 'size':
      return norm(it.size ?? 'none') === v;
    case 'agent':
      return norm(it.agent.state) === v;
    case 'is':
      if (v === 'needsyou') return it.agent.state === 'blocked' || it.agent.state === 'needs_review';
      if (v === 'open') return it.status !== 'done';
      if (v === 'closed') return it.status === 'done';
      return true;
    default: {
      const text = `${it.title}\n${it.body}\n#${it.number}`.toLowerCase();
      return text.includes(t.value);
    }
  }
}

export function filterItems(items: Item[], query: string, p: Project, actors: Actor[]): Item[] {
  const terms = tokenize(query);
  if (!terms.length) return items;
  return items.filter((it) => terms.every((t) => termMatches(t, it, p, actors) !== t.negate));
}

/** Toggle a `key:value` term in a query string (used by the quick-filter chips). */
export function toggleTerm(query: string, term: string): string {
  const parts = query.split(/\s+/).filter(Boolean);
  const has = parts.includes(term);
  return (has ? parts.filter((x) => x !== term) : [...parts, term]).join(' ');
}

export const hasTerm = (query: string, term: string) => query.split(/\s+/).includes(term);
