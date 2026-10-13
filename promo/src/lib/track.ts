import {springAt} from './anim';
import {lerp} from './anim';
import {SpringPreset} from '../theme';

// Keyframe tracks driven by springs. Each key starts a spring from wherever the previous keys left
// the value, so overlapping moves stay continuous. Keys must be sorted by `at` (local frames).

export type Key<T> = {at: number; v: T};

type Mixer<T> = (a: T, b: T, t: number) => T;

export const track = <T,>(frame: number, fps: number, keys: readonly Key<T>[], mix: Mixer<T>, preset: SpringPreset = 'snappy'): T => {
  let cur = keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (frame < keys[i].at) break;
    cur = mix(cur, keys[i].v, springAt(frame, fps, keys[i].at, preset));
  }
  return cur;
};

export type Pt2 = {x: number; y: number};
export const mixPt: Mixer<Pt2> = (a, b, t) => ({x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t)});

// Click feedback: 0 -> 1 -> 0 over `len` frames after each click frame.
export const pressAt = (frame: number, clicks: readonly number[], len = 8): number => {
  for (const c of clicks) {
    if (frame >= c && frame < c + len) {
      const t = (frame - c) / len;
      return t < 0.35 ? t / 0.35 : (1 - t) / 0.65;
    }
  }
  return 0;
};

// Ripple progress 0..1 for the cursor after the most recent click (0 when none active).
export const rippleAt = (frame: number, clicks: readonly number[], len = 14): number => {
  for (const c of clicks) if (frame >= c && frame < c + len) return Math.max(0.01, (frame - c) / len);
  return 0;
};
