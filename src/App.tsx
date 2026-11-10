import { useCallback, useEffect, useMemo, useState } from 'react';
import { actions, useBoard } from './api';
import { filterItems, hasTerm, toggleTerm } from './query';
import type { Item } from './types';
import { Board } from './components/Board';
import { TableView } from './components/TableView';
import { ItemPanel } from './components/ItemPanel';
import { Sidebar } from './components/Sidebar';
import { ProjectSettings } from './components/ProjectSettings';
import { Icon } from './components/Icon';

type View = 'board' | 'table';
type Theme = 'system' | 'light' | 'dark';

interface Route {
  project?: string;
  view: View;
  item?: number;
  q: string;
}

function parseHash(): Route {
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [project, view] = path.split('/');
  const params = new URLSearchParams(qs);
  return {
    project: project ? decodeURIComponent(project) : undefined,
    view: view === 'table' ? 'table' : 'board',
    item: params.get('item') ? Number(params.get('item')) : undefined,
    q: params.get('q') ?? '',
  };
}

function toHash(r: Route) {
  const params = new URLSearchParams();
  if (r.item) params.set('item', String(r.item));
  if (r.q) params.set('q', r.q);
  const qs = params.toString();
  return `#/${r.project ? encodeURIComponent(r.project) : ''}/${r.view}${qs ? `?${qs}` : ''}`;
}

const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  remove: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (storage.get('theme') as Theme) ?? 'system');
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
    };
    apply();
    storage.set('theme', theme);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme] as const;
}

