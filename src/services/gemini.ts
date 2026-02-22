import { GoogleGenAI, Type } from "@google/genai";
import type {
  DepthAnalysisResult,
  FacialPartHint,
  FastAnalysisResult,
  FastLandmark,
  LegacyAnalysisResult,
  LiteAnalysisResult,
  NormalizedFaceBox,
  NormalizedPoint,
  SemanticAnchor,
} from "@/types/analysis";

const LITE_MODEL = "gemini-2.5-flash-lite";
const FLASH_MODEL = "gemini-3-flash-preview";
const PRO_MODEL = "gemini-3.1-pro-preview";

const LITE_FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-3-flash-preview"];
const FLASH_FALLBACK_MODELS = ["gemini-3-flash-preview"];
const PRO_FALLBACK_MODELS = ["gemini-3.1-pro-preview"];

const LITE_TIMEOUT_MS = 6_500;
const FLASH_TIMEOUT_MS = 9_000;
const PRO_TIMEOUT_MS = 120_000;
const PRIMARY_EMOTION_MAX_CHARS = 64;

const LITE_COOLDOWN_MS = 450;
const FLASH_COOLDOWN_MS = 3_200;
const PRO_COOLDOWN_MS = 45_000;
const GATE_POLL_MS = 24;
const GATE_MAX_WAIT_MS = 16_000;

type LaneName = "lite" | "flash" | "pro";

interface GenerationConfigLike {
  responseMimeType: string;
  responseSchema: unknown;
  candidateCount?: number;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  thinkingConfig?: {
    thinkingBudget?: number;
  };
}

interface AnalyzeOptions {
  frameId?: number;
  capturedAt?: number;
  timeoutMs?: number;
  videoClipBase64?: string;
  videoMimeType?: string;
  videoDurationMs?: number;
}

interface ModelGate {
  inFlight: boolean;
  lastCompletedAt: number;
}

const gates: Record<string, ModelGate> = {};
const resolvedLaneModels: Partial<Record<LaneName, string>> = {};

let aiClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (aiClient) return aiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  aiClient = new GoogleGenAI({ apiKey });
  return aiClient;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  }) as Promise<T>;
}

function cooldownForModel(model: string): number {
  if (/flash-lite/i.test(model)) return LITE_COOLDOWN_MS;
  if (/pro/i.test(model)) return PRO_COOLDOWN_MS;
  if (/flash/i.test(model)) return FLASH_COOLDOWN_MS;
  return FLASH_COOLDOWN_MS;
}

function getGate(model: string): ModelGate {
  if (!gates[model]) {
    gates[model] = { inFlight: false, lastCompletedAt: 0 };
  }
  return gates[model];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireGate(model: string): Promise<void> {
  const gate = getGate(model);
  const cooldown = cooldownForModel(model);
  const startedAt = Date.now();

  while (true) {
    if (!gate.inFlight) {
      const elapsed = Date.now() - gate.lastCompletedAt;
      if (elapsed >= cooldown) {
        gate.inFlight = true;
        return;
      }
      const waitMs = Math.min(Math.max(cooldown - elapsed, GATE_POLL_MS), 400);
      await sleep(waitMs);
      continue;
    }

    if (Date.now() - startedAt > GATE_MAX_WAIT_MS) {
      throw new Error(`Model ${model} gate wait timed out`);
    }
    await sleep(GATE_POLL_MS);
  }
}

function releaseGate(model: string): void {
  const gate = getGate(model);
  gate.inFlight = false;
  gate.lastCompletedAt = Date.now();
}

function logApiError(label: string, error: unknown, context?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const parts: string[] = [`[${ts}] ${label} failed`];
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (e.status !== undefined) parts.push(`status=${String(e.status)}`);
    if (e.code !== undefined) parts.push(`code=${String(e.code)}`);
    if (typeof e.message === "string") parts.push(`message=${e.message}`);
  }
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      parts.push(`${key}=${String(value)}`);
    }
  }
  console.error(parts.join(" | "));
}

