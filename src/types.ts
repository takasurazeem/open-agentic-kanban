export type AgentState = 'idle' | 'queued' | 'running' | 'blocked' | 'needs_review' | 'done';
export type Priority = 'Urgent' | 'High' | 'Medium' | 'Low';
export type Size = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type Color = 'gray' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple';

export const PRIORITIES: Priority[] = ['Urgent', 'High', 'Medium', 'Low'];
export const SIZES: Size[] = ['XS', 'S', 'M', 'L', 'XL'];
export const COLORS: Color[] = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'];

export interface Actor {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  model?: string;
}

export interface Status {
  id: string;
  name: string;
  color: Color;
  description: string;
}

export interface Activity {
  id: string;
  at: string;
  actor: string;
  kind: 'created' | 'comment' | 'status' | 'assigned' | 'renamed' | 'edited' | 'agent' | 'log' | 'link' | 'attachment';
  text: string;
  meta?: Record<string, any>;
}

export interface AgentInfo {
  state: AgentState;
  by?: string;
  model?: string;
  branch?: string;
  prUrl?: string;
  sessionUrl?: string;
  updatedAt?: string;
}

export interface Attachment {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface Item {
  number: number;
  title: string;
  body: string;
  status: string;
  rank: number;
  priority: Priority | null;
  size: Size | null;
  labels: string[];
  assignees: string[];
  agent: AgentInfo;
  activity: Activity[];
  /** Files in the item's attachments folder. */
  attachments?: Attachment[];
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  /** Linked code repos, e.g. "owner/name"; agents use these to find the project. */
  repos?: string[];
  /** Set when the board lives in a code repo's .kanban/ folder; absent for the central data folder. */
  repoPath?: string;
  statuses: Status[];
  items: Item[];
  createdAt: string;
}

export interface BoardState {
  version: number;
  actors: Actor[];
  projects: Project[];
}

/** Agent states where the human is the one holding things up. */
export const NEEDS_HUMAN: AgentState[] = ['blocked', 'needs_review'];
