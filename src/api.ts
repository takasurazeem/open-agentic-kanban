import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardState, Item } from './types';

export class ApiError extends Error {}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const itemPath = (project: string, number: number, rest = '') =>
  `/projects/${encodeURIComponent(project)}/items/${number}${rest}`;

export const actions = {
  createProject: (name: string) => api<{ id: string }>('POST', '/projects', { name }),
  updateProject: (id: string, patch: object) => api('PATCH', `/projects/${encodeURIComponent(id)}`, patch),
  deleteProject: (id: string) => api('DELETE', `/projects/${encodeURIComponent(id)}`),
  createItem: (project: string, body: object) =>
    api<Item>('POST', `/projects/${encodeURIComponent(project)}/items`, { actor: 'you', ...body }),
  updateItem: (project: string, number: number, patch: object) =>
    api<Item>('PATCH', itemPath(project, number), { actor: 'you', ...patch }),
  deleteItem: (project: string, number: number) => api('DELETE', itemPath(project, number)),
  comment: (project: string, number: number, text: string) =>
    api('POST', itemPath(project, number, '/comments'), { actor: 'you', text }),
  setAgent: (project: string, number: number, patch: object) =>
    api('PATCH', itemPath(project, number, '/agent'), { actor: 'you', ...patch }),
  importLegacy: (projects: unknown[]) => api<{ added: string[] }>('POST', '/import', { projects }),
};

export type Connection = 'connecting' | 'live' | 'offline';

/**
 * The whole board, kept fresh over server-sent events. `optimistic` applies a local change
 * immediately (e.g. while dragging) until the server's next version arrives.
 */
export function useBoard() {
  const [state, setState] = useState<BoardState | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<number | null>(null);

  const refetch = useCallback(async () => {
    try {
      setState(await api<BoardState>('GET', '/state'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refetch();
    const es = new EventSource('/api/events');
    es.onopen = () => setConnection('live');
    es.onerror = () => setConnection('offline');
    es.onmessage = () => {
      if (pending.current) window.clearTimeout(pending.current);
      pending.current = window.setTimeout(refetch, 30);
    };
    return () => es.close();
  }, [refetch]);

  const optimistic = useCallback((fn: (draft: BoardState) => void) => {
    setState((s) => {
      if (!s) return s;
      const draft = structuredClone(s);
      fn(draft);
      return draft;
    });
  }, []);

  return { state, connection, error, setError, refetch, optimistic };
}
