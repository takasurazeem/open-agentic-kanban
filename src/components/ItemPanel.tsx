import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { actions } from '../api';
import { PRIORITIES, SIZES, type Activity, type Actor, type Attachment, type Item, type Project } from '../types';
import { AGENT_META, AgentBadge, Avatar, Label, PriorityChip, StatusPill, timeAgo } from './bits';
import { CsvTable } from './Csv';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { Menu } from './Menu';

type Run = (p: Promise<unknown>) => Promise<void>;

export function ItemPanel({
  project,
  item,
  actors,
  onClose,
  run,
}: {
  project: Project;
  item: Item;
  actors: Actor[];
  onClose: () => void;
  run: Run;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const patch = (p: Partial<Item>) => run(actions.updateItem(project.id, item.number, p));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea');
      if (e.key === 'Escape' && !typing) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [item.number]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="panel" role="dialog" aria-label={`#${item.number} ${item.title}`} ref={ref}>
        <header className="panel-head">
          <div className="panel-crumbs">
            <span>{project.name}</span>
            <span className="muted">#{item.number}</span>
          </div>
          <span className="spacer" />
          <button
            className="icon-btn danger-hover"
            title="Delete item"
            onClick={() => {
              if (confirm(`Delete #${item.number} "${item.title}"? This can't be undone.`)) {
                run(actions.deleteItem(project.id, item.number)).then(onClose);
              }
            }}
          >
            <Icon name="trash" />
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>

        <EditableTitle key={`t${item.number}`} value={item.title} onSave={(title) => patch({ title })} />

        <div className="panel-grid">
          <div className="panel-main">
            <AgentCard project={project} item={item} actors={actors} run={run} />
            <Description key={`d${item.number}`} item={item} onSave={(body) => patch({ body })} />
            <Attachments key={`a${item.number}`} item={item} project={project} run={run} />
            <Timeline item={item} project={project} actors={actors} />
            <Composer key={`c${item.number}`} item={item} project={project} run={run} />
          </div>

          <div className="panel-side">
            <Field label="Status">
              <Menu
                trigger={<StatusPill status={project.statuses.find((s) => s.id === item.status)} />}
                options={project.statuses.map((s) => ({ value: s.id, label: <StatusPill status={s} /> }))}
                selected={item.status}
                onSelect={(status) => patch({ status })}
                className="field-menu"
              />
            </Field>
            <Field label="Assignees">
              <Menu
                multi
                title="Assign people or agents"
                trigger={
                  item.assignees.length ? (
                    <span className="assignee-list">
                      {item.assignees.map((id) => {
                        const a = actors.find((x) => x.id === id);
                        return (
                          <span key={id} className="assignee">
                            <Avatar actor={a} size={18} /> {a?.name ?? id}
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                    <span className="muted">No one — assign yourself or an agent</span>
                  )
                }
                options={actors.map((a) => ({
                  value: a.id,
                  label: (
                    <span className="assignee">
                      <Avatar actor={a} size={18} /> {a.name}
                    </span>
                  ),
                  hint: a.kind === 'agent' ? 'agent' : undefined,
                }))}
                selected={item.assignees}
                onSelect={(id) =>
                  patch({
                    assignees: item.assignees.includes(id)
                      ? item.assignees.filter((x) => x !== id)
                      : [...item.assignees, id],
                  })
                }
                className="field-menu"
              />
            </Field>
            <Field label="Priority">
              <Menu
                trigger={item.priority ? <PriorityChip priority={item.priority} /> : <span className="muted">None</span>}
                options={[...PRIORITIES.map((p) => ({ value: p, label: <PriorityChip priority={p} /> })), { value: null, label: 'None' }]}
                selected={item.priority}
                onSelect={(priority) => patch({ priority })}
                className="field-menu"
              />
            </Field>
            <Field label="Size">
              <Menu
                trigger={item.size ? <span className="chip">{item.size}</span> : <span className="muted">None</span>}
                options={[...SIZES.map((s) => ({ value: s, label: s })), { value: null, label: 'None' }]}
                selected={item.size}
                onSelect={(size) => patch({ size })}
                className="field-menu"
              />
            </Field>
            <Field label="Labels">
              <LabelEditor key={`l${item.number}`} labels={item.labels} onSave={(labels) => patch({ labels })} />
            </Field>
            {(item.agent.branch || item.agent.prUrl || item.agent.sessionUrl) && (
              <Field label="Development">
                <div className="dev-links">
                  {item.agent.branch && (
                    <span className="dev-link">
                      <Icon name="branch" size={14} /> <code>{item.agent.branch}</code>
                    </span>
                  )}
                  {item.agent.prUrl && (
                    <a className="dev-link" href={item.agent.prUrl} target="_blank" rel="noreferrer">
                      <Icon name="pr" size={14} /> {shortUrl(item.agent.prUrl)}
                    </a>
                  )}
                  {item.agent.sessionUrl && (
                    <a className="dev-link" href={item.agent.sessionUrl} target="_blank" rel="noreferrer">
                      <Icon name="link" size={14} /> Agent session
                    </a>
                  )}
                </div>
              </Field>
            )}
            <p className="side-foot muted">
              Opened {timeAgo(item.createdAt)} · updated {timeAgo(item.updatedAt)}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}

function shortUrl(url: string) {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]}#${m[2]}` : url.replace(/^https?:\/\//, '').slice(0, 40);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
    </div>
  );
}

function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  if (!editing) {
    return (
      <h2 className="panel-title" onClick={() => setEditing(true)} title="Click to edit">
        {value}
      </h2>
    );
  }
  const save = () => {
    setEditing(false);
    if (draft.trim() && draft !== value) onSave(draft.trim());
    else setDraft(value);
  };
  return (
    <input
      className="input panel-title-input"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') (setDraft(value), setEditing(false));
      }}
    />
  );
}

