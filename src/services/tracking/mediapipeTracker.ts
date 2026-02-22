import type { FacialPartHint, NormalizedFaceBox, NormalizedPoint } from "@/types/analysis";

type FaceLandmarkerType = {
  detectForVideo: (video: HTMLVideoElement, timestampMs: number) => {
    faceLandmarks?: Array<Array<{ x: number; y: number; z?: number }>>;
  };
  close: () => void;
};

const FACE_MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const FACIAL_PART_INDICES: Record<Exclude<FacialPartHint, "unknown">, number[]> = {
  leftEye: [33],
  rightEye: [263],
  leftEyeInner: [133],
  rightEyeInner: [362],
  leftBrow: [70],
  rightBrow: [300],
  leftBrowInner: [52],
  rightBrowInner: [282],
  nose: [1],
  leftNoseHole: [44],
  rightNoseHole: [274],
  mouth: [13],
  mouthLeft: [61],
  mouthRight: [291],
  mouthUpper: [0],
  mouthLower: [17],
  chin: [152],
  forehead: [10],
  leftCheek: [234],
  rightCheek: [454],
  faceCenter: [1],
};

/** All landmark indices used for overlay dots (eyes, brows, nose, mouth, chin, forehead). */
export const DISPLAY_LANDMARK_INDICES = new Set<number>(
  Object.values(FACIAL_PART_INDICES).flat(),
);

export interface TrackedLandmark {
  index: number;
  point: NormalizedPoint;
}

export interface TrackedFaceFrame {
  timestampMs: number;
  points: TrackedLandmark[];
  parts: Partial<Record<FacialPartHint, NormalizedPoint>>;
  faceBox?: NormalizedFaceBox;
  confidence: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toNormalizedPoint(x: number, y: number): NormalizedPoint {
  return [clamp(Math.round(y * 1000), 0, 1000), clamp(Math.round(x * 1000), 0, 1000)];
}

function pointFromLandmarkSet(
  landmarks: Array<{ x: number; y: number }>,
  indices: number[],
): NormalizedPoint | undefined {
  const candidates = indices.map((index) => landmarks[index]).filter(Boolean);
  if (!candidates.length) return undefined;

  const avgX = candidates.reduce((sum, item) => sum + item.x, 0) / candidates.length;
  const avgY = candidates.reduce((sum, item) => sum + item.y, 0) / candidates.length;
  return toNormalizedPoint(avgX, avgY);
}

function computeFaceBox(points: TrackedLandmark[]): NormalizedFaceBox | undefined {
  if (!points.length) return undefined;
  let minY = 1000;
  let minX = 1000;
  let maxY = 0;
  let maxX = 0;
  for (const point of points) {
    if (point.point[0] < minY) minY = point.point[0];
    if (point.point[1] < minX) minX = point.point[1];
    if (point.point[0] > maxY) maxY = point.point[0];
    if (point.point[1] > maxX) maxX = point.point[1];
  }
  if (maxY <= minY || maxX <= minX) return undefined;
  return [minY, minX, maxY, maxX];
}

export class MediaPipeTracker {
  private landmarker: FaceLandmarkerType | null = null;
  private isReady = false;

  get ready(): boolean {
    return this.isReady;
  }

  async init(): Promise<void> {
    if (this.landmarker) return;
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
    );
    this.landmarker = (await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: FACE_MODEL_PATH,
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    })) as FaceLandmarkerType;
    this.isReady = true;
  }

  track(video: HTMLVideoElement, timestampMs: number): TrackedFaceFrame | null {
    if (!this.landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    const result = this.landmarker.detectForVideo(video, timestampMs);
    const primaryFace = result.faceLandmarks?.[0];
    if (!primaryFace?.length) return null;

    const points: TrackedLandmark[] = primaryFace.map((landmark, index) => ({
      index,
      point: toNormalizedPoint(landmark.x, landmark.y),
    }));

    const parts: Partial<Record<FacialPartHint, NormalizedPoint>> = {};
    for (const [part, indices] of Object.entries(FACIAL_PART_INDICES)) {
      const partPoint = pointFromLandmarkSet(primaryFace, indices);
      if (partPoint) {
        parts[part as FacialPartHint] = partPoint;
      }
    }

    return {
      timestampMs,
      points,
      parts,
      faceBox: computeFaceBox(points),
      confidence: 1,
    };
  }

  dispose(): void {
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
    this.isReady = false;
  }
}
