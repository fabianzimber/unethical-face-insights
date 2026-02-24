import { NextRequest, NextResponse } from "next/server";
import { analyzeDepthInsights } from "@/services/gemini";
import { parseAnalyzePayload, withRequestAbort } from "../shared";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseAnalyzePayload(request, 720);
    if ("response" in parsed) return parsed.response;

    const { payload } = parsed;
    const startedAt = Date.now();
    const result = await withRequestAbort(
      request,
      analyzeDepthInsights(payload.image, {
        frameId: payload.frameId,
        capturedAt: payload.capturedAt,
        videoClipBase64: payload.videoClipBase64,
        videoMimeType: payload.videoMimeType,
        videoDurationMs: payload.videoDurationMs,
      }),
    );

    return NextResponse.json({
      frameId: payload.frameId,
      capturedAt: payload.capturedAt,
      serverAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Depth analysis failed";
    const lc = message.toLowerCase();
    let status = 500;
    if (lc.includes("aborted")) status = 499;
    else if (lc.includes("busy") || lc.includes("quota") || lc.includes("resource_exhausted") || lc.includes("rate limit")) status = 429;
    return NextResponse.json({ error: message }, { status });
  }
}
