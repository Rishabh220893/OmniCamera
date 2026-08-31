<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/0c62847a-918a-415d-8189-9b3a674a309c

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Deploy

This is a standard Node/Express server (`server.ts`, built via `npm run build` into `dist/server.cjs`, started via `npm start`) — it needs a real Node host, **not** an edge/Workers platform like Cloudflare Pages/Workers, since it depends on `firebase-admin` and `googleapis`, which require Node's native networking stack.

**Render** (recommended): this repo includes a [`render.yaml`](render.yaml) blueprint. In the Render dashboard, "New +" → "Blueprint", point it at this repo, and set the environment variables it prompts for:

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Server-side vision analysis and chat |
| `GOOGLE_SHEETS_CREDENTIALS` | No | Enables the Sheets log-export integration |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | No | Target spreadsheet for the above |
| `FIREBASE_SERVICE_ACCOUNT` | No | Enables the Central Registry API (`docs/registry-api.md`) |
| `REGISTRY_API_KEY` | No | Shared secret for the Registry API — set this if `FIREBASE_SERVICE_ACCOUNT` is set |

Any other Node host (Railway, Fly.io, a plain VM) works the same way: `npm install && npm run build`, then `npm start`, with the same environment variables.
