/**
 * Small UI primitives: an inline icon set and a status badge.
 *
 * The icons are plain SVG paths so the bundle stays free of an icon
 * dependency.
 */

import type { ReactNode } from 'react';

export type IconName =
  | 'plus'
  | 'trash'
  | 'edit'
  | 'settings'
  | 'menu'
  | 'send'
  | 'stop'
  | 'copy'
  | 'check'
  | 'refresh'
  | 'close'
  | 'alert'
  | 'server'
  | 'moon'
  | 'sun'
  | 'trash-filled'
  | 'download'
  | 'search'
  | 'sidebar'
  | 'sparkle'
  | 'info'
  | 'arrow-down'
  | 'chevron-down'
  | 'chevron-right'
  | 'external';

const PATHS: Record<IconName, string> = {
  plus: 'M8 3.5v9M3.5 8h9',
  trash:
    'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2',
  edit: 'M11.2 2.8l2 2L6 12H4v-2l7.2-7.2z',
  settings:
    'M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5zM8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4',
  menu: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
  send: 'M2.5 8L14 2.5 11.5 14 8 9.5 2.5 8z',
  stop: 'M4.8 4.8h6.4v6.4H4.8z',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7',
  check: 'M3 8.5l3.2 3.2L13 5',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5',
  close: 'M4 4l8 8M12 4l-8 8',
  alert: 'M8 2.8L14 13H2L8 2.8zM8 6.8v2.6M8 11.2v.1',
  server: 'M2.5 3.5h11v3h-11zM2.5 9.5h11v3h-11zM4.7 5h.01M4.7 11h.01',
  moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z',
  sun: 'M8 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1',
  'trash-filled':
    'M3 4.5h10l-.8 9.2a1 1 0 0 1-1 .8H4.8a1 1 0 0 1-1-.8L3 4.5zM6 4.5V3h4v1.5M6.5 7v4M9.5 7v4',
  download: 'M8 2.5v8M4.6 7.4L8 10.8l3.4-3.4M2.8 13h10.4',
  search: 'M7.2 11.4A4.2 4.2 0 1 0 7.2 3a4.2 4.2 0 0 0 0 8.4zM10.4 10.4L13.6 13.6',
  sidebar: 'M2.5 3.5h11v9h-11zM6.5 3.5v9',
  sparkle: 'M8 2l1.2 3.6L12.8 7l-3.6 1.2L8 11.8 6.8 8.2 3.2 7l3.6-1.4L8 2z',
  info: 'M8 7.2v4M8 4.4v.1M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z',
  'arrow-down': 'M8 3v9M4.5 8.5L8 12l3.5-3.5',
  'chevron-down': 'M4 6l4 4 4-4',
  'chevron-right': 'M6 4l4 4-4 4',
  external: 'M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5L8 8',
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}

export function Icon({ name, size = 16, className, title }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      className={className}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}

export type BadgeTone = 'neutral' | 'ok' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
}

export function Badge({ tone = 'neutral', children, title }: BadgeProps) {
  const className = tone === 'neutral' ? 'badge' : `badge badge--${tone}`;
  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

export type StatusTone = 'ok' | 'warning' | 'danger' | 'neutral';

/** A coloured dot that always comes with text next to it. */
export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />;
}
