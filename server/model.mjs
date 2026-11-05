// Shared constants for the board model (used by the store, the API and the MCP server).
export const AGENT_STATES = ['idle', 'queued', 'running', 'blocked', 'needs_review', 'done'];
export const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
export const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
export const STATUS_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'];

export const DEFAULT_STATUSES = [
  { id: 'todo', name: 'Todo', color: 'green', description: "This item hasn't been started" },
  { id: 'in_progress', name: 'In progress', color: 'yellow', description: 'This is actively being worked on' },
  { id: 'in_review', name: 'In review', color: 'blue', description: 'Waiting on a human to review' },
  { id: 'done', name: 'Done', color: 'purple', description: 'This has been completed' },
];
