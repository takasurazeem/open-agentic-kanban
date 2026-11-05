import { useState } from 'react';
import { PRIORITIES, type Actor, type Item, type Project } from '../types';
import { AgentBadge, AvatarStack, Label, PriorityChip, StatusPill, timeAgo } from './bits';
import { Icon } from './Icon';
import { Menu } from './Menu';

type SortKey = 'number' | 'title' | 'status' | 'priority' | 'agent' | 'updated';

const AGENT_ORDER = ['blocked', 'needs_review', 'running', 'queued', 'done', 'idle'];

export function TableView({
  project,
  items,
  actors,
  onOpen,
  onPatch,
}: {
  project: Project;
  items: Item[];
  actors: Actor[];
  onOpen: (n: number) => void;
  onPatch: (n: number, patch: Partial<Item>) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'status', dir: 1 });
  const statusIndex = (id: string) => project.statuses.findIndex((s) => s.id === id);

  const cmp: Record<SortKey, (a: Item, b: Item) => number> = {
    number: (a, b) => a.number - b.number,
    title: (a, b) => a.title.localeCompare(b.title),
    status: (a, b) => statusIndex(a.status) - statusIndex(b.status) || a.rank - b.rank,
    priority: (a, b) =>
      (a.priority ? PRIORITIES.indexOf(a.priority) : 9) - (b.priority ? PRIORITIES.indexOf(b.priority) : 9),
    agent: (a, b) => AGENT_ORDER.indexOf(a.agent.state) - AGENT_ORDER.indexOf(b.agent.state),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  };
  const rows = [...items].sort((a, b) => cmp[sort.key](a, b) * sort.dir);

  const Th = ({ k, children, className }: { k?: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={className}>
      {k ? (
        <button
          className="th-sort"
          onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : 1 }))}
        >
          {children}
          {sort.key === k && <Icon name={sort.dir === 1 ? 'arrowDown' : 'arrowUp'} size={12} />}
        </button>
      ) : (
        children
      )}
    </th>
  );

  if (!rows.length) return <div className="empty-state">No items match this view.</div>;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <Th k="title" className="col-title">Title</Th>
            <Th k="status">Status</Th>
            <Th>Assignees</Th>
            <Th k="agent">Agent</Th>
            <Th k="priority">Priority</Th>
            <Th>Size</Th>
            <Th>Labels</Th>
            <Th k="updated">Updated</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((it) => (
            <tr key={it.number}>
              <td className="col-title">
                <button className="row-title" onClick={() => onOpen(it.number)}>
                  <span className="muted">#{it.number}</span> {it.title}
                </button>
              </td>
              <td>
                <Menu
                  trigger={<StatusPill status={project.statuses.find((s) => s.id === it.status)} />}
                  options={project.statuses.map((s) => ({ value: s.id, label: <StatusPill status={s} /> }))}
                  selected={it.status}
                  onSelect={(status) => onPatch(it.number, { status })}
                  className="cell-menu"
                />
              </td>
              <td>
                <AvatarStack ids={it.assignees} actors={actors} />
              </td>
              <td>
                <AgentBadge state={it.agent.state} />
              </td>
              <td>
                <PriorityChip priority={it.priority} />
              </td>
              <td>{it.size && <span className="chip">{it.size}</span>}</td>
              <td>
                <span className="label-row">
                  {it.labels.map((l) => (
                    <Label key={l} name={l} />
                  ))}
                </span>
              </td>
              <td className="muted nowrap">{timeAgo(it.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
