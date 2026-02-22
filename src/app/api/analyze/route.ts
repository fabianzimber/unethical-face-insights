import { NextRequest, NextResponse } from "next/server";
import { analyzeDepthInsights, analyzeFastFace, analyzeLitePrimaryEmotion } from "@/services/gemini";
import { parseAnalyzePayload, withRequestAbort } from "./shared";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseAnalyzePayload(request, 960);
    if ("response" in parsed) {
      return parsed.response;
    }

    const { payload } = parsed;
    const startedAt = Date.now();
    const [liteOutcome, fastOutcome, depthOutcome] = await withRequestAbort(
      request,
      Promise.allSettled([
        analyzeLitePrimaryEmotion(payload.image, {
          frameId: payload.frameId,
          capturedAt: payload.capturedAt,
        }),
        analyzeFastFace(payload.image, {
          frameId: payload.frameId,
          capturedAt: payload.capturedAt,
        }),
        analyzeDepthInsights(payload.image, {
          frameId: payload.frameId,
          capturedAt: payload.capturedAt,
        }),
      ]),
    );

    const liteResult = liteOutcome.status === "fulfilled" ? liteOutcome.value : undefined;
    const fastResult = fastOutcome.status === "fulfilled" ? fastOutcome.value : undefined;
    const depthResult = depthOutcome.status === "fulfilled" ? depthOutcome.value : undefined;

    return NextResponse.json({
      frameId: payload.frameId,
      capturedAt: payload.capturedAt,
      serverAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      lite: liteResult,
      fast: fastResult,
      depth: depthResult,
      faceBox: fastResult?.faceBox,
      headPose: fastResult?.headPose,
      primaryEmotion: liteResult
        ? {
            emotion: liteResult.primaryEmotion,
            confidence: liteResult.primaryConfidence,
          }
        : undefined,
      emotions: fastResult?.emotions.map((emotion) => ({
        emotion: emotion.emotion,
        intensity: emotion.intensity,
        point: emotion.point,
      })),
      landmarks: fastResult?.landmarks.map((landmark) => ({
        name: landmark.name,
        point: landmark.point,
      })),
      insights:
        depthResult?.insights.map((insight) => ({
          keyword: insight.keyword,
          point: insight.point,
        })) ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed";
    const status = message.includes("aborted") ? 499 : 500;
    console.error("API route error:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
