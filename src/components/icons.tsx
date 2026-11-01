import React from 'react';

/**
 * Small inline SVG icons (quick-wins design §REVISION 2 / R2.7).
 *
 * The project has no icon library — icons are otherwise hardcoded Unicode glyphs,
 * with one precedent for an inline `<svg>` (`UsageReservoir.tsx`). The generic
 * ⬇/⬆ glyphs read as a bare "arrow" and render inconsistently across OSes, so the
 * data actions use these instead. Every icon:
 *   - inherits `currentColor` (stroke), so dark/light theme "just works";
 *   - is `aria-hidden` (the accessible label lives on the button that wraps it);
 *   - takes an optional `size` (px, default 15) + `className`.
 *
 * These are simple geometric paths authored in-repo (a stroked line-icon set in
 * the common 24×24 grid), not third-party art.
 */

interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

/** Download — arrow descending into an open tray/bracket. */
export const DownloadIcon: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    {/* arrow shaft + head */}
    <path d="M12 3v11" />
    <path d="M8 10l4 4 4-4" />
    {/* open tray */}
    <path d="M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
  </svg>
);

/** Import — mirror of download: arrow ascending OUT of the tray. */
export const ImportIcon: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    {/* arrow shaft + head pointing up */}
    <path d="M12 15V4" />
    <path d="M8 8l4-4 4 4" />
    {/* open tray */}
    <path d="M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
  </svg>
);

/** Copy — two overlapping sheets. */
export const CopyIcon: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h8" />
  </svg>
);

/** External link — a box with an arrow leaving its top-right corner (↗). */
export const ExternalLinkIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-8 8" />
    <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
  </svg>
);
