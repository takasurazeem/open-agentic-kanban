import { useState } from 'react';
import { COLORS, type Color, type Project, type Status } from '../types';
import { StatusDot } from './bits';
import { Icon } from './Icon';
import { Menu } from './Menu';

export function ProjectSettings({
  project,
  onSave,
  onDelete,
  onClose,
}: {
  project: Project;
  onSave: (patch: Partial<Project>) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [visibility, setVisibility] = useState(project.visibility);
  const [statuses, setStatuses] = useState<Status[]>(project.statuses);

  const update = (i: number, p: Partial<Status>) => setStatuses((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: number) =>
    setStatuses((s) => {
      const n = [...s];
      const [x] = n.splice(i, 1);
      n.splice(i + d, 0, x);
      return n;
    });

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Project settings">
        <header className="dialog-head">
          <h2>Project settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="dialog-body">
          <label className="form-row">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="form-row">
            <span>Short description</span>
            <input
              className="input"
              value={description}
              placeholder="What is this project about?"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="form-row">
            <span>Visibility</span>
            <div className="segmented">
              {(['private', 'public'] as const).map((v) => (
                <button key={v} className={visibility === v ? 'on' : ''} onClick={() => setVisibility(v)}>
                  <Icon name={v === 'private' ? 'lock' : 'globe'} size={13} /> {v === 'private' ? 'Private' : 'Public'}
                </button>
              ))}
            </div>
          </div>

          <div className="form-row">
            <span>Status options</span>
            <p className="muted small">
              These are the board's columns. Items in a removed status move to the first one. Agents move items to{' '}
              <code>in_progress</code> and <code>in_review</code> when those exist.
            </p>
            <div className="status-editor">
              {statuses.map((s, i) => (
                <div key={s.id || i} className="status-row">
                  <Menu<Color>
                    trigger={<StatusDot color={s.color} />}
                    options={COLORS.map((c) => ({ value: c, label: <><StatusDot color={c} /> {c}</> }))}
                    selected={s.color}
                    onSelect={(color) => update(i, { color })}
                  />
                  <input className="input" value={s.name} onChange={(e) => update(i, { name: e.target.value })} />
                  <input
                    className="input"
                    placeholder="Description"
                    value={s.description}
                    onChange={(e) => update(i, { description: e.target.value })}
                  />
                  <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                    <Icon name="arrowUp" size={14} />
                  </button>
                  <button className="icon-btn" disabled={i === statuses.length - 1} onClick={() => move(i, 1)} title="Move down">
                    <Icon name="arrowDown" size={14} />
                  </button>
                  <button
                    className="icon-btn danger-hover"
                    disabled={statuses.length === 1}
                    onClick={() => setStatuses((x) => x.filter((_, j) => j !== i))}
                    title="Remove"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
              <button
                className="btn btn-sm"
                onClick={() => setStatuses((s) => [...s, { id: '', name: 'New status', color: 'gray', description: '' }])}
              >
                <Icon name="plus" size={12} /> Add status
              </button>
            </div>
          </div>
        </div>
        <footer className="dialog-foot">
          <button
            className="btn btn-danger btn-sm"
            onClick={() => confirm(`Delete "${project.name}" and all its items?`) && onDelete()}
          >
            Delete project
          </button>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={async () => {
              await onSave({ name, description, visibility, statuses: statuses.filter((s) => s.name.trim()) });
              onClose();
            }}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