function computeTimeoutMs(
  explicitTimeoutMs: number | undefined,
  baseTimeoutMs: number,
  base64Image: string,
  capTimeoutMs: number,
): number {
  if (Number.isFinite(explicitTimeoutMs) && (explicitTimeoutMs as number) > 0) {
    return Math.round(explicitTimeoutMs as number);
  }

  const approxBytes = Math.round((base64Image.length * 3) / 4);
  if (approxBytes > 380_000) {
    return Math.min(baseTimeoutMs + 2400, capTimeoutMs);
  }
  if (approxBytes > 240_000) {
    return Math.min(baseTimeoutMs + 1200, capTimeoutMs);
  }
  return baseTimeoutMs;
}

function safeJsonParse(value: string | undefined | null): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toConfidence(value: unknown, fallback = 0): number {
  if (isNumber(value)) return clamp(value, 0, 1);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return clamp(parsed, 0, 1);
  }
  return fallback;
}

function toPoint(value: unknown, fallback: NormalizedPoint = [500, 500]): NormalizedPoint {
  if (!Array.isArray(value) || value.length < 2) return fallback;
  const y = isNumber(value[0]) ? clamp(Math.round(value[0]), 0, 1000) : fallback[0];
  const x = isNumber(value[1]) ? clamp(Math.round(value[1]), 0, 1000) : fallback[1];
  return [y, x];
}

function toFaceBox(value: unknown): NormalizedFaceBox | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const ymin = isNumber(value[0]) ? clamp(Math.round(value[0]), 0, 1000) : 0;
  const xmin = isNumber(value[1]) ? clamp(Math.round(value[1]), 0, 1000) : 0;
  const ymax = isNumber(value[2]) ? clamp(Math.round(value[2]), 0, 1000) : 1000;
  const xmax = isNumber(value[3]) ? clamp(Math.round(value[3]), 0, 1000) : 1000;
  if (ymax <= ymin || xmax <= xmin) return undefined;
  return [ymin, xmin, ymax, xmax];
}

function toStringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function toFacialPart(value: unknown): FacialPartHint {
  const normalized = typeof value === "string" ? value.trim() : "";
  switch (normalized) {
    case "leftEye":
    case "rightEye":
    case "leftEyeInner":
    case "rightEyeInner":
    case "nose":
    case "leftNoseHole":
    case "rightNoseHole":
    case "mouth":
    case "mouthLeft":
    case "mouthRight":
    case "mouthUpper":
    case "mouthLower":
    case "leftBrow":
    case "rightBrow":
    case "leftBrowInner":
    case "rightBrowInner":
    case "chin":
    case "forehead":
    case "leftCheek":
    case "rightCheek":
    case "faceCenter":
      return normalized;
    default:
      return "unknown";
  }
}

const FACIAL_PART_DEFAULT_POINTS: Record<Exclude<FacialPartHint, "unknown">, NormalizedPoint> = {
  leftEye: [370, 330],
  rightEye: [370, 670],
  leftEyeInner: [375, 430],
  rightEyeInner: [375, 570],
  nose: [520, 500],
  leftNoseHole: [555, 460],
  rightNoseHole: [555, 540],
  mouth: [700, 500],
  mouthLeft: [705, 410],
  mouthRight: [705, 590],
  mouthUpper: [680, 500],
  mouthLower: [735, 500],
  leftBrow: [300, 320],
  rightBrow: [300, 680],
  leftBrowInner: [315, 430],
  rightBrowInner: [315, 570],
  chin: [880, 500],
  forehead: [165, 500],
  leftCheek: [560, 290],
  rightCheek: [560, 710],
  // Slightly above nose bridge to avoid defaulting at the nose tip.
  faceCenter: [470, 500],
};

