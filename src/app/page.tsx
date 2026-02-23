"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DepthAnalysisResult,
  FastAnalysisResult,
  LiteAnalysisResult,
  NormalizedFaceBox,
  NormalizedPoint,
  SemanticAnchor,
} from "@/types/analysis";
import { layoutLabels } from "@/services/overlay/layout";
import { PointSmoother } from "@/services/overlay/smoothing";
import { AnchorFusionEngine } from "@/services/tracking/anchorFusion";
import { MediaPipeTracker } from "@/services/tracking/mediapipeTracker";
import { InviteGenerator } from "@/components/auth/InviteGenerator";
import styles from "./page.module.css";

interface AnalysisEnvelope<T> {
  frameId: number;
  capturedAt: number;
  serverAt: number;
  latencyMs: number;
  result: T;
}

interface CapturePayload {
  image: string;
  width: number;
  height: number;
  capturedAt: number;
  videoClipBase64?: string;
  videoMimeType?: string;
  videoDurationMs?: number;
}

interface HudState {
  liteMs: number;
  flashMs: number;
  proMs: number;
  litePending: boolean;
  flashPending: boolean;
  proPending: boolean;
}

interface CaptureProfile {
  maxSide: number;
  jpegQuality: number;
}

interface FlashIndexCard {
  key: string;
  label: string;
  value: string;
  hint: string;
}

type Lane = "lite" | "flash" | "pro";

const CAPTURE_PROFILES: Record<Lane, CaptureProfile> = {
  lite: { maxSide: 560, jpegQuality: 0.65 },
  flash: { maxSide: 700, jpegQuality: 0.68 },
  pro: { maxSide: 720, jpegQuality: 0.68 },
};

const LANE_INTERVAL_MS: Record<Lane, number> = {
  lite: 1200,
  flash: 2800,
  pro: 50000,
};

const MAX_VISIBLE_EMOTION_TAGS = 8;
const OVERLAY_MAX_PIXELS = 1280 * 720;
const CAMERA_TARGET_FPS = 24;
const TRACKING_INTERVAL_MS = 1000 / CAMERA_TARGET_FPS;
const OVERLAY_DRAW_INTERVAL_MS = 1000 / 30;
const INITIAL_GEMINI_COOLDOWN_MS = 2000;
const PRO_FIRST_PRE_CAPTURE_WAIT_MS = 5000;
const PRO_VIDEO_CLIP_MS = 5000;
const PRO_VIDEO_MAX_BASE64_LENGTH = 8_000_000;
const PRO_EMPTY_RESULT_RETRY_MS = 3500;
const PRO_VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

type ToneClass = "toneWarm" | "toneAlert" | "toneCool" | "toneNeutral";

function classifyTone(emotion: string): ToneClass {
  const normalized = emotion.toLowerCase();
  if (["joy", "happy", "surprise", "excitement", "positive", "content"].some((item) => normalized.includes(item))) {
    return "toneWarm";
  }
  if (["anger", "fear", "sad", "anx", "stress", "disgust", "hostile"].some((item) => normalized.includes(item))) {
    return "toneAlert";
  }
  if (["neutral", "calm", "steady", "flat", "balanced"].some((item) => normalized.includes(item))) {
    return "toneNeutral";
  }
  return "toneCool";
}

function formatPercent(value: number): string {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

function pickSupportedVideoMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  for (const candidate of PRO_VIDEO_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read recorded video blob"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value.split(",")[1] || "");
    };
    reader.readAsDataURL(blob);
  });
}

