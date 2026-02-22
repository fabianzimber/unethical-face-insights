import type { NormalizedPoint } from "@/types/analysis";

interface SmoothingState {
  point: NormalizedPoint;
  lastUpdatedAt: number;
}

interface PointSmootherOptions {
  attackMs?: number;
  releaseMs?: number;
  maxStateAgeMs?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function interpolate(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

export class PointSmoother {
  private states = new Map<string, SmoothingState>();
  private attackMs: number;
  private releaseMs: number;
  private maxStateAgeMs: number;

  constructor(options: PointSmootherOptions = {}) {
    this.attackMs = options.attackMs ?? 65;
    this.releaseMs = options.releaseMs ?? 130;
    this.maxStateAgeMs = options.maxStateAgeMs ?? 6000;
  }

  smooth(id: string, nextPoint: NormalizedPoint, nowMs: number): NormalizedPoint {
    const existing = this.states.get(id);
    if (!existing) {
      this.states.set(id, { point: nextPoint, lastUpdatedAt: nowMs });
      return nextPoint;
    }

    const dt = Math.max(1, nowMs - existing.lastUpdatedAt);
    const dy = nextPoint[0] - existing.point[0];
    const dx = nextPoint[1] - existing.point[1];
    const movement = Math.sqrt(dy * dy + dx * dx);
    const tau = movement > 26 ? this.attackMs : this.releaseMs;
    const alpha = clamp(1 - Math.exp(-dt / tau), 0.1, 0.95);

    const smoothed: NormalizedPoint = [
      clamp(Math.round(interpolate(existing.point[0], nextPoint[0], alpha)), 0, 1000),
      clamp(Math.round(interpolate(existing.point[1], nextPoint[1], alpha)), 0, 1000),
    ];

    this.states.set(id, { point: smoothed, lastUpdatedAt: nowMs });
    return smoothed;
  }

  prune(nowMs: number): void {
    for (const [id, state] of this.states.entries()) {
      if (nowMs - state.lastUpdatedAt > this.maxStateAgeMs) {
        this.states.delete(id);
      }
    }
  }
}
