# Unethical Face Insight Console

Light-mode facecam overlays with:
- on-device facial-part tracking via MediaPipe Face Landmarker
- three Gemini layers:
  - Layer 1 Lite: `gemini-2.5-flash-lite` (primary emotion classification)
  - Layer 2 Flash: `gemini-3.0-flash-preview` (basic emotion/fatigue cues)
  - Layer 3 Pro: `gemini-3.1-pro-preview` (slow, buffered, in-depth interpretation)
- in-camera canvas UI with left Flash legend and right Pro legend

## Requirements

- Node 20+
- `GEMINI_API_KEY` set in your environment (required for API routes)

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Architecture

- Lite lane: `POST /api/analyze/lite`
- Flash lane: `POST /api/analyze/fast`
- Pro lane: `POST /api/analyze/depth`
- Compatibility lane: `POST /api/analyze` (merged multi-lane payload)
- Overlay: single canvas compositor + collision-aware label layout + temporal smoothing
- Tracking: MediaPipe landmarks keep Flash emotion labels attached between AI responses

## Rollout Strategy

1. Verify Lite lane stability for primary emotion updates.
2. Validate Flash legend quality at its slower interval.
3. Confirm Pro interpretation cadence and disclaimer text with real webcam runs.