function defaultPointForPart(part: FacialPartHint): NormalizedPoint {
  if (part !== "unknown") return FACIAL_PART_DEFAULT_POINTS[part];
  return FACIAL_PART_DEFAULT_POINTS.faceCenter;
}

function nearestLandmarkPart(point: NormalizedPoint, landmarks: FastLandmark[]): FacialPartHint {
  if (!landmarks.length) return "unknown";
  let best: FastLandmark | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const landmark of landmarks) {
    const dy = point[0] - landmark.point[0];
    const dx = point[1] - landmark.point[1];
    const distance = dy * dy + dx * dx;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = landmark;
    }
  }
  return best?.facialPart ?? "unknown";
}

function buildFastAnchors(
  emotions: FastAnalysisResult["emotions"],
  landmarks: FastAnalysisResult["landmarks"],
): SemanticAnchor[] {
  const duplicateCounters = new Map<string, number>();
  const emotionAnchors: SemanticAnchor[] = emotions.map((emotion) => {
    const resolvedPart =
      emotion.facialPart === "unknown" ? nearestLandmarkPart(emotion.point, landmarks) : emotion.facialPart;
    const emotionKey = emotion.emotion.toLowerCase().replace(/\s+/g, "-");
    const baseKey = `${emotionKey}-${resolvedPart}`;
    const seen = duplicateCounters.get(baseKey) ?? 0;
    duplicateCounters.set(baseKey, seen + 1);
    const stableId = `emo-${baseKey}-${seen + 1}`;
    return {
      id: stableId,
      label: emotion.emotion,
      kind: "emotion",
      facialPart: resolvedPart,
      point: emotion.point,
      confidence: emotion.confidence,
      intensity: emotion.intensity,
      explanation: emotion.explanation,
    };
  });
  const landmarkAnchors: SemanticAnchor[] = landmarks.slice(0, 8).map((landmark, index) => ({
    id: `lm-${index}-${landmark.name.toLowerCase().replace(/\s+/g, "-")}`,
    label: landmark.name,
    kind: "landmark",
    facialPart: landmark.facialPart,
    point: landmark.point,
    confidence: landmark.confidence,
  }));
  return [...emotionAnchors, ...landmarkAnchors];
}

function buildDepthAnchors(insights: DepthAnalysisResult["insights"]): SemanticAnchor[] {
  return insights.map((insight, index) => ({
    id: `depth-${index}-${insight.keyword.toLowerCase().replace(/\s+/g, "-")}`,
    label: insight.keyword,
    kind: "depth",
    facialPart: insight.facialPart,
    point: insight.point,
    confidence: insight.confidence,
  }));
}

function toDefaultLiteResult(options: AnalyzeOptions, model = LITE_MODEL): LiteAnalysisResult {
  return {
    model,
    frameId: options.frameId ?? 0,
    capturedAt: options.capturedAt ?? Date.now(),
    faceDetected: false,
    confidence: 0,
    primaryEmotion: "neutral",
    primaryConfidence: 0,
    moodSentence: "The observed mood appears neutral with low confidence.",
    candidates: [],
  };
}

function toDefaultFlashResult(options: AnalyzeOptions, model = FLASH_MODEL): FastAnalysisResult {
  return {
    model,
    frameId: options.frameId ?? 0,
    capturedAt: options.capturedAt ?? Date.now(),
    faceDetected: false,
    confidence: 0,
    emotions: [],
    landmarks: [],
    semanticAnchors: [],
  };
}

function toDefaultDepthResult(options: AnalyzeOptions, model = PRO_MODEL): DepthAnalysisResult {
  return {
    model,
    frameId: options.frameId ?? 0,
    capturedAt: options.capturedAt ?? Date.now(),
    confidence: 0,
    summary: "",
    insights: [],
    semanticAnchors: [],
  };
}