export default function App() {
  const { state, connection, sync, error, setError, optimistic } = useBoard();
  const [route, setRoute] = useState<Route>(parseHash);
  const [theme, setTheme] = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const go = useCallback((patch: Partial<Route>, replace = false) => {
    const next = { ...parseHash(), ...patch };
    const hash = toHash(next);
    if (replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
    setRoute(next);
  }, []);

  const run = useCallback(
    async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [setError],
  );

  const project = state?.projects.find((p) => p.id === route.project) ?? state?.projects[0];
  const items = useMemo(
    () => (project && state ? filterItems(project.items, route.q, project, state.actors) : []),
    [project, route.q, state],
  );
  const openItem = route.item != null ? project?.items.find((i) => i.number === route.item) : undefined;

  useEffect(() => {
    document.title = project ? `${project.name} · Agentic Kanban` : 'Agentic Kanban';
  }, [project]);

  if (!state) {
    return (
      <div className="loading">
        {error ? (
          <>
            <strong>Can't reach the board API.</strong>
            <span className="muted">{error}. Start it with <code>npm run dev</code>.</span>
          </>
        ) : (
          'Loading…'
        )}
      </div>
    );
  }

  const needsYou = project?.items.filter((i) => i.agent.state === 'blocked' || i.agent.state === 'needs_review').length ?? 0;
  const quick = [
    { term: 'is:needs-you', label: 'Needs you', count: needsYou, attn: true },
    { term: 'assignee:@agents', label: 'Assigned to agents' },
    { term: 'is:open', label: 'Open' },
  ];

  const setQuery = (q: string) => go({ q }, true);
  const themeNext: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      <header className="topbar">
        <button className="icon-btn nav-toggle" onClick={() => setNavOpen((o) => !o)} title="Projects">
          <Icon name="menu" />
        </button>
        <a className="brand" href="#/">
          <span className="brand-mark">
            <Icon name="board" size={14} />
          </span>
          Agentic Kanban
        </a>
        <span className="spacer" />
        {(() => {
          const syncWarn = connection === 'live' && sync?.enabled && (sync.lastError || sync.problems.length > 0);
          const tip = syncWarn
            ? `Sync problem: ${sync.lastError ?? sync.problems.map((p) => p.message).join('; ')}`
            : connection === 'live'
              ? 'Receiving live updates from agents'
              : 'Not connected';
          return (
            <span className={`conn conn-${syncWarn ? 'warn' : connection}`} title={tip}>
              <span className="conn-dot" />
              {syncWarn ? 'Sync issue' : connection === 'live' ? 'Live' : connection === 'offline' ? 'Offline' : 'Connecting'}
            </span>
          );
        })()}
        <button
          className="icon-btn"
          title={`Theme: ${theme} (click to change)`}
          onClick={() => setTheme(themeNext[theme])}
        >
          <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'eye'} />
        </button>
      </header>

      <div className="layout">
        <Sidebar
          state={state}
          activeId={project?.id}
          onSelect={(id) => (go({ project: id, item: undefined, q: '' }), setNavOpen(false))}
          onCreate={async (input) => {
            try {
              const p = await actions.createProject(input);
              go({ project: p.id, item: undefined, q: '' });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          onOpenItem={(pid, n) => (go({ project: pid, item: n }), setNavOpen(false))}
        />
        <div className="nav-scrim" onClick={() => setNavOpen(false)} />

        <main className="main">
          {!project ? (
            <div className="empty-state">
              <h2>No projects yet</h2>
              <p className="muted">Point a project at a git repo from the sidebar; its cards live in the repo’s .kanban/ folder.</p>
            </div>
          ) : (
            <>
              <div className="project-head">
                <div className="project-title-row">
                  <h1>{project.name}</h1>
                  <span className="visibility" title={project.visibility === 'private' ? 'Private' : 'Public'}>
                    <Icon name={project.visibility === 'private' ? 'lock' : 'globe'} size={12} />
                    {project.visibility === 'private' ? 'Private' : 'Public'}
                  </span>
                  <span className="spacer" />
                  <button className="icon-btn" title="Project settings" onClick={() => setSettingsOpen(true)}>
                    <Icon name="gear" />
                  </button>
                </div>
                {project.description && <p className="project-desc">{project.description}</p>}
              </div>

              <div className="toolbar">
                <div className="view-tabs" role="tablist">
                  {(['board', 'table'] as const).map((v) => (
                    <button
                      key={v}
                      role="tab"
                      aria-selected={route.view === v}
                      className={route.view === v ? 'on' : ''}
                      onClick={() => go({ view: v }, true)}
                    >
                      <Icon name={v} size={14} /> {v === 'board' ? 'Board' : 'Table'}
                    </button>
                  ))}
                </div>
                <label className="filter">
                  <Icon name="search" size={14} />
                  <input
                    value={route.q}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter: status:todo assignee:claude label:bug agent:running …"
                    spellCheck={false}
                  />
                  {route.q && (
                    <button className="icon-btn tiny" onClick={() => setQuery('')} title="Clear filter">
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </label>
                <div className="quick-filters">
                  {quick.map((f) => (
                    <button
                      key={f.term}
                      className={`chip-btn ${hasTerm(route.q, f.term) ? 'on' : ''}`}
                      onClick={() => setQuery(toggleTerm(route.q, f.term))}
                    >
                      {f.label}
                      {f.count ? <span className={f.attn ? 'badge-attn' : 'count'}>{f.count}</span> : null}
                    </button>
                  ))}
                </div>
              </div>

              <div className="view">
                {route.view === 'board' ? (
                  <Board
                    project={project}
                    items={items}
                    actors={state.actors}
                    filtered={!!route.q.trim()}
                    onOpen={(n) => go({ item: n })}
                    onMove={(n, status, rank) => {
                      optimistic((d) => {
                        const it = d.projects.find((p) => p.id === project.id)?.items.find((i) => i.number === n);
                        if (it) Object.assign(it, { status, rank });
                      });
                      run(actions.updateItem(project.id, n, { status, rank }));
                    }}
                    onCreate={(status, title) => run(actions.createItem(project.id, { status, title }))}
                  />
                ) : (
                  <TableView
                    project={project}
                    items={items}
                    actors={state.actors}
                    onOpen={(n) => go({ item: n })}
                    onPatch={(n, patch: Partial<Item>) => run(actions.updateItem(project.id, n, patch))}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {project && openItem && (
        <ItemPanel project={project} item={openItem} actors={state.actors} onClose={() => go({ item: undefined })} run={run} />
      )}

      {project && settingsOpen && (
        <ProjectSettings
          project={project}
          onClose={() => setSettingsOpen(false)}
          onSave={(patch) => run(actions.updateProject(project.id, patch))}
          onDelete={() => {
            run(actions.deleteProject(project.id));
            setSettingsOpen(false);
            go({ project: undefined, item: undefined, q: '' });
          }}
        />
      )}

      {error && (
        <div className="toast" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
          <button className="icon-btn tiny" onClick={() => setError(null)} title="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
