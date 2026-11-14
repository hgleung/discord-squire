import type { ExerciseColor } from '../../../lib/types';

interface ColorDef {
  base: string; // strong hex for dots / borders
  tint: string; // light hex for backgrounds
  text: string; // hex for text on tint
}

export const COLOR_MAP: Record<ExerciseColor, ColorDef> = {
  green: { base: '#22c55e', tint: '#eafcef', text: '#15803d' },
  yellow: { base: '#eab308', tint: '#fdf8e5', text: '#92650a' },
  blue: { base: '#3b82f6', tint: '#eaf1ff', text: '#1d4ed8' },
  orange: { base: '#f97316', tint: '#fff1e6', text: '#c2410c' },
  purple: { base: '#a855f7', tint: '#f6edff', text: '#7e22ce' },
  pink: { base: '#ec4899', tint: '#fef0f7', text: '#be185d' },
  teal: { base: '#14b8a6', tint: '#e7fbf8', text: '#0f766e' },
  red: { base: '#ef4444', tint: '#fef1f1', text: '#b91c1c' },
};

export function accentStyle(color: ExerciseColor): React.CSSProperties {
  return { borderLeftColor: COLOR_MAP[color].base };
}

export function tintStyle(color: ExerciseColor): React.CSSProperties {
  const c = COLOR_MAP[color];
  return { backgroundColor: c.tint, color: c.text };
}

export function dotColor(color: ExerciseColor): React.CSSProperties {
  return { backgroundColor: COLOR_MAP[color].base };
}