function sanitizeLiteResult(raw: unknown, options: AnalyzeOptions, model: string): LiteAnalysisResult {
  if (!raw || typeof raw !== "object") return toDefaultLiteResult(options, model);
  const source = raw as Record<string, unknown>;
  const faceBox = toFaceBox(source.faceBox);
  const faceDetected = Boolean(source.faceDetected) || Boolean(faceBox);
  const frameConfidence = toConfidence(source.confidence, faceDetected ? 0.7 : 0.1);
  const candidates: LiteAnalysisResult["candidates"] = Array.isArray(source.candidates)
    ? source.candidates.slice(0, 6).map((item) => {
        const record = item as Record<string, unknown>;
        return {
          emotion: toStringOrFallback(record?.emotion, "neutral"),
          confidence: toConfidence(record?.confidence, 0.45),
        };
      })
    : [];

  const primaryEmotion = (
    toStringOrFallback(source.primaryEmotion, "") || candidates[0]?.emotion || "neutral"
  ).slice(0, PRIMARY_EMOTION_MAX_CHARS);
  const primaryCandidate = candidates.find(
    (candidate) => candidate.emotion.trim().toLowerCase() === primaryEmotion.trim().toLowerCase(),
  );
  const primaryConfidence = toConfidence(
    source.primaryConfidence,
    primaryCandidate?.confidence ?? candidates[0]?.confidence ?? frameConfidence,
  );
  const moodSentence =
    toStringOrFallback(source.moodSentence, "").slice(0, 180) ||
    `The observed mood appears ${primaryEmotion} with ${Math.round(primaryConfidence * 100)}% confidence.`;
  const headPose =
    source.headPose && typeof source.headPose === "object"
      ? {
          pitch: isNumber((source.headPose as Record<string, unknown>).pitch)
            ? clamp((source.headPose as Record<string, unknown>).pitch as number, -90, 90)
            : 0,
          yaw: isNumber((source.headPose as Record<string, unknown>).yaw)
            ? clamp((source.headPose as Record<string, unknown>).yaw as number, -90, 90)
            : 0,
          roll: isNumber((source.headPose as Record<string, unknown>).roll)
            ? clamp((source.headPose as Record<string, unknown>).roll as number, -90, 90)
            : 0,
        }
      : undefined;

  return {
    model,
    frameId: options.frameId ?? 0,
    capturedAt: options.capturedAt ?? Date.now(),
    faceDetected,
    confidence: frameConfidence,
    primaryEmotion,
    primaryConfidence,
    moodSentence,
    candidates,
    faceBox,
    headPose,
  };
}

function sanitizeFlashResult(raw: unknown, options: AnalyzeOptions, model: string): FastAnalysisResult {
  if (!raw || typeof raw !== "object") return toDefaultFlashResult(options, model);
  const source = raw as Record<string, unknown>;
  const landmarks: FastAnalysisResult["landmarks"] = [];

  const emotions: FastAnalysisResult["emotions"] = Array.isArray(source.emotions)
    ? source.emotions.slice(0, 6).map((item) => {
        const record = item as Record<string, unknown>;
        const parsedPart = toFacialPart(record?.facialPart);
        const facialPart = parsedPart === "unknown" ? "faceCenter" : parsedPart;
        return {
          emotion: toStringOrFallback(record?.emotion, "neutral"),
          intensity: toStringOrFallback(record?.intensity, "low"),
          confidence: toConfidence(record?.confidence, 0.4),
          point: toPoint(record?.point, defaultPointForPart(facialPart)),
          facialPart,
          explanation: toStringOrFallback(record?.explanation, "").slice(0, 120) || undefined,
        };
      })
    : [];

  const faceBox = toFaceBox(source.faceBox);
  const faceDetected = Boolean(source.faceDetected) || Boolean(faceBox) || landmarks.length > 0;
  const headPose =
    source.headPose && typeof source.headPose === "object"
      ? {
          pitch: isNumber((source.headPose as Record<string, unknown>).pitch)
            ? clamp((source.headPose as Record<string, unknown>).pitch as number, -90, 90)
            : 0,
          yaw: isNumber((source.headPose as Record<string, unknown>).yaw)
            ? clamp((source.headPose as Record<string, unknown>).yaw as number, -90, 90)
            : 0,
          roll: isNumber((source.headPose as Record<string, unknown>).roll)
            ? clamp((source.headPose as Record<string, unknown>).roll as number, -90, 90)
            : 0,
        }
      : undefined;

  const result: FastAnalysisResult = {
    model,
    frameId: options.frameId ?? 0,
    capturedAt: options.capturedAt ?? Date.now(),
    faceDetected,
    confidence: toConfidence(source.confidence, faceDetected ? 0.6 : 0.1),
    faceBox,
    headPose,
    emotions,
    landmarks,
    semanticAnchors: [],
  };
  result.semanticAnchors = buildFastAnchors(result.emotions, result.landmarks);
  return result;
}

