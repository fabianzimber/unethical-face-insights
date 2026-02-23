import { NextRequest, NextResponse } from "next/server";

const MAX_IMAGE_BASE64_LENGTH = 4_000_000;
const MIN_IMAGE_BASE64_LENGTH = 128;
const MAX_VIDEO_BASE64_LENGTH = 8_000_000;
const MIN_VIDEO_BASE64_LENGTH = 256;
const MAX_FRAME_AGE_MS = 15_000;
const MAX_VIDEO_DURATION_MS = 8_000;

export interface AnalyzeRequestPayload {
  image: string;
  frameId: number;
  capturedAt: number;
  width: number;
  height: number;
  videoClipBase64?: string;
  videoMimeType?: string;
  videoDurationMs?: number;
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function toPositiveInt(value: unknown): number | undefined {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined) return undefined;
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : undefined;
}

export async function parseAnalyzePayload(
  request: NextRequest,
  maxSide: number,
): Promise<{ payload: AnalyzeRequestPayload } | { response: NextResponse }> {
  const body = await request.json();
  const image = typeof body?.image === "string" ? body.image : "";

  if (!image || image.length < MIN_IMAGE_BASE64_LENGTH) {
    return { response: fail("No image provided", 400) };
  }
  if (image.length > MAX_IMAGE_BASE64_LENGTH) {
    return { response: fail("Image payload too large", 413) };
  }

  const width = toPositiveInt(body?.width) ?? 640;
  const height = toPositiveInt(body?.height) ?? 360;
  if (width > maxSide || height > maxSide) {
    return { response: fail(`Input must be downscaled to <= ${maxSide}px`, 400) };
  }

  const frameId = toPositiveInt(body?.frameId) ?? 1;
  const now = Date.now();
  // Clamp capturedAt to server time to prevent clients from sending future timestamps
  const rawCapturedAt = toFiniteNumber(body?.capturedAt) ?? now;
  const capturedAt = Math.min(rawCapturedAt, now);
  if (now - capturedAt > MAX_FRAME_AGE_MS) {
    return { response: fail("Stale frame rejected", 409) };
  }

  const videoClipBase64 = typeof body?.videoClipBase64 === "string" ? body.videoClipBase64 : "";
  const videoMimeType = typeof body?.videoMimeType === "string" ? body.videoMimeType.trim() : "";
  const videoDurationMs = toPositiveInt(body?.videoDurationMs);
  if (videoClipBase64) {
    if (videoClipBase64.length < MIN_VIDEO_BASE64_LENGTH) {
      return { response: fail("Video payload too short", 400) };
    }
    if (videoClipBase64.length > MAX_VIDEO_BASE64_LENGTH) {
      return { response: fail("Video payload too large", 413) };
    }
    if (!videoMimeType || !/^video\/webm/i.test(videoMimeType)) {
      return { response: fail("Unsupported video format; use video/webm", 400) };
    }
    if (!videoDurationMs || videoDurationMs > MAX_VIDEO_DURATION_MS) {
      return { response: fail("Video duration is invalid or too long", 400) };
    }
  }

  return {
    payload: {
      image,
      frameId,
      capturedAt,
      width,
      height,
      videoClipBase64: videoClipBase64 || undefined,
      videoMimeType: videoMimeType || undefined,
      videoDurationMs: videoDurationMs || undefined,
    },
  };
}

export async function withRequestAbort<T>(request: NextRequest, promise: Promise<T>): Promise<T> {
  if (request.signal.aborted) {
    throw new Error("Request aborted before processing");
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Request aborted by client"));
    request.signal.addEventListener("abort", onAbort, { once: true });

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => request.signal.removeEventListener("abort", onAbort));
  });
}
