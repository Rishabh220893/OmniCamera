# OmniCamera

OmniCamera is a browser-native multi-camera scene intelligence console for CCTV, phone, tablet, and desktop camera feeds.

## What it does

- Links multiple cameras in one dashboard.
- Opens native mobile, tablet, or desktop webcams through `getUserMedia`.
- Links CCTV/IP camera feeds through HLS, MJPEG, WebRTC gateway, vendor bridge, or HTTP snapshot URLs.
- Analyzes each camera every 30 seconds.
- Generates a short scene summary for each feed.
- Estimates people, vehicle, face, motion, brightness, and scene tone signals.
- Lets operators save known faces by name in the local face directory.

## CCTV integration notes

Browsers cannot directly open every proprietary CCTV transport such as raw RTSP without a bridge. To integrate existing CCTV fleets, expose each camera through one of these browser-compatible forms:

- HLS (`.m3u8`) or MP4/WebM stream.
- MJPEG or periodic image snapshot endpoint.
- WebRTC gateway output.
- Existing NVR/VMS vendor API endpoint that returns a browser-playable feed.

Once a compatible URL is available, use **Link CCTV stream** in the app and add as many camera endpoints as needed.

## Run locally

```bash
npm start
```

Open <http://localhost:5173>.

## Build and test

```bash
npm run build
npm test
```

The app is intentionally dependency-free so it can run in constrained environments and be packaged later inside native shells such as Capacitor, Tauri, Electron, or mobile WebView wrappers.
