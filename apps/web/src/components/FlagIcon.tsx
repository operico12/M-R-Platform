// One small line icon per flag, stage, wait, standby reason, status and alert (Ope, 29 Oct 2026),
// drawn in the menu's style so they read as one set. The label always sits beside the icon;
// the icon never carries meaning on its own.

import type { ReactNode } from 'react';

const TRUCK = <><path d="M3 16V7h10v9M13 10h4l3 3v3h-7" /><circle cx="7" cy="17" r="2" /><circle cx="17" cy="17" r="2" /></>;
const PERSON = <><circle cx="12" cy="8" r="3.5" /><path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7" /></>;
const DOTS = <><circle cx="6" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18" cy="12" r="1.2" /></>;
const BOX = <path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10" />;
const WRENCH = <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z" />;
const CREW = <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 14.5c2.8 0 5 2.2 5 5" /></>;
const BAY = <path d="M3 21V9l9-6 9 6v12M7 21v-8h10v8M7 17h10" />;
const CHECK = <><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></>;
const PAUSE = <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>;

const PATHS: Record<string, ReactNode> = {
  // Wait tags (docs/wait-tags.md)
  TOW: <><path d="M14 4h6M17 4v7a3 3 0 1 1-3 3" /><path d="M3 18h8M5 18V11h6v7" /></>,
  TRANSPORT: TRUCK,
  PARTS: BOX,
  LABOUR: <><path d="M7 9a5 5 0 0 1 10 0M5 9h14" /><path d="M9 9v1a3 3 0 0 0 6 0V9M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7" /></>,
  CREW,
  LINE: BAY,
  TOOLS: WRENCH,
  SPECIALIST: <><rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="10" r="3" /><path d="M8 17c1.2-2 6.8-2 8 0" /></>,
  ENGINEERING: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h7M9 17h5" /></>,
  OPERATOR: <><circle cx="12" cy="7" r="3.5" /><path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7" /><path d="M9 3.5h6" /></>,
  DECISION: <><path d="M12 3v18M5 7h14M5 7l-2 6a3 3 0 0 0 4 0zM19 7l-2 6a3 3 0 0 0 4 0z" /></>,
  APPROVAL: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 13l2 2 4-4" /></>,
  ACCESS: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  OTHER: DOTS,
  // Standby reasons (docs/standby.md)
  SHIFT_CHANGE: <path d="M4 8h14l-3-3M20 16H6l3 3" />,
  CRIB: <path d="M4 9h12v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM16 10h2a2.5 2.5 0 0 1 0 5h-2.5M8 3v3M12 3v3" />,
  REFUEL: <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 10h10M14 7l3 2v8a1.5 1.5 0 0 0 3 0V8l-3-3" />,
  DISPATCH_HOLD: PAUSE,
  PRESTART: <path d="M10 6h10M10 12h10M10 18h10M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" />,
  NO_OPERATOR: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7M4 4l16 16" /></>,
  NO_WORK: <path d="M4 7h16l-2 13H6zM9 7V4h6v3" />,
  WEATHER: <path d="M7 15a4 4 0 1 1 1-7.9A5 5 0 0 1 17.6 9 3 3 0 0 1 17 15zM8 18l-1 3M12 18l-1 3M16 18l-1 3" />,
  BLASTING: <path d="M12 2l2 6 6-2-4 5 5 3-6 1 1 6-4-4-4 4 1-6-6-1 5-3-4-5 6 2z" />,
  ROAD_DUMP: <path d="M3 9h18v5H3zM6 14v7M18 14v7M7 9l3 5M13 9l3 5" />,
  // Stages (A7 section 4)
  waiting_crew: CREW,
  in_transit: TRUCK,
  waiting_line: BAY,
  in_repair: WRENCH,
  waiting_parts: BOX,
  waiting_labour: PERSON,
  waiting_other: DOTS,
  ready_for_release: CHECK,
  no_stage: DOTS,
  // Flag types and locations
  unscheduled: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>,
  scheduled: <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  field: <path d="M3 20l6-11 4 6 3-4 5 9z" />,
  towing: <><path d="M14 4h6M17 4v7a3 3 0 1 1-3 3" /><path d="M3 18h8M5 18V11h6v7" /></>,
  shop_yard: <path d="M3 21V10l9-6 9 6v11M3 21h18M8 21v-5h8v5" />,
  shop_line: BAY,
  in_place: <><circle cx="12" cy="10" r="3" /><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /></>,
  // Statuses and tags on the board
  in_use: <path d="M5 12l5 5 9-10" />,
  standby: PAUSE,
  parked: <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M10 17V8h3a2.5 2.5 0 0 1 0 5h-3" /></>,
  closed: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  proposed: <path d="M5 21V4M5 4h12l-2.5 4L17 12H5" />,
  no_reading: <><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4-5M4 4l16 16" /></>,
  alert: <path d="M12 3l10 18H2zM12 10v5M12 18v.5" />,
  eta: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
};

/** The icon for a code. Unknown codes get three dots. */
export function FlagIcon({ code, size = 16 }: { code: string; size?: number }) {
  return (
    <svg className="ficon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[code] ?? DOTS}
    </svg>
  );
}
