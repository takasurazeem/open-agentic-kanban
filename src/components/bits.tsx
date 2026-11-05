import type { Actor, AgentState, Color, Priority, Status } from '../types';
import { Icon, type IconName } from './Icon';

export function timeAgo(iso: string | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function StatusDot({ color }: { color: Color }) {
  return <span className="status-dot" style={{ ['--dot' as string]: `var(--c-${color})` }} />;
}

export function StatusPill({ status }: { status?: Status }) {
  if (!status) return null;
  return (
    <span className="pill" style={{ ['--tone' as string]: `var(--c-${status.color})` }}>
      <StatusDot color={status.color} />
      {status.name}
    </span>
  );
}

export function Avatar({ actor, size = 20 }: { actor?: Actor; size?: number }) {
  if (!actor) return null;
  const initials = actor.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className={`avatar ${actor.kind === 'agent' ? 'avatar-agent' : ''}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      title={`${actor.name}${actor.kind === 'agent' ? ' (agent)' : ''}`}
    >
      {actor.kind === 'agent' ? <Icon name="sparkle" size={Math.round(size * 0.62)} /> : initials}
    </span>
  );
}

export function AvatarStack({ ids, actors, size = 20 }: { ids: string[]; actors: Actor[]; size?: number }) {
  return (
    <span className="avatar-stack">
      {ids.map((id) => (
        <Avatar key={id} actor={actors.find((a) => a.id === id)} size={size} />
      ))}
    </span>
  );
}

export const AGENT_META: Record<AgentState, { label: string; icon: IconName; tone: Color }> = {
  idle: { label: 'Idle', icon: 'clock', tone: 'gray' },
  queued: { label: 'Queued', icon: 'clock', tone: 'gray' },
  running: { label: 'Working', icon: 'sparkle', tone: 'purple' },
  blocked: { label: 'Blocked', icon: 'alert', tone: 'red' },
  needs_review: { label: 'Ready for review', icon: 'eye', tone: 'blue' },
  done: { label: 'Finished', icon: 'check', tone: 'green' },
};

export function AgentBadge({ state, compact }: { state: AgentState; compact?: boolean }) {
  if (state === 'idle') return null;
  const m = AGENT_META[state];
  return (
    <span className={`agent-badge agent-${state}`} style={{ ['--tone' as string]: `var(--c-${m.tone})` }}>
      {state === 'running' ? <span className="pulse" /> : <Icon name={m.icon} size={12} />}
      {!compact && m.label}
    </span>
  );
}

const PRIORITY_TONE: Record<Priority, Color> = { Urgent: 'red', High: 'orange', Medium: 'yellow', Low: 'gray' };

export function PriorityChip({ priority }: { priority: Priority | null }) {
  if (!priority) return null;
  return (
    <span className="chip" style={{ ['--tone' as string]: `var(--c-${PRIORITY_TONE[priority]})` }}>
      {priority}
    </span>
  );
}

/** Stable color for a label name, so the same label looks the same everywhere. */
export function labelColor(name: string): Color {
  const known: Record<string, Color> = { bug: 'red', enhancement: 'blue', idea: 'yellow', ml: 'pink', docs: 'gray' };
  if (known[name]) return known[name];
  const palette: Color[] = ['blue', 'green', 'orange', 'pink', 'purple', 'yellow'];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

export function Label({ name }: { name: string }) {
  return (
    <span className="label" style={{ ['--tone' as string]: `var(--c-${labelColor(name)})` }}>
      {name}
    </span>
  );
}
