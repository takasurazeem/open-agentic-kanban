// Small stroke icon set drawn for this app (16px grid).
const paths: Record<string, string> = {
  board: 'M2.5 2.5h3v11h-3zM6.5 2.5h3v7h-3zM10.5 2.5h3v9h-3z',
  table: 'M2 3.5h12M2 8h12M2 12.5h12M5.5 3.5v9',
  plus: 'M8 3v10M3 8h10',
  x: 'M4 4l8 8M12 4l-8 8',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6L14 14',
  check: 'M3 8.5l3 3 7-7',
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.5V8l2.5 1.5',
  alert: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.5',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  branch: 'M5 2.5v11M5 13.5a1.5 1.5 0 1 0 0-.01M11 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11 5.5c0 3-6 2.5-6 6',
  pr: 'M4.5 5.5v8M4.5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 10.5V6a2 2 0 0 0-2-2H7M8.5 2.5L7 4l1.5 1.5M11.5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  link: 'M7 9a2.5 2.5 0 0 0 3.5 0l2.5-2.5A2.5 2.5 0 0 0 9.5 3L8.5 4M9 7a2.5 2.5 0 0 0-3.5 0L3 9.5A2.5 2.5 0 0 0 6.5 13l1-1',
  comment: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9',
  chevron: 'M4 6l4 4 4-4',
  sun: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1',
  moon: 'M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
  globe: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12',
  sparkle: 'M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4zM13 11l.6 1.4 1.4.6-1.4.6L13 15l-.6-1.4L11 13l1.4-.6z',
  play: 'M5 3.5l7 4.5-7 4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  pencil: 'M10.5 2.5l3 3-8 8h-3v-3zM9 4l3 3',
  gear: 'M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7M10.5 3v3M5.5 10v3',
  dots: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  inbox: 'M2 9.5l2-6h8l2 6v4H2zM2 9.5h3.5l1 1.5h3l1-1.5H14',
  arrowUp: 'M8 13V3M4 7l4-4 4 4',
  arrowDown: 'M8 3v10M4 9l4 4 4-4',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'dots' ? 2.6 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
