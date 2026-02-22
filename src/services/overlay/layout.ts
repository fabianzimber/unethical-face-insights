export interface LabelLayoutInput {
  id: string;
  text: string;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  priority: number;
  /** If true (e.g. for emotions), labels are placed further from anchor. */
  preferDistance?: boolean;
}

export interface LabelLayoutOutput extends LabelLayoutInput {
  x: number;
  y: number;
}

interface Bounds {
  width: number;
  height: number;
  padding?: number;
  faceCenterX?: number;
  faceCenterY?: number;
}

const OFFSETS: Array<[number, number]> = [
  [14, -18],
  [16, 16],
  [-16, -18],
  [-16, 18],
  [24, 0],
  [-24, 0],
  [0, -24],
  [0, 24],
];

/** Emotion cards: further from face, spread to avoid stacking (prefer right, then left, then above/below). */
const EMOTION_OFFSETS: Array<[number, number]> = [
  [112, -88],
  [118, -42],
  [124, 10],
  [114, 62],
  [98, 102],
  [70, 122],
  [30, 134],
  [-30, 134],
  [-70, 122],
  [-98, 102],
  [-114, 62],
  [-124, 10],
  [-118, -42],
  [-112, -88],
  [-94, -118],
  [-56, -136],
  [0, -144],
  [56, -136],
  [94, -118],
  [132, -4],
  [132, 52],
  [132, -56],
  [-132, -4],
  [-132, 52],
  [-132, -56],
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function intersects(a: LabelLayoutOutput, b: LabelLayoutOutput): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function intersectsWithGap(a: LabelLayoutOutput, b: LabelLayoutOutput, gap: number): boolean {
  return (
    a.x - gap < b.x + b.width + gap &&
    a.x + a.width + gap > b.x - gap &&
    a.y - gap < b.y + b.height + gap &&
    a.y + a.height + gap > b.y - gap
  );
}

function keepInBounds(layout: LabelLayoutOutput, bounds: Bounds): LabelLayoutOutput {
  const padding = bounds.padding ?? 8;
  return {
    ...layout,
    x: clamp(layout.x, padding, bounds.width - layout.width - padding),
    y: clamp(layout.y, padding, bounds.height - layout.height - padding),
  };
}

function getOutwardDirection(
  anchorX: number,
  anchorY: number,
  bounds: Bounds,
): { x: number; y: number } | null {
  if (bounds.faceCenterX === undefined || bounds.faceCenterY === undefined) return null;
  const outwardX = anchorX - bounds.faceCenterX;
  const outwardY = anchorY - bounds.faceCenterY;
  const length = Math.hypot(outwardX, outwardY) || 0;
  if (length < 0.001) return null;
  return { x: outwardX / length, y: outwardY / length };
}

function isPlacementOutward(
  anchorX: number,
  anchorY: number,
  layout: LabelLayoutOutput,
  outwardDirection: { x: number; y: number },
): boolean {
  const centerX = layout.x + layout.width / 2;
  const centerY = layout.y + layout.height / 2;
  const vectorX = centerX - anchorX;
  const vectorY = centerY - anchorY;
  return vectorX * outwardDirection.x + vectorY * outwardDirection.y > 0;
}

function hashText(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function rotateOffsets(offsets: Array<[number, number]>, start: number): Array<[number, number]> {
  if (offsets.length === 0) return offsets;
  const normalized = start % offsets.length;
  return offsets.slice(normalized).concat(offsets.slice(0, normalized));
}

function prioritizeOutwardOffsets(
  offsets: Array<[number, number]>,
  anchorX: number,
  anchorY: number,
  bounds: Bounds,
): Array<[number, number]> {
  const outward = getOutwardDirection(anchorX, anchorY, bounds);
  if (!outward) return offsets;

  return [...offsets].sort((a, b) => {
    const aLen = Math.hypot(a[0], a[1]) || 1;
    const bLen = Math.hypot(b[0], b[1]) || 1;
    const aScore = (a[0] / aLen) * outward.x + (a[1] / aLen) * outward.y;
    const bScore = (b[0] / bLen) * outward.x + (b[1] / bLen) * outward.y;

    if (Math.abs(bScore - aScore) > 0.0001) return bScore - aScore;
    return bLen - aLen;
  });
}

export function layoutLabels(
  inputs: LabelLayoutInput[],
  bounds: Bounds,
  maxLabels: number,
): LabelLayoutOutput[] {
  const sorted = [...inputs]
    .sort((a, b) => {
      const diff = b.priority - a.priority;
      // Avoid rapid order swaps when confidence is almost identical.
      if (Math.abs(diff) > 0.03) return diff;
      return hashText(a.id) - hashText(b.id);
    })
    .slice(0, maxLabels);
  const placed: LabelLayoutOutput[] = [];

  for (const input of sorted) {
    let candidate: LabelLayoutOutput | null = null;
    const offsets = input.preferDistance
      ? prioritizeOutwardOffsets(
          rotateOffsets(EMOTION_OFFSETS, hashText(input.id)),
          input.anchorX,
          input.anchorY,
          bounds,
        )
      : OFFSETS;
    const outwardDirection = input.preferDistance
      ? getOutwardDirection(input.anchorX, input.anchorY, bounds)
      : null;

    for (const [offsetX, offsetY] of offsets) {
      const attempt = keepInBounds(
        {
          ...input,
          x: input.anchorX + offsetX,
          y: input.anchorY + offsetY,
        },
        bounds,
      );
      if (
        outwardDirection &&
        !isPlacementOutward(input.anchorX, input.anchorY, attempt, outwardDirection)
      ) {
        continue;
      }
      const collisionGap = input.preferDistance ? 10 : 0;
      const hasCollision = placed.some((existing) =>
        collisionGap > 0 ? intersectsWithGap(existing, attempt, collisionGap) : intersects(existing, attempt),
      );
      if (!hasCollision) {
        candidate = attempt;
        break;
      }
    }

    if (!candidate && outwardDirection) {
      for (const [offsetX, offsetY] of offsets) {
        const attempt = keepInBounds(
          {
            ...input,
            x: input.anchorX + offsetX,
            y: input.anchorY + offsetY,
          },
          bounds,
        );
        const hasCollision = placed.some((existing) => intersectsWithGap(existing, attempt, 6));
        if (!hasCollision) {
          candidate = attempt;
          break;
        }
      }
    }

    if (!candidate) {
      if (input.preferDistance && outwardDirection) {
        const radialDistance = 118;
        candidate = keepInBounds(
          {
            ...input,
            x: input.anchorX + outwardDirection.x * radialDistance - input.width / 2,
            y: input.anchorY + outwardDirection.y * radialDistance - input.height / 2,
          },
          bounds,
        );
      } else {
        const fallback = input.preferDistance ? [52, 0] : [14, 14];
        candidate = keepInBounds(
          {
            ...input,
            x: input.anchorX + fallback[0],
            y: input.anchorY + fallback[1],
          },
          bounds,
        );
      }
    }

    placed.push(candidate);
  }

  return placed;
}
