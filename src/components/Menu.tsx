import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface MenuOption<T> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
}

/**
 * Button that opens a list of options. Single select by default; with `multi` it toggles
 * values and stays open.
 */
export function Menu<T extends string | null>({
  trigger,
  options,
  selected,
  onSelect,
  multi,
  title,
  align = 'left',
  className,
}: {
  trigger: ReactNode;
  options: MenuOption<T>[];
  selected?: T | T[];
  onSelect: (value: T) => void;
  multi?: boolean;
  title?: string;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const isSelected = (v: T) => (Array.isArray(selected) ? selected.includes(v) : selected === v);

  return (
    <div className={`menu ${className ?? ''}`} ref={ref}>
      <button type="button" className="menu-trigger" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div className={`menu-list menu-${align}`} role="listbox">
          {title && <div className="menu-title">{title}</div>}
          {options.map((o) => (
            <button
              type="button"
              role="option"
              aria-selected={isSelected(o.value)}
              key={String(o.value)}
              className="menu-option"
              onClick={() => {
                onSelect(o.value);
                if (!multi) setOpen(false);
              }}
            >
              <span className="menu-check">{isSelected(o.value) && <Icon name="check" size={14} />}</span>
              <span className="menu-label">{o.label}</span>
              {o.hint && <span className="menu-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
