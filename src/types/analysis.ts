export type NormalizedPoint = [number, number]; // [y, x] in 0-1000 space
export type NormalizedFaceBox = [number, number, number, number]; // [ymin, xmin, ymax, xmax]

export type AnchorKind = "emotion" | "depth" | "landmark";

export type FacialPartHint =
  | "leftEye"
  | "rightEye"
  | "leftEyeInner"
  | "rightEyeInner"
  | "nose"
  | "leftNoseHole"
  | "rightNoseHole"
  | "mouth"
  | "mouthLeft"
  | "mouthRight"
  | "mouthUpper"
  | "mouthLower"
  | "leftBrow"
  | "rightBrow"
  | "leftBrowInner"
  | "rightBrowInner"
  | "chin"
  | "forehead"
  | "leftCheek"
  | "rightCheek"
  | "faceCenter"
  | "unknown";

export interface HeadPose {
  pitch: number;
  yaw: number;
  roll: number;
}

export interface EmotionCandidate {
  emotion: string;
  confidence: number;
}

export interface LiteAnalysisResult {
  model: string;
  frameId: number;
  capturedAt: number;
  faceDetected: boolean;
  confidence: number;
  primaryEmotion: string;
  primaryConfidence: number;
  moodSentence?: string;
  candidates: EmotionCandidate[];
  faceBox?: NormalizedFaceBox;
  headPose?: HeadPose;
}

export interface FastEmotion {
  emotion: string;
  intensity: string;
  confidence: number;
  point: NormalizedPoint;
  facialPart: FacialPartHint;
  /** Short explanation sentence why this emotion is visible. */
  explanation?: string;
}

export interface FastLandmark {
  name: string;
  point: NormalizedPoint;
  confidence: number;
  facialPart: FacialPartHint;
}

export interface SemanticAnchor {
  id: string;
  label: string;
  kind: AnchorKind;
  facialPart: FacialPartHint;
  point: NormalizedPoint;
  confidence: number;
  intensity?: string;
  /** For emotion anchors: short explanation sentence. */
  explanation?: string;
}

export interface FastAnalysisResult {
  model: string;
  frameId: number;
  capturedAt: number;
  faceDetected: boolean;
  confidence: number;
  faceBox?: NormalizedFaceBox;
  headPose?: HeadPose;
  emotions: FastEmotion[];
  landmarks: FastLandmark[];
  semanticAnchors: SemanticAnchor[];
}

export interface DepthInsight {
  keyword: string;
  rationale: string;
  medicalInterpretation?: string;
  confidence: number;
  facialPart: FacialPartHint;
  point: NormalizedPoint;
}

export interface DepthAnalysisResult {
  model: string;
  frameId: number;
  capturedAt: number;
  confidence: number;
  summary: string;
  insights: DepthInsight[];
  semanticAnchors: SemanticAnchor[];
}

export interface LegacyAnalysisResult {
  faceBox?: number[];
  headPose?: { pitch: number; yaw: number; roll: number };
  primaryEmotion?: { emotion: string; confidence: number };
  emotions?: { emotion: string; intensity: string; point: number[] }[];
  landmarks?: { name: string; point: number[] }[];
  insights?: { keyword: string; point: number[] }[];
}
