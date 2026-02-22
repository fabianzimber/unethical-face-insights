import type { NormalizedPoint, SemanticAnchor } from "@/types/analysis";
import type { TrackedFaceFrame } from "@/services/tracking/mediapipeTracker";

interface AnchorBinding {
  anchor: SemanticAnchor;
  landmarkIndex?: number;
  offset?: NormalizedPoint;
  lastSeenAt: number;
}

export interface FusedAnchor extends SemanticAnchor {
  projectedPoint: NormalizedPoint;
  stale: boolean;
}

interface AnchorFusionOptions {
  maxStaleMs?: number;
  hardMaxStaleMs?: number;
  reacquireDistance?: number;
}

interface ProjectOptions {
  preserveStale?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function squaredDistance(a: NormalizedPoint, b: NormalizedPoint): number {
  const dy = a[0] - b[0];
  const dx = a[1] - b[1];
  return dy * dy + dx * dx;
}

function addOffset(point: NormalizedPoint, offset: NormalizedPoint): NormalizedPoint {
  return [clamp(point[0] + offset[0], 0, 1000), clamp(point[1] + offset[1], 0, 1000)];
}

function subtractPoint(a: NormalizedPoint, b: NormalizedPoint): NormalizedPoint {
  return [a[0] - b[0], a[1] - b[1]];
}

function nearestLandmarkIndex(frame: TrackedFaceFrame, target: NormalizedPoint): number | undefined {
  if (!frame.points.length) return undefined;
  let nearest: number | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const point of frame.points) {
    const distance = squaredDistance(point.point, target);
    if (distance < best) {
      best = distance;
      nearest = point.index;
    }
  }
  return nearest;
}

export class AnchorFusionEngine {
  private bindings = new Map<string, AnchorBinding>();
  private maxStaleMs: number;
  private hardMaxStaleMs: number;
  private reacquireDistanceSq: number;

  constructor(options: AnchorFusionOptions = {}) {
    this.maxStaleMs = options.maxStaleMs ?? 4500;
    this.hardMaxStaleMs = Math.max(this.maxStaleMs, options.hardMaxStaleMs ?? 30_000);
    const reacquireDistance = options.reacquireDistance ?? 130;
    this.reacquireDistanceSq = reacquireDistance * reacquireDistance;
  }

  updateAnchors(nextAnchors: SemanticAnchor[], frame: TrackedFaceFrame | null, nowMs = Date.now()): void {
    const incomingIds = new Set(nextAnchors.map((anchor) => anchor.id));
    for (const [id, binding] of this.bindings.entries()) {
      if (!incomingIds.has(id) && nowMs - binding.lastSeenAt > this.maxStaleMs) {
        this.bindings.delete(id);
      }
    }

    for (const anchor of nextAnchors) {
      const previous = this.bindings.get(anchor.id);
      const target = frame ? this.resolveTargetPoint(anchor, frame) : anchor.point;
      const isKnownPart = Boolean(frame && anchor.facialPart !== "unknown" && frame.parts[anchor.facialPart]);
      const shouldUsePrevious =
        previous &&
        frame &&
        previous.landmarkIndex !== undefined &&
        frame.points[previous.landmarkIndex] &&
        squaredDistance(anchor.point, frame.points[previous.landmarkIndex].point) < this.reacquireDistanceSq;

      let landmarkIndex: number | undefined = previous?.landmarkIndex;
      if (!isKnownPart && !shouldUsePrevious && frame) {
        landmarkIndex = nearestLandmarkIndex(frame, target);
      }
      if (isKnownPart) landmarkIndex = undefined;

      const trackedPoint =
        frame && landmarkIndex !== undefined ? frame.points[landmarkIndex]?.point ?? anchor.point : target;

      // If we matched a specific facial part requested by the LLM, use its point strictly (zero offset).
      // Otherwise, keep the relative offset for 'unknown' or custom points.
      const offset = isKnownPart ? ([0, 0] as NormalizedPoint) : subtractPoint(anchor.point, trackedPoint);

      this.bindings.set(anchor.id, {
        anchor,
        landmarkIndex,
        offset,
        lastSeenAt: nowMs,
      });
    }
  }

  project(frame: TrackedFaceFrame | null, nowMs = Date.now(), options: ProjectOptions = {}): FusedAnchor[] {
    const projected: FusedAnchor[] = [];
    const maxAgeMs = options.preserveStale ? this.hardMaxStaleMs : this.maxStaleMs;

    for (const [id, binding] of this.bindings.entries()) {
      const age = nowMs - binding.lastSeenAt;
      if (age > maxAgeMs) {
        this.bindings.delete(id);
        continue;
      }

      let projectedPoint = binding.anchor.point;
      if (frame && binding.anchor.facialPart !== "unknown" && frame.parts[binding.anchor.facialPart]) {
        projectedPoint = frame.parts[binding.anchor.facialPart] as NormalizedPoint;
      } else if (
        frame &&
        binding.landmarkIndex !== undefined &&
        binding.offset &&
        frame.points[binding.landmarkIndex]
      ) {
        projectedPoint = addOffset(frame.points[binding.landmarkIndex].point, binding.offset);
      } else if (frame) {
        const fallbackIndex = nearestLandmarkIndex(frame, binding.anchor.point);
        if (fallbackIndex !== undefined) {
          projectedPoint = frame.points[fallbackIndex].point;
        }
      }

      projected.push({
        ...binding.anchor,
        projectedPoint,
        stale: age > this.maxStaleMs * 0.5,
      });
    }

    projected.sort((a, b) => b.confidence - a.confidence);
    return projected;
  }

  private resolveTargetPoint(anchor: SemanticAnchor, frame: TrackedFaceFrame): NormalizedPoint {
    if (anchor.facialPart !== "unknown" && frame.parts[anchor.facialPart]) {
      return frame.parts[anchor.facialPart] as NormalizedPoint;
    }
    return anchor.point;
  }
}