function sanitizeDepthResult(raw: unknown, options: AnalyzeOptions, model: string): DepthAnalysisResult {
  if (!raw || typeof raw !== "object") return toDefaultDepthResult(options, model);
  const source = raw as Record<string, unknown>;
  const insights: DepthAnalysisResult["insights"] = Array.isArray(source.insights)
    ? source.insights.slice(0, 10).map((item) => {
        const record = item as Record<string, unknown>;
        return {
          keyword: toStringOrFallback(record?.keyword, "neutral"),
          rationale: toStringOrFallback(record?.rationale, ""),
          medicalInterpretation: toStringOrFallback(record?.medicalInterpretation, ""),
          confidence: toConfidence(record?.confidence, 0.34),
          facialPart: toFacialPart(record?.facialPart),
          point: toPoint(record?.point),
        };
      })
    : [];

  const result: DepthAnalysisResult = {
    model,
    frameId: options.frameId ?? 0,
    capturedAt: options.capturedAt ?? Date.now(),
    confidence: toConfidence(source.confidence, insights.length ? 0.56 : 0.1),
    summary: toStringOrFallback(source.summary, ""),
    insights,
    semanticAnchors: [],
  };
  result.semanticAnchors = buildDepthAnchors(result.insights);
  return result;
}

function shouldFallbackModelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  const status = typeof e.status === "number" ? e.status : undefined;
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";

  if (status === 404) return true;
  if (status === 400 && /(model|unknown|unsupported|not found|invalid)/i.test(message)) return true;
  if (/(model|unknown|unsupported|not found|does not exist|invalid model)/i.test(message)) return true;
  if (/(not_found|model_not_found|unsupported)/i.test(code)) return true;
  return false;
}

function candidateModels(lane: LaneName, preferred: string, fallbacks: string[]): string[] {
  const resolved = resolvedLaneModels[lane];
  const models = [resolved, preferred, ...fallbacks].filter((item): item is string => Boolean(item));
  return [...new Set(models)];
}

async function generateWithLaneFallback(args: {
  lane: LaneName;
  label: string;
  preferredModel: string;
  fallbackModels: string[];
  contents: Array<{ inlineData: { data: string; mimeType: string } } | { text: string }>;
  config: GenerationConfigLike;
  timeoutMs: number;
  context?: Record<string, unknown>;
}): Promise<{ text: string; model: string }> {
  const models = candidateModels(args.lane, args.preferredModel, args.fallbackModels);
  let lastError: unknown = null;

  for (const model of models) {
    await acquireGate(model);
    try {
      const response = await withTimeout(
        getClient().models.generateContent({
          model,
          contents: args.contents,
          config: args.config,
        }),
        args.timeoutMs,
        args.label,
      );
      resolvedLaneModels[args.lane] = model;
      return { text: response.text ?? "", model };
    } catch (error) {
      lastError = error;
      const canFallback = shouldFallbackModelError(error);
      logApiError(`${args.label} attempt`, error, {
        lane: args.lane,
        model,
        canFallback,
        ...args.context,
      });
      if (!canFallback) {
        throw error;
      }
    } finally {
      releaseGate(model);
    }
  }

  throw lastError ?? new Error(`${args.label} failed across candidate models`);
}

