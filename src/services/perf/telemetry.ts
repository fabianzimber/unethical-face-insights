export interface PerfSnapshot {
  overlayFps: number;
  fastRttP50: number;
  depthRttP50: number;
  droppedFrameRatio: number;
}

export interface PerfAcceptance {
  overlayFpsMin: number;
  fastRttP50Max: number;
  depthRttP50Max: number;
  droppedFrameRatioMax: number;
}

export interface PerfAcceptanceResult {
  snapshot: PerfSnapshot;
  acceptance: PerfAcceptance;
  passes: {
    overlayFps: boolean;
    fastRtt: boolean;
    depthRtt: boolean;
    droppedFrames: boolean;
  };
}

const DEFAULT_ACCEPTANCE: PerfAcceptance = {
  overlayFpsMin: 24,
  fastRttP50Max: 550,
  depthRttP50Max: 3200,
  droppedFrameRatioMax: 0.18,
};

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function trimWindow(values: number[], value: number, max = 240): number[] {
  const next = [...values, value];
  if (next.length > max) next.shift();
  return next;
}

export class PerfTelemetry {
  private overlayFpsValues: number[] = [];
  private fastRttValues: number[] = [];
  private depthRttValues: number[] = [];
  private renderedFrames = 0;
  private droppedFrames = 0;

  reportOverlayFps(fps: number): void {
    if (Number.isFinite(fps) && fps > 0) {
      this.overlayFpsValues = trimWindow(this.overlayFpsValues, fps, 120);
    }
  }

  reportFrameTime(frameTimeMs: number): void {
    if (!Number.isFinite(frameTimeMs) || frameTimeMs <= 0) return;
    this.renderedFrames += 1;
    if (frameTimeMs > 34) {
      this.droppedFrames += 1;
    }
  }

  reportFastRtt(rttMs: number): void {
    if (Number.isFinite(rttMs) && rttMs > 0) {
      this.fastRttValues = trimWindow(this.fastRttValues, rttMs);
    }
  }

  reportDepthRtt(rttMs: number): void {
    if (Number.isFinite(rttMs) && rttMs > 0) {
      this.depthRttValues = trimWindow(this.depthRttValues, rttMs, 120);
    }
  }

  snapshot(): PerfSnapshot {
    return {
      overlayFps: percentile(this.overlayFpsValues, 0.5),
      fastRttP50: percentile(this.fastRttValues, 0.5),
      depthRttP50: percentile(this.depthRttValues, 0.5),
      droppedFrameRatio: this.renderedFrames === 0 ? 0 : this.droppedFrames / this.renderedFrames,
    };
  }

  evaluate(acceptance: PerfAcceptance = DEFAULT_ACCEPTANCE): PerfAcceptanceResult {
    const snapshot = this.snapshot();
    return {
      snapshot,
      acceptance,
      passes: {
        overlayFps: snapshot.overlayFps >= acceptance.overlayFpsMin,
        fastRtt: snapshot.fastRttP50 <= acceptance.fastRttP50Max,
        depthRtt: snapshot.depthRttP50 <= acceptance.depthRttP50Max,
        droppedFrames: snapshot.droppedFrameRatio <= acceptance.droppedFrameRatioMax,
      },
    };
  }
}
