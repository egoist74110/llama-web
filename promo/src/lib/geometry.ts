import {cutPath, getLength, getPointAtLength} from '@remotion/paths';

export type Pt = {x: number; y: number};

export const pt = (x: number, y: number): Pt => ({x, y});

export const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});

// Horizontal S-curve from a to b (control points pulled sideways). Used for wires between columns.
export const hCurve = (a: Pt, b: Pt, bend = 0.5): string => {
  const dx = (b.x - a.x) * bend;
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};

// Cubic with explicit control points.
export const cubic = (a: Pt, c1: Pt, c2: Pt, b: Pt): string =>
  `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;

// Several points joined by horizontal S-curves, as one path. Good for packet routes.
export const route = (points: readonly Pt[], bend = 0.5): string => {
  if (points.length < 2) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = (b.x - a.x) * bend;
    d += ` C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  return d;
};

// Point at a fraction (0..1) of the path length.
export const pointAt = (d: string, t: number): Pt => {
  const len = getLength(d);
  const p = getPointAtLength(d, Math.max(0, Math.min(1, t)) * len);
  return p ? {x: p.x, y: p.y} : {x: 0, y: 0};
};

// The first `t` (0..1) of a path, for draw-on animations that still allow dashes.
export const trimPath = (d: string, t: number): string => {
  if (t >= 1) return d;
  if (t <= 0) return '';
  return cutPath(d, getLength(d) * t);
};

export type Box = {cx: number; cy: number; w: number; h: number};

export const leftEdge = (b: Box): Pt => ({x: b.cx - b.w / 2, y: b.cy});
export const rightEdge = (b: Box): Pt => ({x: b.cx + b.w / 2, y: b.cy});
