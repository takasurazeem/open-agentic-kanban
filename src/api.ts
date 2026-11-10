import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, BoardState, Item } from './types';

export class ApiError extends Error {}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const itemPath = (project: string, number: number, rest = '') =>
  `/projects/${encodeURIComponent(project)}/items/${number}${rest}`;

export const actions = {
  /** With `path`, points the project at a code repo: its .kanban/ board is used, or created if missing. */
  createProject: (input: { name?: string; path?: string }) =>
    api<{ id: string; created?: boolean; itemCount?: number }>('POST', '/projects', input),
  moveProject: (id: string, path: string) => api('POST', `/projects/${encodeURIComponent(id)}/move`, { path }),
  updateProject: (id: string, patch: object) => api('PATCH', `/projects/${encodeURIComponent(id)}`, patch),
  deleteProject: (id: string) => api('DELETE', `/projects/${encodeURIComponent(id)}`),
  createItem: (project: string, body: object) =>
    api<Item>('POST', `/projects/${encodeURIComponent(project)}/items`, { actor: 'you', ...body }),
  updateItem: (project: string, number: number, patch: object) =>
    api<Item>('PATCH', itemPath(project, number), { actor: 'you', ...patch }),
  deleteItem: (project: string, number: number) => api('DELETE', itemPath(project, number)),
  comment: (project: string, number: number, text: string) =>
    api('POST', itemPath(project, number, '/comments'), { actor: 'you', text }),
  attachmentUrl: (project: string, number: number, name: string) =>
    `/api${itemPath(project, number, `/attachments/${encodeURIComponent(name)}`)}`,
  addAttachment: async (project: string, number: number, file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return api<Attachment>('POST', itemPath(project, number, '/attachments'), {
      actor: 'you',
      name: file.name || 'pasted-file',
      content: btoa(bin),
    });
  },
  deleteAttachment: (project: string, number: number, name: string) =>
    api('DELETE', itemPath(project, number, `/attachments/${encodeURIComponent(name)}?actor=you`)),
  setAgent: (project: string, number: number, patch: object) =>
    api('PATCH', itemPath(project, number, '/agent'), { actor: 'you', ...patch }),
  importLegacy: (projects: unknown[]) => api<{ added: string[] }>('POST', '/import', { projects }),
};

export interface SyncStatus {
  enabled: boolean;
  remote: string | null;
  lastCommitAt: string | null;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
  pending: boolean;
  problems: { message: string }[];
}

export type Connection = 'connecting' | 'live' | 'offline';

/**
 * The whole board, kept fresh over server-sent events. `optimistic` applies a local change
 * immediately (e.g. while dragging) until the server's next version arrives.
 */
export function useBoard() {
  const [state, setState] = useState<BoardState | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const pending = useRef<number | null>(null);

  const refetch = useCallback(async () => {
    try {
      setState(await api<BoardState>('GET', '/state'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const refreshSync = useCallback(() => {
    api<SyncStatus>('GET', '/sync').then(setSync, () => {});
  }, []);

  useEffect(() => {
    refetch();
    refreshSync();
    const poll = window.setInterval(refreshSync, 15000);
    const es = new EventSource('/api/events');
    es.onopen = () => setConnection('live');
    es.onerror = () => setConnection('offline');
    es.onmessage = () => {
      if (pending.current) window.clearTimeout(pending.current);
      pending.current = window.setTimeout(() => {
        refetch();
        refreshSync();
      }, 30);
    };
    return () => {
      es.close();
      window.clearInterval(poll);
    };
  }, [refetch, refreshSync]);

  const optimistic = useCallback((fn: (draft: BoardState) => void) => {
    setState((s) => {
      if (!s) return s;
      const draft = structuredClone(s);
      fn(draft);
      return draft;
    });
  }, []);

  return { state, connection, sync, error, setError, refetch, optimistic };
}