const LITE_PROMPT = `Classify the primary emotional expression for the main face.
Return only JSON with:
- faceDetected: boolean
- confidence: number 0..1
- faceBox: [ymin, xmin, ymax, xmax] in 0..1000
- headPose: { pitch, yaw, roll } in degrees
- primaryEmotion: one of happy, sad, neutral, angry, surprised, fearful, disgusted, tired, stressed, focused
- primaryConfidence: number 0..1
- moodSentence: one concise sentence that describes the visible mood in plain language
- candidates: up to 4 items with { emotion, confidence }.
Keep it concise and do not output markdown.`;

const FLASH_PROMPT = `Provide basic facial insight analysis for one primary face.
Focus on practical emotional and fatigue-related cues with low-latency output.
Return only JSON with:
- faceDetected, confidence, faceBox, headPose
- emotions: up to 6 items with { emotion, intensity low|medium|high, confidence, facialPart, explanation }
- facialPart must be one of: leftEye,rightEye,leftEyeInner,rightEyeInner,leftBrow,rightBrow,leftBrowInner,rightBrowInner,nose,leftNoseHole,rightNoseHole,mouth,mouthLeft,mouthRight,mouthUpper,mouthLower,leftCheek,rightCheek,chin,forehead,faceCenter
- do not output point coordinates
The explanation must be short (max 10 words).`;

const PRO_PROMPT = `Provide an in-depth facial interpretation for one primary face.
Try to infer medically relevant possibilities from visible facial cues only.
Return only JSON with:
{
  "confidence": number,
  "summary": "2-4 sentence overall summary",
  "insights": [
    {
      "keyword": "...",
      "rationale": "3-6 sentences describing concrete observed visual clues and why they matter",
      "medicalInterpretation": "5-10 sentences including: 1) what the condition/pattern is, 2) why it can happen (mechanism), 3) why this face could match, 4) key uncertainty or alternative explanation",
      "confidence": number,
      "facialPart": "leftEye|rightEye|nose|mouth|leftBrow|rightBrow|chin|forehead|faceCenter",
      "point": [y, x]
    }
  ]
}
Additionally you can improve your medical interpretation with this list of potential associations between visual clues and medical conditions. Evaluate how clear the clues are compared to how rare the condition is and in case of doubt do not mention the condition:
puffy eyes → fatigue / allergies (common)
dark circles under eyes → fatigue / iron deficiency (common)
yellowish skin or sclera → jaundice / liver dysfunction (uncommon)
pale skin or lips → anemia / iron deficiency (common)
persistent facial redness or flushing → rosacea / high blood pressure (common)
butterfly rash across cheeks and nose → lupus (rare)
unilateral facial droop or asymmetry → stroke / Bell’s palsy (very rare for stroke; uncommon for Bell’s palsy)
dry / cracked lips → dehydration / vitamin B deficiency (common)
excessive facial hair (women) → PCOS (uncommon)
reduced facial expression / masked face → Parkinson’s disease (rare)
furrowed brow / deep worry lines → chronic stress (very common)
oily / shiny skin → seborrheic dermatitis (common)
xanthelasma (yellow patches around eyes) → high cholesterol (uncommon)
coarse / thickened facial features → acromegaly (very rare)
moon face (rounded full face) → Cushing’s syndrome (rare)
hirsutism + acne (women) → PCOS (uncommon)
periorbital edema (swelling around eyes) → allergies / hypothyroidism (common for allergies; uncommon for hypothyroidism)
telangiectasia (visible small blood vessels on face) → rosacea (common)
blueish lips or nasolabial area → low oxygen / heart or lung disease (rare in mild cases; very rare as isolated facial sign)
asymmetrical smile or mouth droop → stroke (very rare)
Limit to up to 8 insights.
Important:
- Be specific, clinically descriptive, and cautious.
- Do not claim diagnosis certainty.
- Keep output JSON only, but do not compress explanations into short phrases.`;

