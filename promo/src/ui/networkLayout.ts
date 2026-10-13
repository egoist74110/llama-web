import {CLIENTS, SERVICES} from '../copy';
import {CLIENT_SIZE, HUB_SIZE, SERVICE_SIZE} from '../components/Nodes';
import {seeded} from '../lib/anim';
import {Box, cubic, lerpPt, Pt} from '../lib/geometry';

// Shared geometry for the pain -> converge concepts (used in chapters 0 and 1).
// C0 ends in `CHAOS`; C1 pulls wires in and settles into `ORDER`.

export const CLIENT_BOXES: readonly Box[] = CLIENTS.map((_, i) => ({
  cx: 270,
  cy: 300 + i * 172,
  w: CLIENT_SIZE.w,
  h: CLIENT_SIZE.h,
}));

export const HUB_BOX: Box = {cx: 960, cy: 472, w: HUB_SIZE.w, h: HUB_SIZE.h};

// Scattered service cards for the pain chapter: center, rotation (deg).
export const CHAOS: readonly {cx: number; cy: number; rotate: number}[] = [
  {cx: 930, cy: 210, rotate: -4},
  {cx: 1400, cy: 170, rotate: 3},
  {cx: 1640, cy: 410, rotate: -2},
  {cx: 1010, cy: 500, rotate: 2.5},
  {cx: 1390, cy: 690, rotate: -3},
  {cx: 960, cy: 790, rotate: 3.5},
];

// Ordered right column for the brand chapter. Cards enlarged ~1.4x (ORDER_SCALE = 1.18).
export const ORDER_SCALE = 1.18;
const ORDER_STEP = 146;
export const ORDER: readonly {cx: number; cy: number; rotate: number}[] = SERVICES.map((_, i) => ({
  cx: 1620,
  cy: HUB_BOX.cy + (i - (SERVICES.length - 1) / 2) * ORDER_STEP,
  rotate: 0,
}));

// Wire anchors.
export const clientAnchor = (i: number): Pt => ({x: CLIENT_BOXES[i].cx + CLIENT_BOXES[i].w / 2, y: CLIENT_BOXES[i].cy});

// Left edge of a (possibly scaled) service card.
export const serviceAnchor = (cx: number, cy: number, scale = 1): Pt => ({x: cx - (SERVICE_SIZE.w / 2) * scale, y: cy});

// Which (client, service) pairs are wired in the tangled state: every client to every service.
export const TANGLE: readonly {client: number; service: number}[] = CLIENTS.flatMap((_, c) =>
  SERVICES.map((__, s) => ({client: c, service: s})),
);

// A deliberately messy wire between a client and a service. `pinch` (0..1) pulls both control
// points into `toward` (the hub), which is how chapter 1 "sucks" the mess in.
export const tangleWire = (index: number, a: Pt, b: Pt, pinch = 0, toward: Pt = {x: HUB_BOX.cx, y: HUB_BOX.cy}): string => {
  const r1 = seeded(`c1-${index}`);
  const r2 = seeded(`c2-${index}`);
  const r3 = seeded(`c3-${index}`);
  const c1 = {x: a.x + 160 + r1 * 360, y: a.y + (r2 - 0.5) * 620};
  const c2 = {x: b.x - 120 - r3 * 320, y: b.y + (r1 - 0.5) * 520};
  return cubic(a, lerpPt(c1, toward, pinch), lerpPt(c2, toward, pinch), b);
};
