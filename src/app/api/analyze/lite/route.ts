import { NextRequest, NextResponse } from "next/server";
import { analyzeLitePrimaryEmotion } from "@/services/gemini";
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
      analyzeLitePrimaryEmotion(payload.image, {
        frameId: payload.frameId,
        capturedAt: payload.capturedAt,
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
    const message = error instanceof Error ? error.message : "Lite analysis failed";
    let status = 500;
    if (message.includes("aborted")) status = 499;
    else if (message.includes("busy")) status = 429;
    return NextResponse.json({ error: message }, { status });
  }
}