const LITE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    faceDetected: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    faceBox: {
      type: Type.ARRAY,
      items: { type: Type.INTEGER },
    },
    headPose: {
      type: Type.OBJECT,
      properties: {
        pitch: { type: Type.NUMBER },
        yaw: { type: Type.NUMBER },
        roll: { type: Type.NUMBER },
      },
    },
    primaryEmotion: { type: Type.STRING },
    primaryConfidence: { type: Type.NUMBER },
    moodSentence: { type: Type.STRING },
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          emotion: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
      },
    },
  },
};

const FLASH_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    faceDetected: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    faceBox: {
      type: Type.ARRAY,
      items: { type: Type.INTEGER },
    },
    headPose: {
      type: Type.OBJECT,
      properties: {
        pitch: { type: Type.NUMBER },
        yaw: { type: Type.NUMBER },
        roll: { type: Type.NUMBER },
      },
    },
    emotions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          emotion: { type: Type.STRING },
          intensity: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          facialPart: { type: Type.STRING },
          explanation: { type: Type.STRING },
        },
      },
    },
  },
};

const PRO_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    confidence: { type: Type.NUMBER },
    summary: { type: Type.STRING },
    insights: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          keyword: { type: Type.STRING },
          rationale: { type: Type.STRING },
          medicalInterpretation: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          facialPart: { type: Type.STRING },
          point: { type: Type.ARRAY, items: { type: Type.INTEGER } },
        },
      },
    },
  },
};

const LITE_GENERATION_CONFIG: GenerationConfigLike = {
  responseMimeType: "application/json",
  responseSchema: LITE_SCHEMA,
  candidateCount: 1,
  temperature: 0.1,
  topP: 0.72,
  maxOutputTokens: 240,
  thinkingConfig: {
    thinkingBudget: 0,
  },
};

const FLASH_GENERATION_CONFIG: GenerationConfigLike = {
  responseMimeType: "application/json",
  responseSchema: FLASH_SCHEMA,
  candidateCount: 1,
  temperature: 0.08,
  topP: 0.68,
  maxOutputTokens: 240,
  thinkingConfig: {
    thinkingBudget: 0,
  },
};

const PRO_GENERATION_CONFIG: GenerationConfigLike = {
  responseMimeType: "application/json",
  responseSchema: PRO_SCHEMA,
  candidateCount: 1,
  temperature: 0.22,
  topP: 0.86,
  maxOutputTokens: 2600,
};

