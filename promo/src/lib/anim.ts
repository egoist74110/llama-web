import {interpolate, random, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {SPRING, SpringPreset} from '../theme';

// Clamped linear interpolation between two frames. The default for fades and progress.
export const ramp = (frame: number, from: number, to: number, out: [number, number] = [0, 1]): number =>
  interpolate(frame, [from, to], out, {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Spring progress (0 -> 1, may overshoot for `pop`) starting at `delay` frames.
export const springAt = (frame: number, fps: number, delay: number, preset: SpringPreset = 'snappy'): number =>
  spring({frame: frame - delay, fps, config: SPRING[preset]});

// Hook form of `springAt` for the current frame.
export const useSpringAt = (delay: number, preset: SpringPreset = 'snappy'): number => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return springAt(frame, fps, delay, preset);
};

// Deterministic flicker: a value that changes every `period` frames, in [min, 1].
// Uses Remotion's seeded `random`, never Math.random.
export const flicker = (seed: string | number, frame: number, period = 3, min = 0.25): number => {
  const bucket = Math.floor(frame / period);
  return min + (1 - min) * random(`${seed}-${bucket}`);
};

// Deterministic value in [0, 1) for a seed. Use for static per-item variation.
export const seeded = (seed: string | number): number => random(`s-${seed}`);

// Caret blink: visible for 15 frames, hidden for 15.
export const caretOn = (frame: number): boolean => Math.floor(frame / 15) % 2 === 0;

// Number of characters revealed by a typewriter that starts at `start`.
export const typedCount = (frame: number, start: number, length: number, framesPerChar = 2): number =>
  Math.max(0, Math.min(length, Math.floor((frame - start) / framesPerChar)));
