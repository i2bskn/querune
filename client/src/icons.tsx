import type { ReactNode } from "react";

// Decorative icons drawn with the current text color. The text next to them names the thing, so screen
// readers skip them; an icon-only button gives itself an aria-label.
function Icon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      className={className === undefined ? "icon" : `icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function UsersIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
      <path d="M15.5 5.8a3 3 0 0 1 0 5.4M17 14.5c1.9.6 3.1 2.2 3.5 4.5" />
    </Icon>
  );
}

export function LogoutIcon() {
  return (
    <Icon>
      <path d="M14 4.5H6.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1H14" />
      <path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5" />
    </Icon>
  );
}

// Overview: a gauge of four tiles.
export function OverviewIcon() {
  return (
    <Icon>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="4.5" rx="1.5" />
      <rect x="13" y="11" width="7" height="9" rx="1.5" />
      <rect x="4" y="13.5" width="7" height="6.5" rx="1.5" />
    </Icon>
  );
}

// Sites: a globe.
export function SitesIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z" />
    </Icon>
  );
}

// A chevron that points into a row that links to a screen.
export function ChevronRightIcon() {
  return (
    <Icon>
      <path d="m9.5 6 6 6-6 6" />
    </Icon>
  );
}

export function MenuIcon() {
  return (
    <Icon>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

// Performance: a rising line over a baseline.
export function ChartIcon() {
  return (
    <Icon>
      <path d="M4 19.5h16" />
      <path d="M5 15.5l4-4.5 3.5 3 6.5-7.5" />
      <path d="M15.5 6.5H19v3.5" />
    </Icon>
  );
}

// Articles: a page with lines.
export function ArticleIcon() {
  return (
    <Icon>
      <path d="M7 3.5h7.5L19 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M14 3.5V8.5h5M9 12.5h7M9 16h5" />
    </Icon>
  );
}

// Memos: a note with a folded corner and a pen stroke.
export function MemoIcon() {
  return (
    <Icon>
      <path d="M5 4.5h14v9.5l-5.5 5.5H5z" />
      <path d="M13.5 19.5V14H19M8.5 9h7M8.5 12.5h4" />
    </Icon>
  );
}

// Data import: a tray with an arrow into it.
export function ImportIcon() {
  return (
    <Icon>
      <path d="M12 3.5v10M8 10l4 4 4-4" />
      <path d="M4 14.5v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </Icon>
  );
}

// Settings: sliders.
export function SettingsIcon() {
  return (
    <Icon>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </Icon>
  );
}

export function SearchIcon() {
  return (
    <Icon>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </Icon>
  );
}

export function ExternalIcon() {
  return (
    <Icon>
      <path d="M13.5 4.5h6v6M19.5 4.5 11 13" />
      <path d="M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10" />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M15.5 8.5V5.5a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
    </Icon>
  );
}

export function ChevronDownIcon() {
  return (
    <Icon>
      <path d="m6 9.5 6 6 6-6" />
    </Icon>
  );
}

export function ArrowLeftIcon() {
  return (
    <Icon>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Icon>
  );
}
