// Shared constants for the board model (used by the store, the API and the MCP server).
export const AGENT_STATES = ['idle', 'queued', 'running', 'blocked', 'needs_review', 'done'];
export const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
export const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
export const STATUS_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'];

export const DEFAULT_STATUSES = [
  { id: 'backlog', name: 'Backlog', color: 'gray', description: 'Ideas and work not yet planned' },
  { id: 'todo', name: 'Todo', color: 'green', description: "This item hasn't been started" },
  { id: 'in_progress', name: 'In progress', color: 'yellow', description: 'This is actively being worked on' },
  { id: 'on_hold', name: 'On hold', color: 'orange', description: 'Paused until something outside this item changes' },
  { id: 'in_review', name: 'In review', color: 'blue', description: 'Waiting on a human to review' },
  { id: 'done', name: 'Done', color: 'purple', description: 'This has been completed' },
];

/**
 * A repo reference in canonical form: "owner/name" for a git remote URL or slug, or just "name"
 * for a bare folder name. Lowercase, no host, no ".git".
 */
export function normRepo(ref) {
  let s = String(ref ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/\.git$/, '').replace(/\/+$/, '');
  s = s.replace(/^[a-z+]+:\/\/[^/]+\//, '').replace(/^[^@/]+@[^:]+:/, ''); // https://host/ or git@host:
  const parts = s.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

export const normRepos = (list) =>
  [...new Set((Array.isArray(list) ? list : []).map(normRepo).filter((r) => r && r.length <= 200))];

/** Does a project's repo list match this repo (remote URL, owner/name, or folder name)? */
export function repoMatches(projectRepos, ref) {
  const want = normRepo(ref);
  if (!want) return false;
  const wantName = want.split('/').pop();
  return (projectRepos ?? []).some((r) => {
    if (r === want) return true;
    // Both are owner/name and differ: different repos. Otherwise compare just the names.
    if (r.includes('/') && want.includes('/')) return false;
    return r.split('/').pop() === wantName;
  });
}
