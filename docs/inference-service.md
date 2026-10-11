# The inference service contract (gap A17)

The platform does not run neural networks itself. A frame is sent to a separate service that can sit on a GPU server, scale on its own and be replaced. The platform's side
(`server/analytics/remoteInference.ts`) is built and tested against a mock service over real HTTP; **no real detector has been run behind it**, and the reference service in
`inference-service/` has never been executed (written without Python, a GPU or the models available). Treat it as a starting point.

## HTTP contract

`Authorization: Bearer <INFERENCE_API_KEY>` when a key is set.

```
POST /v1/infer
  { "image": "<base64 JPEG>", "tasks": ["person", "vehicle", "face"] }
  -> { "model": "yolov8n+arcface", "ms": 31,
       "detections": [ { "label": "person" | "car" | "truck" | "bus" | "motorcycle" | "bicycle", "score": 0.91, "box": [x, y, w, h] } ],
       "faces": [ { "box": [x, y, w, h], "score": 0.97, "embedding": [ ...16 to 4096 numbers... ] } ] }
  (boxes are fractions of the picture, 0 to 1; "faces" only when "face" was asked for)
GET /health  ->  { "status": "ok", "model": "...", "device": "cuda:0" }
```

## What the platform does with it

- Counts people and vehicles from detections with a score of at least 0.5 and a box of at least 1% of the picture in both directions (a malformed row, a dog, a speck are not counted) and puts the counts in the log
  entry; raises `person.seen` and `vehicle.seen` events (with the model name and, for vehicles, the count by label).
- Asks for faces only when the camera's user has an enrolled-face index; matches each returned embedding by cosine similarity (strict default threshold 0.6) and raises `person.known` (with the score) or `person.unknown`.
  **A match is a pointer for a person to check, not an identification.** Whether and where this may be used is the State's legal question.
- A service that fails does not fail the frame: the analyzer is optional, so the rest of the result is kept and an `analyzer.failed` notice is raised. After 3 failures in a row the service is skipped for 60 seconds, then tried again.

## Settings

`INFERENCE_SERVICE_URL` (turns it on), `INFERENCE_API_KEY`, `INFERENCE_TIMEOUT_MS` (default 5000). The Kubernetes manifest for a GPU deployment is `deploy/k8s/optional/gpu-services.yaml`.

## What it does not do (yet)

No enrolment of face embeddings (a faces screen that sends a photo to `/v1/infer` and stores the vector); no tracking of one object across frames; no behaviour classes (loitering, falling); no batching of frames
(one call per frame: at the modelled rate a GPU service needs batching, which the contract can take as a list in a later version); no model management. Accuracy on real footage was not measured: use `npm run ai:bench`'s
approach (your frames, your ground truth) before relying on any detector.
