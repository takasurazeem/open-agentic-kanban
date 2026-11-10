import { useEffect, useRef, useState } from 'react';
import type { Actor, Item, Project } from '../types';
import { AgentBadge, AvatarStack, Label, PriorityChip, StatusDot } from './bits';
import { Icon } from './Icon';

/** Collapsed and pinned columns are a per-viewer view preference, kept in this browser. */
function useColumnPrefs(projectId: string) {
  const key = `kanban.columns.${projectId}`;
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? '{}');
      return { collapsed: Array.isArray(v.collapsed) ? (v.collapsed as string[]) : [], pinned: Array.isArray(v.pinned) ? (v.pinned as string[]) : [] };
    } catch {
      return { collapsed: [] as string[], pinned: [] as string[] };
    }
  };
  const [prefs, setPrefs] = useState(read);
  useEffect(() => setPrefs(read()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (kind: 'collapsed' | 'pinned', id: string) =>
    setPrefs((p) => {
      const list = p[kind].includes(id) ? p[kind].filter((x) => x !== id) : [...p[kind], id];
      const next = { ...p, [kind]: list };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
      return next;
    });
  return { prefs, toggle };
}

const COLUMN_WIDTH = 340;
const COLLAPSED_WIDTH = 48;
const BOARD_GAP = 12;
const BOARD_PAD = 24;

interface Drop {
  status: string;
  index: number;
}

interface DragState {
  number: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  width: number;
}

/**
 * Pointer-based drag and drop (works with mouse, pen and touch; touch starts with a long press so
 * the board still scrolls normally). Alt+←/→ on a focused card moves it between columns.
 */
export function Board({
  project,
  items,
  actors,
  filtered,
  onOpen,
  onMove,
  onCreate,
}: {
  project: Project;
  items: Item[];
  actors: Actor[];
  filtered: boolean;
  onOpen: (n: number) => void;
  onMove: (n: number, status: string, rank: number) => void;
  onCreate: (status: string, title: string) => Promise<void>;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const live = useRef({ drag, drop });
  live.current = { drag, drop };
  const suppressClick = useRef(false);
  const { prefs, toggle } = useColumnPrefs(project.id);

  const columns = project.statuses.map((st) => ({
    status: st,
    items: items.filter((i) => i.status === st.id).sort((a, b) => a.rank - b.rank),
    total: project.items.filter((i) => i.status === st.id).length,
  }));
  const colsRef = useRef(columns);
  colsRef.current = columns;

  function rankAt(statusId: string, index: number, moving: number) {
    const rest = colsRef.current.find((c) => c.status.id === statusId)!.items.filter((i) => i.number !== moving);
    const before = rest[index - 1];
    const after = rest[index];
    return before && after ? (before.rank + after.rank) / 2 : before ? before.rank + 1 : after ? after.rank - 1 : 1;
  }

  function targetAt(x: number, y: number, moving: number): Drop | null {
    const col = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-status]');
    if (!col) return null;
    const cards = [...col.querySelectorAll<HTMLElement>('[data-card]')].filter((c) => Number(c.dataset.card) !== moving);
    const i = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return { status: col.dataset.status!, index: i === -1 ? cards.length : i };
  }

  function startPointer(e: React.PointerEvent<HTMLElement>, number: number) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input')) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const touch = e.pointerType === 'touch';
    let active = false;
    let timer: number | undefined;

    const activate = (x: number, y: number) => {
      active = true;
      navigator.vibrate?.(10);
      setDrag({ number, x, y, dx: sx - rect.left, dy: sy - rect.top, width: rect.width });
      setDrop(targetAt(x, y, number));
    };
    const move = (ev: PointerEvent) => {
      const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (!active) {
        if (touch) {
          if (dist > 8) cleanup(); // the user is scrolling, not dragging
          return;
        }
        if (dist < 5) return;
        activate(ev.clientX, ev.clientY);
      }
      setDrag((d) => d && { ...d, x: ev.clientX, y: ev.clientY });
      const t = targetAt(ev.clientX, ev.clientY, number);
      setDrop((d) => (d?.status === t?.status && d?.index === t?.index ? d : t));
    };
    const blockScroll = (ev: TouchEvent) => active && ev.preventDefault();
    const up = () => {
      if (active) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
        const t = live.current.drop;
        if (t) onMove(number, t.status, rankAt(t.status, t.index, number));
      }
      cleanup();
    };
    const key = (ev: KeyboardEvent) => ev.key === 'Escape' && cleanup();
    function cleanup() {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cleanup);
      window.removeEventListener('touchmove', blockScroll);
      window.removeEventListener('keydown', key);
      setDrag(null);
      setDrop(null);
    }
    if (touch) timer = window.setTimeout(() => activate(sx, sy), 300);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cleanup);
    window.addEventListener('touchmove', blockScroll, { passive: false });
    window.addEventListener('keydown', key);
  }

  function moveBy(it: Item, delta: number) {
    const i = project.statuses.findIndex((s) => s.id === it.status) + delta;
    const target = project.statuses[i];
    if (!target) return;
    onMove(it.number, target.id, rankAt(target.id, Number.MAX_SAFE_INTEGER, it.number));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card="${it.number}"]`)?.focus());
  }

  useEffect(() => {
    document.body.classList.toggle('is-dragging', !!drag);
  }, [drag]);

  let pinLeft = BOARD_PAD;
  const dragged = drag ? items.find((i) => i.number === drag.number) : undefined;

  return (
    <div className="board">
      {columns.map(({ status, items: colItems, total }) => {
        const isTarget = drop?.status === status.id;
        const visible = colItems.filter((i) => i.number !== drag?.number || !isTarget);
        const collapsed = prefs.collapsed.includes(status.id);
        const pinned = prefs.pinned.includes(status.id);
        // A pinned column stays where it is in the row, but sticks to the left edge once you scroll
        // past it. Several pinned columns stack side by side.
        const style = pinned ? { left: pinLeft } : undefined;
        if (pinned) pinLeft += (collapsed ? COLLAPSED_WIDTH : COLUMN_WIDTH) + BOARD_GAP;
        const pinButton = (
          <button
            className={`icon-btn pin-btn ${pinned ? 'on' : ''}`}
            title={pinned ? 'Unpin column' : 'Pin column in place while scrolling'}
            aria-pressed={pinned}
            onClick={() => toggle('pinned', status.id)}
          >
            <Icon name="pin" size={14} />
          </button>
        );
        if (collapsed) {
          return (
            <section
              key={status.id}
              data-status={status.id}
              style={style}
              className={`column column-collapsed ${pinned ? 'column-pinned' : ''} ${isTarget ? 'column-target' : ''}`}
              aria-label={`${status.name} (collapsed)`}
            >
              <button className="icon-btn" title="Expand column" onClick={() => toggle('collapsed', status.id)}>
                <Icon name="chevronR" size={14} />
              </button>
              <span className="count">{total}</span>
              <button className="column-collapsed-title" title={`Expand ${status.name}`} onClick={() => toggle('collapsed', status.id)}>
                <StatusDot color={status.color} />
                <span>{status.name}</span>
              </button>
              {pinButton}
            </section>
          );
        }
        return (
          <section
            key={status.id}
            data-status={status.id}
            style={style}
            className={`column ${pinned ? 'column-pinned' : ''} ${isTarget ? 'column-target' : ''}`}
            aria-label={status.name}
          >
            <header className="column-head">
              <StatusDot color={status.color} />
              <h3>{status.name}</h3>
              <span className="count">{filtered && total !== colItems.length ? `${colItems.length} / ${total}` : total}</span>
              <span className="spacer" />
              {pinButton}
              <button className="icon-btn" title="Collapse column" onClick={() => toggle('collapsed', status.id)}>
                <Icon name="chevronL" size={14} />
              </button>
            </header>
            {status.description && <p className="column-desc">{status.description}</p>}

            <div className="column-list">
              {visible.map((it, idx) => (
                <div key={it.number}>
                  {isTarget && drop!.index === idx && <div className="drop-line" />}
                  <Card
                    item={it}
                    actors={actors}
                    dragging={drag?.number === it.number}
                    onOpen={() => !suppressClick.current && onOpen(it.number)}
                    onPointerDown={(e) => startPointer(e, it.number)}
                    onMoveBy={(d) => moveBy(it, d)}
                  />
                </div>
              ))}
              {isTarget && drop!.index >= visible.length && <div className="drop-line" />}
              {!visible.length && !isTarget && <p className="column-empty">{filtered ? 'No matching items' : 'No items'}</p>}
            </div>

            {adding === status.id ? (
              <AddItem
                onCancel={() => setAdding(null)}
                onSubmit={async (title) => {
                  await onCreate(status.id, title);
                }}
              />
            ) : (
              <button className="column-add" onClick={() => setAdding(status.id)}>
                <Icon name="plus" size={14} /> Add item
              </button>
            )}
          </section>
        );
      })}
      {drag && dragged && (
        <div className="drag-ghost" style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.width }}>
          <Card item={dragged} actors={actors} dragging={false} onOpen={() => {}} />
        </div>
      )}
    </div>
  );
}

function Card({
  item,
  actors,
  dragging,
  onOpen,
  onPointerDown,
  onMoveBy,
}: {
  item: Item;
  actors: Actor[];
  dragging: boolean;
  onOpen: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onMoveBy?: (delta: number) => void;
}) {
  const comments = item.activity.filter((a) => a.kind === 'comment').length;
  const lastLog = [...item.activity].reverse().find((a) => (a.kind === 'log' || a.kind === 'agent') && a.text);
  const needsYou = item.agent.state === 'blocked' || item.agent.state === 'needs_review';

  return (
    <article
      className={`card ${dragging ? 'card-dragging' : ''} ${needsYou ? 'card-needs-you' : ''} ${item.agent.state === 'running' ? 'card-running' : ''}`}
      data-card={item.number}
      tabIndex={0}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      onPointerDown={onPointerDown}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          onMoveBy?.(e.key === 'ArrowLeft' ? -1 : 1);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="card-top">
        <span className="card-number">#{item.number}</span>
        <AgentBadge state={item.agent.state} />
        <span className="spacer" />
        <AvatarStack ids={item.assignees} actors={actors} size={18} />
      </div>
      <h4 className="card-title">{item.title}</h4>
      {item.agent.state !== 'idle' && item.agent.state !== 'done' && lastLog && (
        <p className="card-log" title={plain(lastLog.text)}>
          {plain(lastLog.text)}
        </p>
      )}
      {(item.labels.length > 0 || item.priority || item.size || comments > 0 || item.agent.prUrl || (item.attachments?.length ?? 0) > 0) && (
        <div className="card-meta">
          {item.labels.map((l) => (
            <Label key={l} name={l} />
          ))}
          <PriorityChip priority={item.priority} />
          {item.size && <span className="chip">{item.size}</span>}
          <span className="spacer" />
          {item.agent.prUrl && (
            <span className="meta-icon" title="Pull request linked">
              <Icon name="pr" size={13} />
            </span>
          )}
          {(item.attachments?.length ?? 0) > 0 && (
            <span className="meta-icon" title={`${item.attachments!.length} attachments`}>
              <Icon name="clip" size={13} /> {item.attachments!.length}
            </span>
          )}
          {comments > 0 && (
            <span className="meta-icon" title={`${comments} comments`}>
              <Icon name="comment" size={13} /> {comments}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/** Markdown → one line of plain text, for card previews. */
function plain(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function AddItem({ onSubmit, onCancel }: { onSubmit: (title: string) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  return (
    <form
      className="add-item"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        await onSubmit(title.trim());
        setTitle('');
      }}
    >
      <input
        autoFocus
        className="input"
        placeholder="Item title — Enter to add, Esc to close"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        onBlur={() => !title && onCancel()}
      />
    </form>
  );
}