/** The human ↔ agent handoff: what the agent is doing and what you can do about it. */
function AgentCard({ project, item, actors, run }: { project: Project; item: Item; actors: Actor[]; run: Run }) {
  const [reply, setReply] = useState('');
  const agents = actors.filter((a) => a.kind === 'agent');
  const assignedAgent = actors.find((a) => a.kind === 'agent' && item.assignees.includes(a.id));
  const agent = assignedAgent ?? actors.find((a) => a.id === item.agent.by);
  const state = item.agent.state;
  const setAgent = (p: object) => run(actions.setAgent(project.id, item.number, p));

  if (!agent && state === 'idle') {
    if (!agents.length) return null;
    return (
      <div className="agent-card agent-card-empty">
        <Icon name="sparkle" />
        <span>Hand this to an agent. It'll be queued and picked up through the board's MCP server.</span>
        <span className="spacer" />
        {agents.map((a) => (
          <button
            key={a.id}
            className="btn btn-sm"
            onClick={() => run(actions.updateItem(project.id, item.number, { assignees: [...item.assignees, a.id] }))}
          >
            Assign {a.name}
          </button>
        ))}
      </div>
    );
  }

  const lastNote = [...item.activity].reverse().find((a) => a.actor === agent?.id && a.text && a.kind !== 'comment');
  const meta = AGENT_META[state];

  async function replyAnd(state: string) {
    if (reply.trim()) await run(actions.comment(project.id, item.number, reply.trim()));
    await setAgent({ state, note: undefined });
    setReply('');
  }

  return (
    <div className={`agent-card agent-card-${state}`} style={{ ['--tone' as string]: `var(--c-${meta.tone})` }}>
      <div className="agent-card-head">
        <Avatar actor={agent} size={24} />
        <div>
          <div className="agent-card-title">
            {agent?.name ?? 'Agent'} <AgentBadge state={state} />
          </div>
          <div className="muted small">
            {state === 'queued' && 'Waiting to be picked up'}
            {state === 'running' && `Working · last update ${timeAgo(item.agent.updatedAt)}`}
            {state === 'blocked' && 'Needs your input to continue'}
            {state === 'needs_review' && 'Finished — waiting for your review'}
            {state === 'done' && `Finished ${timeAgo(item.agent.updatedAt)}`}
            {state === 'idle' && 'Not working on this'}
            {item.agent.model && ` · ${item.agent.model}`}
          </div>
        </div>
        <span className="spacer" />
        {(state === 'running' || state === 'queued') && (
          <button className="btn btn-sm" onClick={() => setAgent({ state: 'idle', note: 'Stopped by you' })}>
            <Icon name="stop" size={12} /> Stop
          </button>
        )}
        {(state === 'idle' || state === 'done') && (
          <button className="btn btn-sm" onClick={() => setAgent({ state: 'queued' })}>
            <Icon name="play" size={12} /> Queue again
          </button>
        )}
      </div>

      {lastNote && state !== 'idle' && (
        <div className="agent-note">
          <Markdown text={lastNote.text} />
        </div>
      )}

      {(state === 'blocked' || state === 'needs_review') && (
        <div className="agent-reply">
          <textarea
            className="input"
            rows={2}
            placeholder={state === 'blocked' ? `Answer ${agent?.name ?? 'the agent'}…` : 'Feedback for changes (optional when approving)…'}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <div className="row gap-sm">
            {state === 'blocked' ? (
              <button className="btn btn-primary btn-sm" disabled={!reply.trim()} onClick={() => replyAnd('queued')}>
                Reply and unblock
              </button>
            ) : (
              <>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={async () => {
                    if (reply.trim()) await run(actions.comment(project.id, item.number, reply.trim()));
                    await setAgent({ state: 'done' });
                    const done = project.statuses.find((s) => s.id === 'done') ?? project.statuses.at(-1)!;
                    await run(actions.updateItem(project.id, item.number, { status: done.id }));
                    setReply('');
                  }}
                >
                  <Icon name="check" size={12} /> Approve and close
                </button>
                <button className="btn btn-sm" disabled={!reply.trim()} onClick={() => replyAnd('queued')}>
                  Request changes
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Description({ item, onSave }: { item: Item; onSave: (body: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [draft, setDraft] = useState(item.body);

  if (!editing) {
    return (
      <section className="box">
        <div className="box-head">
          <span className="box-title">Description</span>
          <span className="spacer" />
          <button className="icon-btn" title="Edit description" onClick={() => (setDraft(item.body), setTab('write'), setEditing(true))}>
            <Icon name="pencil" size={14} />
          </button>
        </div>
        <div className="box-body">
          <Markdown text={item.body} />
        </div>
      </section>
    );
  }
  return (
    <section className="box box-editing">
      <div className="box-head tabs-sm">
        <button className={tab === 'write' ? 'on' : ''} onClick={() => setTab('write')}>Write</button>
        <button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>Preview</button>
        <span className="spacer" />
        <span className="muted small">Markdown, Mermaid and images supported</span>
      </div>
      <div className="box-body">
        {tab === 'write' ? (
          <textarea
            className="input editor"
            autoFocus
            rows={14}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (onSave(draft), setEditing(false));
            }}
          />
        ) : (
          <Markdown text={draft} empty="Nothing to preview." />
        )}
        <div className="row gap-sm end">
          <button className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={() => (onSave(draft), setEditing(false))}>Save</button>
        </div>
      </div>
    </section>
  );
}

function Timeline({ item, project, actors }: { item: Item; project: Project; actors: Actor[] }) {
  const name = (id: string) => actors.find((a) => a.id === id)?.name ?? id;
  const status = (id: string) => project.statuses.find((s) => s.id === id);

  function describe(ev: Activity): React.ReactNode {
    const m = ev.meta ?? {};
    switch (ev.kind) {
      case 'created':
        return 'created this item';
      case 'status':
        return (
          <>
            moved this from <StatusPill status={status(m.from)} /> to <StatusPill status={status(m.to)} />
          </>
        );
      case 'assigned': {
        const parts = [];
        if (m.added?.length) parts.push(`assigned ${m.added.map(name).join(', ')}`);
        if (m.removed?.length) parts.push(`unassigned ${m.removed.map(name).join(', ')}`);
        return parts.join(' and ');
      }
      case 'renamed':
        return (
          <>
            renamed this from <s>{m.from}</s>
          </>
        );
      case 'edited':
        return `edited ${(m.fields ?? []).join(', ')}`;
      case 'agent':
        return (
          <>
            {m.to === 'running' ? 'started working' : 'set agent state to'} {m.to !== 'running' && <AgentBadge state={m.to} />}
          </>
        );
      case 'link':
        return (
          <>
            linked{' '}
            {Object.entries(m).map(([k, v]) =>
              k === 'branch' ? (
                <code key={k}>{String(v)}</code>
              ) : (
                <a key={k} href={String(v)} target="_blank" rel="noreferrer">
                  {k === 'prUrl' ? shortUrl(String(v)) : 'a session'}
                </a>
              ),
            )}
          </>
        );
      case 'attachment':
        return m.action === 'removed' ? (
          <>
            removed <code>{m.name}</code>
          </>
        ) : (
          <>
            attached <code>{m.name}</code>
          </>
        );
      case 'log':
        return 'posted an update';
      default:
        return ev.kind;
    }
  }

  const events = item.activity;
  return (
    <section className="timeline" aria-label="Activity">
      <h3 className="section-title">Activity</h3>
      {events.map((ev) => {
        const actor = actors.find((a) => a.id === ev.actor);
        const isAgent = actor?.kind === 'agent';
        if (ev.kind === 'comment' || ((ev.kind === 'log' || ev.kind === 'agent') && ev.text)) {
          return (
            <div key={ev.id} className={`tl-comment ${isAgent ? 'tl-agent' : ''}`}>
              <Avatar actor={actor} size={28} />
              <div className="box">
                <div className="box-head">
                  <strong>{name(ev.actor)}</strong>
                  {isAgent && <span className="chip chip-agent">agent</span>}
                  {ev.kind !== 'comment' && <span className="muted small">{describe(ev)}</span>}
                  <span className="muted small" title={new Date(ev.at).toLocaleString()}>
                    {timeAgo(ev.at)}
                  </span>
                </div>
                <div className="box-body">
                  <Markdown text={ev.text} />
                </div>
              </div>
            </div>
          );
        }
        return (
          <div key={ev.id} className="tl-event">
            <span className="tl-dot">
              <Avatar actor={actor} size={18} />
            </span>
            <span>
              <strong>{name(ev.actor)}</strong> {describe(ev)}{' '}
              <span className="muted" title={new Date(ev.at).toLocaleString()}>
                {timeAgo(ev.at)}
              </span>
            </span>
          </div>
        );
      })}
    </section>
  );
}

function Composer({ item, project, run }: { item: Item; project: Project; run: Run }) {
  const [text, setText] = useState('');
  const submit = async () => {
    if (!text.trim()) return;
    await run(actions.comment(project.id, item.number, text.trim()));
    setText('');
  };
  return (
    <div className="composer">
      <textarea
        className="input"
        rows={3}
        placeholder="Leave a comment (Markdown). ⌘↵ to send"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit()}
      />
      <div className="row end">
        <button className="btn btn-primary btn-sm" disabled={!text.trim()} onClick={submit}>
          Comment
        </button>
      </div>
    </div>
  );
}

function LabelEditor({ labels, onSave }: { labels: string[]; onSave: (l: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const l = draft.trim().toLowerCase();
    if (l && !labels.includes(l)) onSave([...labels, l]);
    setDraft('');
  };
  return (
    <div className="label-editor">
      {labels.map((l) => (
        <span key={l} className="label-removable">
          <Label name={l} />
          <button className="icon-btn tiny" title={`Remove ${l}`} onClick={() => onSave(labels.filter((x) => x !== l))}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      <input
        className="input input-bare"
        placeholder="Add label…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') (e.preventDefault(), add());
        }}
        onBlur={add}
      />
    </div>
  );
}

type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'markdown' | 'csv' | null;
const PREVIEW_EXT: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio',
  pdf: 'pdf',
  txt: 'text', md: 'markdown', markdown: 'markdown', log: 'text', json: 'text', csv: 'csv', tsv: 'csv',
};
const previewKind = (name: string): PreviewKind => PREVIEW_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
const MAX_TEXT_PREVIEW = 200_000;

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Files attached to the item, with inline previews. Drop files on the box or use the button. */
function Attachments({ item, project, run }: { item: Item; project: Project; run: Run }) {
  const files = item.attachments ?? [];
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(list: FileList | File[]) {
    setError('');
    setBusy(true);
    try {
      for (const f of Array.from(list)) await actions.addAttachment(project.id, item.number, f);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`box attachments ${over ? 'attachments-over' : ''}`}
      aria-label="Attachments"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) (e.preventDefault(), setOver(true));
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      <div className="box-head">
        <span className="box-title">Attachments{files.length > 0 && ` (${files.length})`}</span>
        <span className="spacer" />
        <input ref={input} type="file" multiple hidden onChange={(e) => (e.target.files && upload(e.target.files), (e.target.value = ''))} />
        <button className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="clip" size={12} /> {busy ? 'Uploading…' : 'Attach files'}
        </button>
      </div>
      {error && <div className="attachments-error">{error}</div>}
      {files.length === 0 ? (
        <div className="box-body muted small">Drop files here or use Attach files. Images, video, audio, PDFs and text preview inline.</div>
      ) : (
        <ul className="attachment-list">
          {files.map((f) => (
            <AttachmentRow key={f.name} file={f} item={item} project={project} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AttachmentRow({ file, item, project, run }: { file: Attachment; item: Item; project: Project; run: Run }) {
  const kind = previewKind(file.name);
  const url = actions.attachmentUrl(project.id, item.number, file.name);
  const [open, setOpen] = useState(kind === 'image'); // images show right away; the rest open on demand
  const [text, setText] = useState<string | null>(null);
  const [view, setView] = useState<'rich' | 'source'>('rich'); // Markdown files: rendered or raw
  const [full, setFull] = useState(false); // preview open in a large modal

  useEffect(() => {
    if (!full) return;
    // Esc closes the expanded preview first, without also closing the card panel behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setFull(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [full]);

  useEffect(() => {
    if (!open || (kind !== 'text' && kind !== 'csv' && kind !== 'markdown') || text !== null) return;
    let cancelled = false;
    fetch(url, { headers: { Range: `bytes=0-${MAX_TEXT_PREVIEW - 1}` } })
      .then((r) => r.text())
      .then((t) => {
        if (cancelled) return;
        if (file.size <= MAX_TEXT_PREVIEW) return setText(t);
        const cut = t.slice(0, MAX_TEXT_PREVIEW);
        // For a table, drop the row that was cut in half; for text, say it was cut.
        setText(kind === 'csv' ? cut.slice(0, Math.max(0, cut.lastIndexOf('\n'))) : `${cut}\n… (truncated, download for the full file)`);
      })
      .catch(() => !cancelled && setText('Could not load a preview.'));
    return () => {
      cancelled = true;
    };
  }, [open, kind, text, url, file.size]);

  const preview = kind && (
    <div className={`attachment-preview ${full ? 'preview-full' : ''}`} role={full ? 'dialog' : undefined} aria-label={full ? file.name : undefined}>
      {full && (
        <div className="preview-full-head">
          <strong>{file.name}</strong>
          <span className="muted small">{formatSize(file.size)} · Esc to close</span>
        </div>
      )}
      <button
        className="icon-btn preview-full-btn"
        title={full ? 'Close (Esc)' : 'Expand'}
        aria-label={full ? 'Close expanded preview' : 'Expand preview'}
        onClick={() => setFull((f) => !f)}
      >
        <Icon name={full ? 'x' : 'expand'} size={14} />
      </button>
      {kind === 'image' && (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={file.name} loading="lazy" />
        </a>
      )}
      {kind === 'video' && <video src={url} controls preload="metadata" />}
      {kind === 'audio' && <audio src={url} controls preload="metadata" />}
      {kind === 'pdf' && <iframe src={url} title={file.name} />}
      {kind === 'text' && <pre>{text ?? 'Loading…'}</pre>}
      {kind === 'markdown' && (
        <>
          <div className="preview-tabs" role="tablist" aria-label="Markdown view">
            {(['rich', 'source'] as const).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={`chip-btn ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>
                {v === 'rich' ? 'Rich preview' : 'Source'}
              </button>
            ))}
          </div>
          {text === null ? (
            <pre>Loading…</pre>
          ) : view === 'rich' ? (
            <div className="md-rich">
              <Markdown text={text} empty="This file is empty." baseUrl={actions.attachmentUrl(project.id, item.number, '')} />
            </div>
          ) : (
            <pre>{text}</pre>
          )}
        </>
      )}
      {kind === 'csv' &&
        (text === null ? <pre>Loading…</pre> : <CsvTable text={text} delimiter={file.name.toLowerCase().endsWith('.tsv') ? '\t' : ','} />)}
    </div>
  );

  const isImage = kind === 'image';
  const markdown = `${isImage ? '!' : ''}[${file.name}](${url})`;

  return (
    <li className="attachment">
      <div className="attachment-row">
        <Icon name="clip" size={14} />
        <a href={url} target="_blank" rel="noreferrer" className="attachment-name" title="Open or download">
          {file.name}
        </a>
        <span className="muted small">{formatSize(file.size)}</span>
        <span className="spacer" />
        {kind && kind !== 'image' && (
          <button className="btn btn-sm" onClick={() => setOpen(!open)}>
            {open ? 'Hide preview' : 'Preview'}
          </button>
        )}
        <button
          className="btn btn-sm"
          title="Copy a Markdown link to paste into the description or a comment"
          onClick={() => navigator.clipboard?.writeText(markdown)}
        >
          Copy link
        </button>
        <button
          className="icon-btn danger-hover"
          title={`Remove ${file.name}`}
          onClick={() => {
            if (confirm(`Remove "${file.name}"? This can't be undone.`)) run(actions.deleteAttachment(project.id, item.number, file.name));
          }}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      {open && kind && (full ? createPortal(<div className="preview-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setFull(false)}>{preview}</div>, document.body) : preview)}
    </li>
  );
}
