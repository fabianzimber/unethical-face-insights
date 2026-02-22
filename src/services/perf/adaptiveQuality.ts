export type QualityTier = "high" | "balanced" | "low";

export interface QualityProfile {
  tier: QualityTier;
  maxCaptureSide: number;
  jpegQuality: number;
  fastIntervalMs: number;
  depthIntervalMs: number;
  maxVisibleTags: number;
}

export interface QualityTelemetry {
  fastRttMs: number;
  depthRttMs: number;
  frameTimeMs: number;
  tier: QualityTier;
}

const TIERS: Record<QualityTier, Omit<QualityProfile, "tier">> = {
  high: {
    maxCaptureSide: 800,
    jpegQuality: 0.78,
    fastIntervalMs: 500,
    depthIntervalMs: 30000,
    maxVisibleTags: 12,
  },
  balanced: {
    maxCaptureSide: 640,
    jpegQuality: 0.72,
    fastIntervalMs: 3500,
    depthIntervalMs: 35000,
    maxVisibleTags: 8,
  },
  low: {
    maxCaptureSide: 480,
    jpegQuality: 0.65,
    fastIntervalMs: 4500,
    depthIntervalMs: 45000,
    maxVisibleTags: 4,
  },
};

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function appendWindow(list: number[], value: number, max = 24): number[] {
  const next = [...list, value];
  if (next.length > max) next.shift();
  return next;
}

export class AdaptiveQualityManager {
  private fastRtts: number[] = [];
  private depthRtts: number[] = [];
  private frameTimes: number[] = [];
  private tier: QualityTier = "high";

  reportFastRtt(rttMs: number): void {
    if (Number.isFinite(rttMs) && rttMs > 0) {
      this.fastRtts = appendWindow(this.fastRtts, rttMs);
      this.recomputeTier();
    }
  }

  reportDepthRtt(rttMs: number): void {
    if (Number.isFinite(rttMs) && rttMs > 0) {
      this.depthRtts = appendWindow(this.depthRtts, rttMs);
      this.recomputeTier();
    }
  }

  reportFrameTime(frameTimeMs: number): void {
    if (Number.isFinite(frameTimeMs) && frameTimeMs > 0) {
      this.frameTimes = appendWindow(this.frameTimes, frameTimeMs, 60);
      this.recomputeTier();
    }
  }

  getProfile(): QualityProfile {
    return {
      tier: this.tier,
      ...TIERS[this.tier],
    };
  }

  getTelemetry(): QualityTelemetry {
    return {
      fastRttMs: average(this.fastRtts),
      depthRttMs: average(this.depthRtts),
      frameTimeMs: average(this.frameTimes),
      tier: this.tier,
    };
  }

  private recomputeTier(): void {
    const avgFast = average(this.fastRtts);
    const avgDepth = average(this.depthRtts);
    const avgFrame = average(this.frameTimes);

    if (avgFast > 900 || avgDepth > 3500 || avgFrame > 26) {
      this.tier = "low";
      return;
    }
    if (avgFast > 520 || avgDepth > 2100 || avgFrame > 19) {
      this.tier = "balanced";
      return;
    }
    this.tier = "high";
  }
}
