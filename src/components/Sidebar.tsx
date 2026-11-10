import { useState } from 'react';
import type { BoardState } from '../types';
import { AgentBadge, Avatar } from './bits';
import { Icon } from './Icon';

export function Sidebar({
  state,
  activeId,
  onSelect,
  onCreate,
  onOpenItem,
  legacy,
  onImport,
}: {
  state: BoardState;
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: (input: { name?: string; path?: string }) => Promise<void>;
  onOpenItem: (project: string, n: number) => void;
  legacy: boolean;
  onImport: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [mode, setMode] = useState<'repo' | 'central'>('repo');
  const close = () => (setCreating(false), setName(''), setRepoPath(''));

  // Everything agents are doing, or waiting on you for, across all projects.
  const work = state.projects.flatMap((p) =>
    p.items
      .filter((i) => ['running', 'blocked', 'needs_review', 'queued'].includes(i.agent.state))
      .map((i) => ({ p, i })),
  );
  const order = ['blocked', 'needs_review', 'running', 'queued'];
  work.sort((a, b) => order.indexOf(a.i.agent.state) - order.indexOf(b.i.agent.state));

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="side-section">
        <div className="side-head">
          <span>Projects</span>
          <button className="icon-btn" title="New project" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {state.projects.map((p) => {
          const open = p.items.filter((i) => i.status !== 'done').length;
          const waiting = p.items.filter((i) => i.agent.state === 'blocked' || i.agent.state === 'needs_review').length;
          return (
            <button
              key={p.id}
              className={`side-item ${p.id === activeId ? 'active' : ''}`}
              onClick={() => onSelect(p.id)}
            >
              <Icon name="board" size={14} />
              <span className="side-name">{p.name}</span>
              {waiting > 0 && (
                <span className="badge-attn" title={`${waiting} waiting on you`}>
                  {waiting}
                </span>
              )}
              <span className="side-count">{open}</span>
            </button>
          );
        })}
        {creating && (
          <form
            className="new-project"
            onSubmit={async (e) => {
              e.preventDefault();
              if (mode === 'repo' ? !repoPath.trim() : !name.trim()) return;
              await onCreate(mode === 'repo' ? { path: repoPath.trim(), name: name.trim() || undefined } : { name: name.trim() });
              close();
            }}
          >
            {mode === 'repo' && (
              <input
                className="input"
                autoFocus
                spellCheck={false}
                placeholder="Path to a git repo, e.g. ~/Developer/my-app"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && close()}
              />
            )}
            <input
              className="input"
              autoFocus={mode === 'central'}
              placeholder={mode === 'repo' ? 'Name (optional, defaults to the folder)' : 'Project name'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && close()}
            />
            <p className="muted small">
              {mode === 'repo'
                ? 'Uses the board in the repo’s .kanban/ folder, or creates one there.'
                : 'Stored in the central data folder, not in any repo.'}
            </p>
            <div className="row gap-sm">
              <button className="btn btn-primary btn-sm" type="submit">
                {mode === 'repo' ? 'Use repo' : 'Create'}
              </button>
              <button className="btn btn-sm" type="button" onClick={close}>
                Cancel
              </button>
              <span className="spacer" />
              <button className="btn btn-sm" type="button" onClick={() => setMode(mode === 'repo' ? 'central' : 'repo')}>
                {mode === 'repo' ? 'No repo' : 'Use a repo'}
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="side-section">
        <div className="side-head">
          <span>Agent activity</span>
        </div>
        {work.length === 0 && (
          <p className="side-empty">No agent work right now. Assign an item to an agent to queue it.</p>
        )}
        {work.map(({ p, i }) => (
          <button key={`${p.id}-${i.number}`} className="side-work" onClick={() => onOpenItem(p.id, i.number)}>
            <AgentBadge state={i.agent.state} compact />
            <span className="side-work-text">
              <span className="side-work-title">{i.title}</span>
              <span className="side-work-ref">
                {p.name} #{i.number}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="side-section side-agents">
        {state.actors
          .filter((a) => a.kind === 'agent')
          .map((a) => {
            const running = work.filter((w) => w.i.agent.state === 'running' && w.i.agent.by === a.id).length;
            return (
              <div key={a.id} className="side-agent">
                <Avatar actor={a} size={20} />
                <span>{a.name}</span>
                <span className="muted small">{running ? `${running} running` : 'idle'}</span>
              </div>
            );
          })}
      </div>

      {legacy && (
        <div className="side-import">
          <p>Boards from the previous version are still in this browser.</p>
          <button className="btn btn-sm" onClick={onImport}>
            Import them
          </button>
        </div>
      )}
    </nav>
  );
}
