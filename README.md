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

## Run on Android with Termux

Use Termux as the local static web server, then open the app in a real Android browser. The browser, not Termux, owns the camera permission prompt.

1. Install Termux from F-Droid or GitHub, then open Termux.
2. Update packages and install the required tools:

   ```bash
   pkg update && pkg upgrade
   pkg install git nodejs python
   ```

3. Get the project onto the phone. If you cloned from GitHub, replace the URL with your repository URL:

   ```bash
   git clone <your-omnicamera-repo-url>
   cd OmniCamera
   ```

   If the project is already on the phone, `cd` into that folder instead.

4. Run the checks:

   ```bash
   npm test
   npm run build
   ```

5. Start the local web server:

   ```bash
   npm start
   ```

6. In Android Chrome, Firefox, or another modern browser, open:

   ```text
   http://127.0.0.1:5173
   ```

7. Tap **Add native camera** and allow camera permission when the browser asks. Native camera access must be opened from the browser page; Termux itself does not provide the `getUserMedia` prompt.

8. To test CCTV feeds, tap **Link CCTV stream** and add a browser-compatible stream or snapshot URL. For best results on Android browsers, use MP4/WebM, MJPEG, a snapshot URL, or a WebRTC/HLS gateway that your browser can play. Keep the phone on the same network or VPN as the CCTV/NVR endpoint.

### Termux troubleshooting

- If the page does not load, keep Termux open and confirm `npm start` is still running, then use `http://127.0.0.1:5173` instead of `0.0.0.0`.
- If camera permission does not appear, open the app in Chrome/Firefox directly, not inside Termux or a restricted WebView.
- If camera access is blocked, check Android browser site settings for `127.0.0.1` and allow Camera.
- If a CCTV URL does not render, verify it is reachable from the phone browser and is in a browser-playable format. Raw RTSP usually needs an NVR, WebRTC, HLS, MJPEG, or snapshot bridge first.