export async function analyzeLitePrimaryEmotion(
  base64Image: string,
  options: AnalyzeOptions = {},
): Promise<LiteAnalysisResult> {
  const timeoutMs = computeTimeoutMs(options.timeoutMs, LITE_TIMEOUT_MS, base64Image, 9_000);

  try {
    const { text, model } = await generateWithLaneFallback({
      lane: "lite",
      label: "Lite primary emotion",
      preferredModel: LITE_MODEL,
      fallbackModels: LITE_FALLBACK_MODELS,
      timeoutMs,
      contents: [
        {
          inlineData: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
        { text: LITE_PROMPT },
      ],
      config: LITE_GENERATION_CONFIG,
      context: { frameId: options.frameId },
    });
    return sanitizeLiteResult(safeJsonParse(text), options, model);
  } catch (error) {
    logApiError("Lite primary emotion", error, { frameId: options.frameId });
    return toDefaultLiteResult(options, resolvedLaneModels.lite ?? LITE_MODEL);
  }
}

export async function analyzeFlashInsights(
  base64Image: string,
  options: AnalyzeOptions = {},
): Promise<FastAnalysisResult> {
  const timeoutMs = computeTimeoutMs(options.timeoutMs, FLASH_TIMEOUT_MS, base64Image, 16_000);

  try {
    const { text, model } = await generateWithLaneFallback({
      lane: "flash",
      label: "Flash insights",
      preferredModel: FLASH_MODEL,
      fallbackModels: FLASH_FALLBACK_MODELS,
      timeoutMs,
      contents: [
        {
          inlineData: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
        { text: FLASH_PROMPT },
      ],
      config: FLASH_GENERATION_CONFIG,
      context: { frameId: options.frameId },
    });
    return sanitizeFlashResult(safeJsonParse(text), options, model);
  } catch (error) {
    logApiError("Flash insights", error, { frameId: options.frameId });
    return toDefaultFlashResult(options, resolvedLaneModels.flash ?? FLASH_MODEL);
  }
}

export async function analyzeDepthInsights(
  base64Image: string,
  options: AnalyzeOptions = {},
): Promise<DepthAnalysisResult> {
  const baseTimeoutMs = computeTimeoutMs(options.timeoutMs, PRO_TIMEOUT_MS, base64Image, 58_000);
  const timeoutMs = options.videoClipBase64 ? Math.min(baseTimeoutMs + 10_000, 72_000) : baseTimeoutMs;
  const hasVideoContext = Boolean(options.videoClipBase64 && options.videoMimeType);

  try {
    const { text, model } = await generateWithLaneFallback({
      lane: "pro",
      label: "Pro medical interpretation",
      preferredModel: PRO_MODEL,
      fallbackModels: PRO_FALLBACK_MODELS,
      timeoutMs,
      contents: [
        {
          inlineData: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
        ...(hasVideoContext
          ? [
              {
                inlineData: {
                  data: options.videoClipBase64 as string,
                  mimeType: options.videoMimeType as string,
                },
              } as const,
            ]
          : []),
        {
          text: hasVideoContext
            ? `${PRO_PROMPT}
Use both the still image and the short webcam video clip. Use motion and temporal cues from the clip when useful.`
            : PRO_PROMPT,
        },
      ],
      config: PRO_GENERATION_CONFIG,
      context: { frameId: options.frameId, hasVideoContext },
    });
    return sanitizeDepthResult(safeJsonParse(text), options, model);
  } catch (error) {
    logApiError("Pro medical interpretation", error, { frameId: options.frameId });
    return toDefaultDepthResult(options, resolvedLaneModels.pro ?? PRO_MODEL);
  }
}

// Backward-compatible alias for existing API route names.
export async function analyzeFastFace(
  base64Image: string,
  options: AnalyzeOptions = {},
): Promise<FastAnalysisResult> {
  return analyzeFlashInsights(base64Image, options);
}

export async function analyzeFrame(base64Image: string): Promise<LegacyAnalysisResult> {
  const capturedAt = Date.now();
  const [lite, flash, depth] = await Promise.all([
    analyzeLitePrimaryEmotion(base64Image, { frameId: 0, capturedAt }),
    analyzeFlashInsights(base64Image, { frameId: 0, capturedAt }),
    analyzeDepthInsights(base64Image, { frameId: 0, capturedAt }),
  ]);

  return {
    faceBox: flash.faceBox,
    headPose: flash.headPose,
    primaryEmotion: {
      emotion: lite.primaryEmotion,
      confidence: lite.primaryConfidence,
    },
    emotions: flash.emotions.map((emotion) => ({
      emotion: emotion.emotion,
      intensity: emotion.intensity,
      point: emotion.point,
    })),
    landmarks: flash.landmarks.map((landmark) => ({
      name: landmark.name,
      point: landmark.point,
    })),
    insights: depth.insights.map((insight) => ({
      keyword: insight.keyword,
      point: insight.point,
    })),
  };
}