function buildLiteMoodSentence(label: string, confidence: number): string {
  const normalized = (label || "neutral").trim().toLowerCase();
  const confidencePct = Math.round(clamp(confidence, 0, 1) * 100);
  return `Layer 1 indicates a ${normalized} mood with ${confidencePct}% confidence.`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface CoverProjection {
  offsetX: number;
  offsetY: number;
  renderWidth: number;
  renderHeight: number;
}

function computeCoverProjection(
  video: HTMLVideoElement | null,
  viewportWidth: number,
  viewportHeight: number,
): CoverProjection {
  const safeWidth = Math.max(1, viewportWidth);
  const safeHeight = Math.max(1, viewportHeight);
  const sourceWidth = Math.max(1, video?.videoWidth || safeWidth);
  const sourceHeight = Math.max(1, video?.videoHeight || safeHeight);
  const sourceAspect = sourceWidth / sourceHeight;
  const viewportAspect = safeWidth / safeHeight;

  let renderWidth = safeWidth;
  let renderHeight = safeHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (sourceAspect > viewportAspect) {
    // Source is wider: fill height and crop left/right.
    renderHeight = safeHeight;
    renderWidth = safeHeight * sourceAspect;
    offsetX = (safeWidth - renderWidth) / 2;
  } else if (sourceAspect < viewportAspect) {
    // Source is taller: fill width and crop top/bottom.
    renderWidth = safeWidth;
    renderHeight = safeWidth / sourceAspect;
    offsetY = (safeHeight - renderHeight) / 2;
  }

  return { offsetX, offsetY, renderWidth, renderHeight };
}

function toPixels(
  point: NormalizedPoint,
  projection: CoverProjection,
): { x: number; y: number } {
  return {
    x: projection.offsetX + (point[1] / 1000) * projection.renderWidth,
    y: projection.offsetY + (point[0] / 1000) * projection.renderHeight,
  };
}

function faceBoxToPixels(
  faceBox: NormalizedFaceBox,
  projection: CoverProjection,
): { x: number; y: number; w: number; h: number } {
  const x = projection.offsetX + (faceBox[1] / 1000) * projection.renderWidth;
  const y = projection.offsetY + (faceBox[0] / 1000) * projection.renderHeight;
  const w = ((faceBox[3] - faceBox[1]) / 1000) * projection.renderWidth;
  const h = ((faceBox[2] - faceBox[0]) / 1000) * projection.renderHeight;
  return { x, y, w, h };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function nearestPointOnRect(
  ax: number,
  ay: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): { x: number; y: number } {
  return { x: clamp(ax, rx, rx + rw), y: clamp(ay, ry, ry + rh) };
}

function formatLatency(ms: number): string {
  if (!ms || ms < 1) return "---";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildFlashAnchors(flash: FastAnalysisResult | null): SemanticAnchor[] {
  return flash?.semanticAnchors.filter((anchor) => anchor.kind === "emotion").slice(0, MAX_VISIBLE_EMOTION_TAGS) ?? [];
}

function dedupeFlashLegend(
  items: Array<{ emotion: string; confidence: number; explanation?: string; intensity?: string }>,
): Array<{ emotion: string; confidence: number; explanation?: string; intensity?: string }> {
  const seen = new Map<string, { emotion: string; confidence: number; explanation?: string; intensity?: string }>();
  for (const item of items) {
    const key = item.emotion.trim().toLowerCase();
    const previous = seen.get(key);
    if (!previous || item.confidence > previous.confidence) {
      seen.set(key, item);
    }
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}

function hasUsableFlashEmotionPayload(result: FastAnalysisResult | null): boolean {
  if (!result) return false;
  return (result.emotions ?? []).some(
    (item) => item.emotion.trim().length > 0 && Number.isFinite(item.confidence) && item.confidence >= 0.08,
  );
}

function dedupeEmotionAnchorsByLabel<T extends { label: string; confidence: number; stale?: boolean }>(
  anchors: T[],
): T[] {
  const kept = new Map<string, T>();
  for (const anchor of anchors) {
    const key = anchor.label.trim().toLowerCase();
    if (!key) continue;
    const previous = kept.get(key);
    if (!previous) {
      kept.set(key, anchor);
      continue;
    }

    const currentScore = anchor.confidence + (anchor.stale ? -0.03 : 0);
    const previousScore = previous.confidence + (previous.stale ? -0.03 : 0);
    if (currentScore > previousScore) {
      kept.set(key, anchor);
      continue;
    }

    if (Math.abs(currentScore - previousScore) < 0.0001 && anchor.label.length > previous.label.length) {
      kept.set(key, anchor);
    }
  }
  return [...kept.values()].sort((a, b) => b.confidence - a.confidence);
}

function dedupeProInsights(insights: DepthAnalysisResult["insights"]): DepthAnalysisResult["insights"] {
  const seen = new Map<string, DepthAnalysisResult["insights"][number]>();
  for (const insight of insights) {
    const key = insight.keyword.trim().toLowerCase();
    const previous = seen.get(key);
    if (!previous || insight.confidence > previous.confidence) {
      seen.set(key, insight);
    }
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}

function hasUsableProInsights(insights: DepthAnalysisResult["insights"]): boolean {
  return insights.some(
    (item) =>
      item.keyword.trim().length > 0 &&
      Number.isFinite(item.confidence) &&
      item.confidence >= 0.12 &&
      (item.rationale.trim().length > 0 || (item.medicalInterpretation?.trim().length ?? 0) > 0),
  );
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const liteCaptureCanvasRef = useRef<HTMLCanvasElement>(null);
  const flashCaptureCanvasRef = useRef<HTMLCanvasElement>(null);
  const proCaptureCanvasRef = useRef<HTMLCanvasElement>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef<MediaPipeTracker | null>(null);
  const fusionRef = useRef(new AnchorFusionEngine({ maxStaleMs: 6000, hardMaxStaleMs: 30000 }));
  const smootherRef = useRef(new PointSmoother({ attackMs: 48, releaseMs: 154, maxStateAgeMs: 4600 }));

  const liteResultRef = useRef<LiteAnalysisResult | null>(null);
  const flashResultRef = useRef<FastAnalysisResult | null>(null);
  const proResultRef = useRef<DepthAnalysisResult | null>(null);
  const trackedFrameRef = useRef<ReturnType<MediaPipeTracker["track"]> | null>(null);

  const runningRef = useRef(false);
  const renderRafRef = useRef<number | null>(null);
  const liteTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const proTimerRef = useRef<number | null>(null);
  const liteAbortRef = useRef<AbortController | null>(null);
  const flashAbortRef = useRef<AbortController | null>(null);
  const proAbortRef = useRef<AbortController | null>(null);

  const requestFrameRef = useRef({ lite: 0, flash: 0, pro: 0 });
  const appliedFrameRef = useRef({ lite: 0, flash: 0, pro: 0 });
  const pendingRef = useRef({ lite: false, flash: false, pro: false });
  const lastTrackAtRef = useRef(0);
  const lastOverlayDrawAtRef = useRef(0);
  const geminiReadyAtRef = useRef(0);
  const proFirstCaptureAtRef = useRef(0);
  const proFirstRequestStartedRef = useRef(false);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [trackerReady, setTrackerReady] = useState(false);
  const [trackerError, setTrackerError] = useState("");
  const [role, setRole] = useState<'owner' | 'guest' | null>(null);
  const [primaryEmotion, setPrimaryEmotion] = useState({ label: "neutral", confidence: 0 });
  const [primaryMoodSentence, setPrimaryMoodSentence] = useState("Layer 1 is initializing mood interpretation.");
  const [flashLegend, setFlashLegend] = useState<Array<{ emotion: string; confidence: number; explanation?: string; intensity?: string }>>([]);
  const [proLegend, setProLegend] = useState<DepthAnalysisResult["insights"]>([]);
  const [hud, setHud] = useState<HudState>({
    liteMs: 0,
    flashMs: 0,
    proMs: 0,
    litePending: false,
    flashPending: false,
    proPending: false,
  });

  const flashIndices = useMemo<FlashIndexCard[]>(() => {
    if (!flashLegend.length) return [];
    const sorted = [...flashLegend].sort((a, b) => b.confidence - a.confidence);
    const top = sorted[0]?.confidence ?? 0;
    const entropy = sorted.reduce((sum, item) => {
      const p = clamp(item.confidence, 0.0001, 1);
      return sum - p * Math.log2(p);
    }, 0);
    const maxEntropy = sorted.length > 1 ? Math.log2(sorted.length) : 1;
    const clarity = clamp(1 - entropy / maxEntropy, 0, 1);

    return [
      { key: "dominance", label: "Dominance", value: formatPercent(top), hint: "Top signal confidence" },
      { key: "clarity", label: "Clarity", value: formatPercent(clarity), hint: "Lower overlap between cues" },
    ];
  }, [flashLegend]);

  const stopStream = useCallback(() => {
    if (!streamRef.current) return;
    for (const track of streamRef.current.getTracks()) track.stop();
    streamRef.current = null;
  }, []);

  const stopLoops = useCallback(() => {
    if (renderRafRef.current !== null) {
      cancelAnimationFrame(renderRafRef.current);
      renderRafRef.current = null;
    }
    if (liteTimerRef.current !== null) clearTimeout(liteTimerRef.current);
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    if (proTimerRef.current !== null) clearTimeout(proTimerRef.current);
    liteTimerRef.current = null;
    flashTimerRef.current = null;
    proTimerRef.current = null;
    liteAbortRef.current?.abort();
    flashAbortRef.current?.abort();
    proAbortRef.current?.abort();
    liteAbortRef.current = null;
    flashAbortRef.current = null;
    proAbortRef.current = null;
    pendingRef.current = { lite: false, flash: false, pro: false };
  }, []);

  const startWebcam = useCallback(async () => {
    stopStream();
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS },
        },
        audio: false,
      });
      streamRef.current = mediaStream;
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play().catch(() => undefined);
      }
      setHasPermission(true);
    } catch (error) {
      console.error("Webcam access failed:", error);
      setHasPermission(false);
      setCameraReady(false);
    }
  }, [stopStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlaying = () => {
      const now = performance.now();
      setCameraReady(true);
      geminiReadyAtRef.current = now + INITIAL_GEMINI_COOLDOWN_MS;
      proFirstCaptureAtRef.current = now + PRO_FIRST_PRE_CAPTURE_WAIT_MS;
      proFirstRequestStartedRef.current = false;
    };
    const onEnded = () => {
      setCameraReady(false);
      geminiReadyAtRef.current = 0;
      proFirstCaptureAtRef.current = 0;
      proFirstRequestStartedRef.current = false;
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("emptied", onEnded);
    video.addEventListener("pause", onEnded);
    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("emptied", onEnded);
      video.removeEventListener("pause", onEnded);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => {
        if (!res.ok) {
          window.location.href = '/login';
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (cancelled || !data) return;
        setRole(data.role);
        startWebcam();
      })
      .catch(() => {
        if (!cancelled) window.location.href = '/login';
      });
    return () => {
      cancelled = true;
      runningRef.current = false;
      stopLoops();
      trackerRef.current?.dispose();
      trackerRef.current = null;
      stopStream();
    };
  }, [startWebcam, stopLoops, stopStream]);

  useEffect(() => {
    if (!cameraReady || hasPermission !== true) return;
    let cancelled = false;
    const tracker = new MediaPipeTracker();
    trackerRef.current = tracker;
    setTrackerReady(false);
    setTrackerError("");
    tracker
      .init()
      .then(() => {
        if (!cancelled) setTrackerReady(true);
      })
      .catch((error) => {
        console.error("MediaPipe tracker init failed:", error);
        if (!cancelled) {
          setTrackerReady(false);
          setTrackerError("Tracker unavailable, overlays use AI-only fallback.");
        }
      });

    return () => {
      cancelled = true;
      tracker.dispose();
      if (trackerRef.current === tracker) trackerRef.current = null;
      setTrackerReady(false);
    };
  }, [cameraReady, hasPermission]);

  const getCaptureCanvas = useCallback((lane: Lane): HTMLCanvasElement | null => {
    if (lane === "lite") return liteCaptureCanvasRef.current;
    if (lane === "flash") return flashCaptureCanvasRef.current;
    return proCaptureCanvasRef.current;
  }, []);

  const captureFrame = useCallback(
    (lane: Lane): CapturePayload | null => {
      const video = videoRef.current;
      const canvas = getCaptureCanvas(lane);
      if (!video || !canvas || !video.videoWidth || !video.videoHeight) return null;

      const profile = CAPTURE_PROFILES[lane];
      const ratio = video.videoWidth / video.videoHeight;
      let width = profile.maxSide;
      let height = Math.round(width / ratio);
      if (height > profile.maxSide) {
        height = profile.maxSide;
        width = Math.round(height * ratio);
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, width, height);
      const encoded = canvas.toDataURL("image/jpeg", profile.jpegQuality).split(",")[1];
      if (!encoded) return null;

      return {
        image: encoded,
        width,
        height,
        capturedAt: Date.now(),
      };
    },
    [getCaptureCanvas],
  );

  const captureProVideoClip = useCallback(async (): Promise<Pick<CapturePayload, "videoClipBase64" | "videoMimeType" | "videoDurationMs">> => {
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") return {};

    const mimeType = pickSupportedVideoMimeType();
    try {
      const recorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 380_000,
        audioBitsPerSecond: 64_000,
      });
      const chunks: BlobPart[] = [];

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => settle(() => reject(new Error("MediaRecorder failed")));
        recorder.onstop = () => settle(resolve);

        recorder.start(250);
        window.setTimeout(() => {
          if (recorder.state !== "inactive") recorder.stop();
        }, PRO_VIDEO_CLIP_MS);
      });

      const clipBlob = new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });
      if (!clipBlob.size) return {};
      const videoClipBase64 = await blobToBase64(clipBlob);
      if (!videoClipBase64 || videoClipBase64.length > PRO_VIDEO_MAX_BASE64_LENGTH) return {};

      return {
        videoClipBase64,
        videoMimeType: clipBlob.type || "video/webm",
        videoDurationMs: PRO_VIDEO_CLIP_MS,
      };
    } catch (error) {
      console.error("Pro video clip capture failed:", error);
      return {};
    }
  }, []);

  const syncOverlayCanvas = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return null;
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const nativeDpr = window.devicePixelRatio || 1;
    const area = width * height;
    const dprFromBudget = Math.sqrt(OVERLAY_MAX_PIXELS / Math.max(area, 1));
    const renderScale = Math.min(nativeDpr, dprFromBudget, 1.35);
    const pixelWidth = Math.max(1, Math.round(width * renderScale));
    const pixelHeight = Math.max(1, Math.round(height * renderScale));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    return { ctx, width, height };
  }, []);

  const drawOverlay = useCallback(
    (nowMs: number) => {
      const synced = syncOverlayCanvas();
      if (!synced) return;
      const { ctx, width, height } = synced;
      ctx.clearRect(0, 0, width, height);

      const corner = Math.max(18, Math.min(width, height) * 0.045);
      ctx.strokeStyle = "rgba(0, 238, 168, 0.62)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(10, corner);
      ctx.lineTo(10, 10);
      ctx.lineTo(corner, 10);
      ctx.moveTo(width - corner, 10);
      ctx.lineTo(width - 10, 10);
      ctx.lineTo(width - 10, corner);
      ctx.moveTo(10, height - corner);
      ctx.lineTo(10, height - 10);
      ctx.lineTo(corner, height - 10);
      ctx.moveTo(width - corner, height - 10);
      ctx.lineTo(width - 10, height - 10);
      ctx.lineTo(width - 10, height - corner);
      ctx.stroke();

      const tracked = trackedFrameRef.current;
      const flash = flashResultRef.current;
      const lite = liteResultRef.current;
      const projection = computeCoverProjection(videoRef.current, width, height);
      const faceBox = tracked?.faceBox ?? flash?.faceBox ?? lite?.faceBox;
      let faceCenterX = width / 2;
      let faceCenterY = height / 2;
      if (faceBox) {
        const box = faceBoxToPixels(faceBox, projection);
        faceCenterX = box.x + box.w / 2;
        faceCenterY = box.y + box.h / 2;
        ctx.strokeStyle = "rgba(0, 238, 168, 0.96)";
        ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
        ctx.lineWidth = 2;
        drawRoundedRect(ctx, box.x, box.y, box.w, box.h, 7);
        ctx.fill();
        ctx.stroke();
      }

      const projectedAnchors = fusionRef.current.project(tracked, nowMs, { preserveStale: pendingRef.current.flash });
      const anchors = projectedAnchors.length
        ? projectedAnchors
        : buildFlashAnchors(flash).map((anchor) => ({ ...anchor, projectedPoint: anchor.point, stale: false }));
      const visibleAnchors = dedupeEmotionAnchorsByLabel(
        anchors.filter((anchor) => anchor.kind === "emotion" && anchor.confidence >= 0.2),
      )
        .slice(0, MAX_VISIBLE_EMOTION_TAGS);
      if (!visibleAnchors.length) return;

      const emotionFont = '700 11px "Manrope", ui-sans-serif, system-ui, sans-serif';
      ctx.font = emotionFont;
      const items = visibleAnchors.map((anchor) => {
        const point = toPixels(
          smootherRef.current.smooth(anchor.id, anchor.projectedPoint, nowMs),
          projection,
        );
        const text = anchor.label;
        return {
          anchor,
          point,
          text,
          width: Math.ceil(ctx.measureText(text).width) + 14,
          height: 22,
        };
      });

      const layout = layoutLabels(
        items.map((item) => ({
          id: item.anchor.id,
          text: item.text,
          anchorX: item.point.x,
          anchorY: item.point.y,
          width: item.width,
          height: item.height,
          priority: item.anchor.confidence + 0.2,
          preferDistance: true,
        })),
        { width, height, padding: 10, faceCenterX, faceCenterY },
        MAX_VISIBLE_EMOTION_TAGS,
      );

      const itemById = new Map(items.map((item) => [item.anchor.id, item]));
      for (const placed of layout) {
        const item = itemById.get(placed.id);
        if (!item) continue;
        const alpha = item.anchor.stale ? 0.58 : 1;
        const edge = nearestPointOnRect(item.point.x, item.point.y, placed.x, placed.y, placed.width, placed.height);

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = "rgba(0, 245, 178, 0.72)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(item.point.x, item.point.y);
        ctx.lineTo(edge.x, edge.y);
        ctx.stroke();

        ctx.fillStyle = "rgba(0, 255, 194, 0.85)";
        ctx.beginPath();
        ctx.arc(item.point.x, item.point.y, 2.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(9, 14, 25, 0.92)";
        ctx.strokeStyle = "rgba(0, 238, 168, 0.88)";
        drawRoundedRect(ctx, placed.x, placed.y, placed.width, placed.height, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "rgba(241, 250, 255, 0.96)";
        ctx.textBaseline = "middle";
        ctx.font = emotionFont;
        ctx.fillText(item.text, placed.x + 7, placed.y + placed.height / 2);
      }
      ctx.globalAlpha = 1;
      smootherRef.current.prune(nowMs);
    },
    [syncOverlayCanvas],
  );

  useEffect(() => {
    if (!cameraReady || hasPermission !== true) return;
    runningRef.current = true;
    lastTrackAtRef.current = 0;
    lastOverlayDrawAtRef.current = 0;
    const warmupRemainingMs = () => Math.max(0, geminiReadyAtRef.current - performance.now());

    const scheduleLane = (lane: Lane, delayMs: number) => {
      if (!runningRef.current) return;
      const safeDelayMs = Math.max(0, delayMs);
      const timerRef = lane === "lite" ? liteTimerRef : lane === "flash" ? flashTimerRef : proTimerRef;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        if (lane === "lite") void runLiteLoop();
        else if (lane === "flash") void runFlashLoop();
        else void runProLoop();
      }, safeDelayMs);
    };
    const scheduleLaneFromCycle = (lane: Lane, cycleStartedAt: number, minDelayMs = 0) => {
      const elapsed = Math.max(0, performance.now() - cycleStartedAt);
      const remaining = Math.max(0, LANE_INTERVAL_MS[lane] - elapsed);
      scheduleLane(lane, Math.max(minDelayMs, remaining));
    };

    const refreshFusion = () => {
      fusionRef.current.updateAnchors(buildFlashAnchors(flashResultRef.current), trackedFrameRef.current, Date.now());
    };

    const runLiteLoop = async () => {
      if (!runningRef.current) return;
      if (pendingRef.current.lite) return void scheduleLane("lite", LANE_INTERVAL_MS.lite);
      const warmupMs = warmupRemainingMs();
      if (warmupMs > 0) return void scheduleLane("lite", warmupMs + 24);
      const payload = captureFrame("lite");
      if (!payload) return void scheduleLane("lite", LANE_INTERVAL_MS.lite);

      pendingRef.current.lite = true;
      setHud((previous) => ({ ...previous, litePending: true }));
      requestFrameRef.current.lite += 1;
      const frameId = requestFrameRef.current.lite;
      const controller = new AbortController();
      liteAbortRef.current = controller;
      const startedAt = performance.now();

      try {
        const response = await fetch("/api/analyze/lite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({ ...payload, frameId }),
        });
        if (!response.ok) return;
        const envelope = (await response.json()) as AnalysisEnvelope<LiteAnalysisResult>;
        const receivedFrameId = Number(envelope.frameId ?? envelope.result?.frameId ?? 0);
        if (!receivedFrameId || receivedFrameId < appliedFrameRef.current.lite) return;
        appliedFrameRef.current.lite = receivedFrameId;
        liteResultRef.current = envelope.result;
        const nextLabel = envelope.result.primaryEmotion || "neutral";
        const nextConfidence = envelope.result.primaryConfidence ?? 0;
        setPrimaryEmotion({ label: nextLabel, confidence: nextConfidence });
        setPrimaryMoodSentence(
          envelope.result.moodSentence?.trim() || buildLiteMoodSentence(nextLabel, nextConfidence),
        );
        const serverMs = Number(envelope.latencyMs);
        const elapsed = Math.max(0, performance.now() - startedAt);
        const nextMs = Number.isFinite(serverMs) && serverMs > 0 ? serverMs : elapsed;
        setHud((previous) => ({ ...previous, liteMs: Math.round(nextMs) }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AbortError") console.error("Lite loop error:", error);
      } finally {
        pendingRef.current.lite = false;
        setHud((previous) => ({ ...previous, litePending: false }));
        liteAbortRef.current = null;
        scheduleLaneFromCycle("lite", startedAt, 24);
      }
    };

    const runFlashLoop = async () => {
      if (!runningRef.current) return;
      if (pendingRef.current.flash) return void scheduleLane("flash", LANE_INTERVAL_MS.flash);
      const warmupMs = warmupRemainingMs();
      if (warmupMs > 0) return void scheduleLane("flash", warmupMs + 48);
      const payload = captureFrame("flash");
      if (!payload) return void scheduleLane("flash", LANE_INTERVAL_MS.flash);

      pendingRef.current.flash = true;
      setHud((previous) => ({ ...previous, flashPending: true }));
      requestFrameRef.current.flash += 1;
      const frameId = requestFrameRef.current.flash;
      const controller = new AbortController();
      flashAbortRef.current = controller;
      const startedAt = performance.now();

      try {
        const response = await fetch("/api/analyze/fast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({ ...payload, frameId }),
        });
        if (!response.ok) return;
        const envelope = (await response.json()) as AnalysisEnvelope<FastAnalysisResult>;
        const receivedFrameId = Number(envelope.frameId ?? envelope.result?.frameId ?? 0);
        if (!receivedFrameId || receivedFrameId < appliedFrameRef.current.flash) return;
        const nextResult = envelope.result;
        appliedFrameRef.current.flash = receivedFrameId;
        const previousFlash = flashResultRef.current;
        const shouldKeepPrevious = Boolean(previousFlash && !hasUsableFlashEmotionPayload(nextResult));
        let effectiveResult: FastAnalysisResult = nextResult;
        if (shouldKeepPrevious && previousFlash) {
          effectiveResult = {
            ...previousFlash,
            frameId: nextResult.frameId || previousFlash.frameId,
            capturedAt: nextResult.capturedAt || previousFlash.capturedAt,
            model: nextResult.model || previousFlash.model,
            faceDetected: Boolean(nextResult.faceDetected || previousFlash.faceDetected),
            confidence: Math.max(previousFlash.confidence || 0, nextResult.confidence || 0),
            faceBox: nextResult.faceBox ?? previousFlash.faceBox,
            headPose: nextResult.headPose ?? previousFlash.headPose,
            emotions: previousFlash.emotions,
            landmarks: previousFlash.landmarks,
            semanticAnchors: previousFlash.semanticAnchors,
          };
        }
        flashResultRef.current = effectiveResult;

        const legendSource = shouldKeepPrevious ? previousFlash?.emotions ?? [] : nextResult.emotions ?? [];
        const dedupedLegend = dedupeFlashLegend(
          [...legendSource]
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 12)
            .map((item) => ({
              emotion: item.emotion,
              confidence: item.confidence,
              explanation: item.explanation,
              intensity: item.intensity,
            })),
        );
        setFlashLegend((previous) => (dedupedLegend.length > 0 ? dedupedLegend : previous));

        const serverMs = Number(envelope.latencyMs);
        const elapsed = Math.max(0, performance.now() - startedAt);
        const nextMs = Number.isFinite(serverMs) && serverMs > 0 ? serverMs : elapsed;
        setHud((previous) => ({ ...previous, flashMs: Math.round(nextMs) }));
        refreshFusion();
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AbortError") console.error("Flash loop error:", error);
      } finally {
        pendingRef.current.flash = false;
        setHud((previous) => ({ ...previous, flashPending: false }));
        flashAbortRef.current = null;
        scheduleLaneFromCycle("flash", startedAt, 36);
      }
    };

    const runProLoop = async () => {
      if (!runningRef.current) return;
      const isFirstProRequest = !proFirstRequestStartedRef.current;
      const faceDetected = Boolean((trackedFrameRef.current?.confidence ?? 0) > 0.5 || flashResultRef.current?.faceDetected || liteResultRef.current?.faceDetected);
      if (pendingRef.current.pro) return void scheduleLane("pro", LANE_INTERVAL_MS.pro);
      if (!faceDetected) {
        return void scheduleLane("pro", isFirstProRequest ? 700 : LANE_INTERVAL_MS.pro);
      }

      if (isFirstProRequest) {
        const preCaptureRemainingMs = Math.max(0, proFirstCaptureAtRef.current - performance.now());
        if (preCaptureRemainingMs > 0) return void scheduleLane("pro", preCaptureRemainingMs + 24);
      }

      const warmupMs = warmupRemainingMs();
      if (warmupMs > 0) return void scheduleLane("pro", warmupMs + 64);
      const payload = captureFrame("pro");
      if (!payload) return void scheduleLane("pro", LANE_INTERVAL_MS.pro);
      const videoClipPayload = await captureProVideoClip();
      if (!runningRef.current) return;

      pendingRef.current.pro = true;
      proFirstRequestStartedRef.current = true;
      setHud((previous) => ({ ...previous, proPending: true }));
      requestFrameRef.current.pro += 1;
      const frameId = requestFrameRef.current.pro;
      const controller = new AbortController();
      proAbortRef.current = controller;
      const startedAt = performance.now();
      let retryDelayOverrideMs: number | null = null;

      try {
        const response = await fetch("/api/analyze/depth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({ ...payload, ...videoClipPayload, frameId }),
        });
        if (!response.ok) {
          retryDelayOverrideMs = PRO_EMPTY_RESULT_RETRY_MS;
          return;
        }
        const envelope = (await response.json()) as AnalysisEnvelope<DepthAnalysisResult>;
        const receivedFrameId = Number(envelope.frameId ?? envelope.result?.frameId ?? 0);
        if (!receivedFrameId || receivedFrameId < appliedFrameRef.current.pro) return;
        appliedFrameRef.current.pro = receivedFrameId;
        const dedupedInsights = dedupeProInsights(envelope.result.insights ?? []);
        const usableInsights = hasUsableProInsights(dedupedInsights);
        if (!usableInsights) {
          retryDelayOverrideMs = isFirstProRequest ? 2200 : PRO_EMPTY_RESULT_RETRY_MS;
        }
        proResultRef.current = usableInsights || !proResultRef.current ? envelope.result : proResultRef.current;
        setProLegend((previous) => (usableInsights ? dedupedInsights : previous));

        const serverMs = Number(envelope.latencyMs);
        const elapsed = Math.max(0, performance.now() - startedAt);
        const nextMs = Number.isFinite(serverMs) && serverMs > 0 ? serverMs : elapsed;
        setHud((previous) => ({ ...previous, proMs: Math.round(nextMs) }));
      } catch (error) {
        retryDelayOverrideMs = PRO_EMPTY_RESULT_RETRY_MS;
        if (!(error instanceof Error) || error.name !== "AbortError") console.error("Pro loop error:", error);
      } finally {
        pendingRef.current.pro = false;
        setHud((previous) => ({ ...previous, proPending: false }));
        proAbortRef.current = null;
        if (retryDelayOverrideMs !== null) scheduleLane("pro", retryDelayOverrideMs);
        else scheduleLaneFromCycle("pro", startedAt, 200);
      }
    };

    const render = (now: number) => {
      if (!runningRef.current) return;

      const video = videoRef.current;
      const tracker = trackerRef.current;
      if (now - lastTrackAtRef.current >= TRACKING_INTERVAL_MS) {
        trackedFrameRef.current = video && tracker?.ready ? tracker.track(video, now) : null;
        lastTrackAtRef.current = now;
      }

      if (now - lastOverlayDrawAtRef.current >= OVERLAY_DRAW_INTERVAL_MS) {
        drawOverlay(now);
        lastOverlayDrawAtRef.current = now;
      }

      renderRafRef.current = requestAnimationFrame(render);
    };

    scheduleLane("lite", 0);
    scheduleLane("flash", 420);
    scheduleLane("pro", PRO_FIRST_PRE_CAPTURE_WAIT_MS);
    renderRafRef.current = requestAnimationFrame(render);

    return () => {
      runningRef.current = false;
      stopLoops();
    };
  }, [cameraReady, hasPermission, captureFrame, captureProVideoClip, drawOverlay, stopLoops]);

  const faceLocked = liteResultRef.current?.faceDetected || flashResultRef.current?.faceDetected;
  const primaryLabel = (primaryEmotion.label || "neutral").slice(0, 64);
  const primaryConfidenceText = formatPercent(primaryEmotion.confidence);

  if (hasPermission === false) {
    return (
      <main className={styles.permissionMain}>
        <div className={styles.permissionCard}>
          <h1 className={styles.permissionTitle}>Camera Access Required</h1>
          <p className={styles.permissionText}>Allow webcam permissions to run the three-layer analysis pipeline.</p>
          <button onClick={startWebcam} className={styles.permissionButton}>
            Retry Camera
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.consolePage}>
      <div className={styles.consoleShell}>
        <header className={styles.consoleHeader}>
          <h1 className={styles.consoleTitle}>Unethical Face Insights</h1>
          <p className={styles.consoleSubtitle}>
            Layer 1 Lite primary emotion, Layer 2 Flash basic signal indices, Layer 3 Medical interpretation.
          </p>
        </header>

        {role === 'owner' && <InviteGenerator />}

        <section className={styles.workspace}>
          <div ref={containerRef} className={styles.stage}>
            <video ref={videoRef} autoPlay playsInline muted />
            <canvas ref={overlayCanvasRef} className={styles.overlayCanvas} />

            <canvas ref={liteCaptureCanvasRef} className={styles.captureCanvas} />
            <canvas ref={flashCaptureCanvasRef} className={styles.captureCanvas} />
            <canvas ref={proCaptureCanvasRef} className={styles.captureCanvas} />

            {!cameraReady && (
              <div className={styles.cameraBoot}>
                <p className={styles.cameraBootText}>Starting Camera Feed</p>
              </div>
            )}

            <div className={styles.overlayTop}>
              <div className={styles.statusCluster}>
                <span className={styles.statusChip}>{faceLocked ? "Face Locked" : "Scanning"}</span>
                <span className={styles.statusChip}>Tracker {trackerReady ? "On" : "Init"}</span>
                {trackerError && <span className={`${styles.statusChip} ${styles.statusChipWarn}`}>AI Fallback</span>}
              </div>

              <div className={styles.latencyCluster}>
                <span className={styles.statusChip}>
                  Lite {formatLatency(hud.liteMs)}
                  {hud.litePending ? " • pending" : ""}
                </span>
                <span className={styles.statusChip}>
                  Flash {formatLatency(hud.flashMs)}
                  {hud.flashPending ? " • pending" : ""}
                </span>
                <span className={styles.statusChip}>
                  Pro {formatLatency(hud.proMs)}
                  {hud.proPending ? " • pending" : ""}
                </span>
              </div>
            </div>

            <div className={styles.primaryEmotionCard}>
              <p className={styles.primaryEmotionKicker}>Layer 1 Primary Emotion</p>
              <div className={styles.primaryEmotionRow}>
                <h2 className={styles.primaryEmotionValue}>{primaryLabel}</h2>
                <p className={styles.primaryEmotionScore}>{primaryConfidenceText}</p>
              </div>
              <p className={styles.primaryEmotionMeta}>{primaryMoodSentence}</p>
              <div className={styles.primaryEmotionMeter}>
                <div className={styles.primaryEmotionMeterFill} style={{ width: primaryConfidenceText }} />
              </div>
            </div>
          </div>

          <div className={styles.panelRail}>
            <aside className={styles.panel}>
              <h2 className={styles.panelTitle}>Layer 2 - Flash Basic</h2>
              <p className={styles.panelSubtitle}>Emotion and fatigue-oriented cue extraction with dominance and clarity indices.</p>

              {flashLegend.length === 0 ? (
                <p className={styles.emptyState}>No flash insights yet.</p>
              ) : (
                <ul className={styles.insightList}>
                  {flashLegend.map((item, index) => (
                    <li
                      key={item.emotion.trim().toLowerCase()}
                      className={`${styles.insightItem} ${styles[classifyTone(item.emotion)]}`}
                    >
                      <div className={styles.insightTop}>
                        <div className={styles.insightLeft}>
                          <span className={styles.rankBadge}>{index + 1}</span>
                          <p className={styles.insightEmotion}>{item.emotion}</p>
                        </div>
                        <p className={styles.insightConfidence}>{formatPercent(item.confidence)}</p>
                      </div>
                      <div className={styles.confidenceTrack}>
                        <div className={styles.confidenceFill} style={{ width: formatPercent(item.confidence) }} />
                      </div>
                      {item.intensity && <p className={styles.insightTag}>{item.intensity}</p>}
                      {item.explanation && <p className={styles.insightText}>{item.explanation}</p>}
                    </li>
                  ))}
                </ul>
              )}

              {flashIndices.length > 0 && (
                <div className={styles.flashIndexGrid}>
                  {flashIndices.map((indexCard) => (
                    <article key={indexCard.key} className={styles.flashIndexCard}>
                      <p className={styles.flashIndexLabel}>{indexCard.label}</p>
                      <p className={styles.flashIndexValue}>{indexCard.value}</p>
                      <p className={styles.flashIndexHint}>{indexCard.hint}</p>
                    </article>
                  ))}
                </div>
              )}
            </aside>
          </div>
        </section>

        <section className={styles.proSection}>
          <aside className={`${styles.panel} ${styles.proPanel}`}>
            <h2 className={styles.panelTitle}>Layer 3 - Pro Interpretation</h2>
            <p className={styles.panelSubtitle}>
              Detailed reasoning from visible cues to possible medical interpretation. This is exploratory and not diagnostic advice.
            </p>
            {proLegend.length === 0 ? (
              <p className={styles.emptyState}>No pro insights yet.</p>
            ) : (
              <ul className={styles.proInsightList}>
                {proLegend.map((insight, index) => {
                  const visualClue = insight.rationale?.trim() || "No explicit visual clue was returned for this candidate.";
                  const interpretationPath =
                    insight.medicalInterpretation?.trim() ||
                    "No detailed interpretation path was returned for this candidate.";
                  const evidenceReasoning = `This candidate is linked to the face because the model reported: ${visualClue}`;

                  return (
                    <li key={insight.keyword.trim().toLowerCase()} className={`${styles.insightItem} ${styles.proItem}`}>
                      <div className={styles.insightTop}>
                        <div className={styles.insightLeft}>
                          <span className={styles.rankBadge}>{index + 1}</span>
                          <p className={styles.insightEmotion}>{insight.keyword}</p>
                        </div>
                        <p className={styles.insightConfidence}>{formatPercent(insight.confidence)}</p>
                      </div>
                      <div className={styles.confidenceTrack}>
                        <div className={styles.confidenceFill} style={{ width: formatPercent(insight.confidence) }} />
                      </div>
                      <p className={styles.proDetailLabel}>Visual Clue</p>
                      <p className={styles.insightText}>{visualClue}</p>
                      <p className={styles.proDetailLabel}>Interpretation Path</p>
                      <p className={styles.insightText}>{interpretationPath}</p>
                      <p className={styles.proDetailLabel}>Why This Face Could Fit</p>
                      <p className={styles.insightText}>{evidenceReasoning}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </section>
      </div>
    </main>
  );
}
