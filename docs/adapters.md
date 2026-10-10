# Source adapters

An adapter is the one place that knows how a kind of camera source works. Profiles, playback recipes, media-server
config and analysis never look at the source type; they work from what an adapter returns. Adding a source type means
adding one file under `server/adapters/` and registering it in `server/adapters/index.ts`.

## The contract (`server/adapters/types.ts`)

| Member | Required | Purpose |
|---|---|---|
| `kind`, `label`, `description` | yes | Stable name stored on camera records, and text for the Registry. |
| `accepts(ref)` | yes | True when the adapter can handle the camera. Used only when `ref.adapter` is not set. |
| `endpoints(ref)` | yes | The streams the camera offers: protocol (`rtsp`, `whep`, `hls`, `mjpeg`, `snapshot`) and role (`analysis`, `browser`, `snapshot`). |
| `probe(ref, opts)` | yes | Measures the camera and returns the same `ProbeReport` as every other source, so the decision table and media plan work unchanged. |
| `discover(opts)` | no | Finds devices on the network or from a directory. |
| `deviceInfo(ref)` | no | Make, model, firmware, serial. |

A camera is described by a `CameraRef`: `id`, then `url`, or `host` and `port`, an optional `adapter`, `credentials`,
`site` and adapter-specific `options`. Credentials are used for the call and are never stored in a profile or returned
by the API (`redactUrl` strips them from URLs).

## Shipped adapters

| `kind` | For | Discovery | Notes |
|---|---|---|---|
| `onvif` | Cameras and recorders speaking ONVIF | WS-Discovery multicast on the server's own segment | Reads profiles and stream addresses from the device (GetCapabilities, GetProfiles, GetStreamUri), logs in with a WS-Security digest and follows the camera's clock, prefers the largest H.264/H.265 profile, fixes `0.0.0.0` stream hosts, then probes the RTSP address. Choose another profile with `options.profile`. |
| `hikvision` | Hikvision cameras, NVRs, DVRs (and OEM brands on the same firmware) | no | Stream address from the channel number (`/Streaming/Channels/<ch>01` main, `<ch>02` sub). Make, model, firmware and the channel list (names, connected or not, camera IP) from ISAPI over Digest or Basic login. A DVR without an IP-camera list falls back to its video inputs. |
| `dahua` | Dahua cameras, NVRs, XVRs (and OEM brands) | no | `/cam/realmonitor?channel=<n>&subtype=0|1`. Device details and channel list (names, connection state) from the CGI interface. |
| `rtsp` | Any `rtsp://` URL (IP camera, NVR channel, encoder) | no | Credentials from the record or the URL. |
| `http` | HLS playlists, MJPEG streams, snapshot URLs | no | Measured with ffmpeg. |
| `grid-rtsp` | The integrator-guide grid (`rtsp://host:port/<prefix>/<id>` with WHEP and HLS beside it) | no | Wraps the existing probe; only registered when the server knows a grid site. |

### Recorders and vendor systems (G3)

`hikvision` and `dahua` take `host` and `port` (the device's **HTTP** port, default 80; 443 with `options.https: true`), plus `options.channel` (the number the recorder itself uses, default 1), `options.stream` (`main` or `sub`, default `main`, used by probe) and `options.rtspPort` (default 554). A vendor `rtsp://` URL works instead and is recognised automatically. `POST /api/adapters/channels` lists every camera behind a recorder as a ready-to-register camera, so a whole NVR is one call plus one probe per channel.

**Analog cameras** are reached through the DVR/XVR or an encoder that digitises them: register the recorder and use the channel number of the analog input. There is no separate adapter; the picture quality and frame rate are the recorder's.

**Milestone, Genetec and other VMS platforms** are not built as vendor adapters. They publish streams only through their own gateways: Milestone via the Open Network Bridge (ONVIF) and Genetec via Media Gateway (RTSP and ONVIF). Register those with the `onvif` or `rtsp` adapter. A native adapter for either needs the vendor's API or SDK and a test installation, which this project does not have.

**How the vendor adapters were tested (no recorder was available):** `tests/lab/fakeNvr.ts` is an HTTP server that answers the calls in each vendor's documented shape and checks the login (it recomputes the Digest response, or checks Basic). `tests/vendorNvr.test.ts` covers stream numbering (including IP channels past 32), device information and channel lists over Digest, Basic and no login, wrong or missing logins, older firmware without the status calls, a DVR without the IP-camera list, odd names and passwords, 16 channels in any order, a dead device and 40 parallel reads; and probes a real MediaMTX stream through the vendor addresses with the real ffprobe and ffmpeg. **Not covered:** real firmware (the response shapes come from the vendors' public documentation and may differ by model or firmware version), hybrid DVRs whose IP channels are numbered differently from their analog ones, HTTPS with a self-signed certificate, and recorded playback and PTZ.

### How ONVIF has been tested (no camera was available)

- `tests/lab/fakeOnvif.ts` is a real HTTP server that speaks the calls the adapter makes and checks the login the way a camera does (it recomputes the
  WS-Security digest, refuses a login stamped far from its own clock, and verifies HTTP Digest/Basic). `tests/onvifCompat.test.ts` runs the adapter against it
  across **135 combinations** of login method (none, WS-Security, HTTP Digest, HTTP Basic, either) x XML prefix style (standard, odd, none) x capability behaviour
  (supported, fault, no media entry) x clock error (0, +2 h, -3 h) x fault style (HTTP 400, 500, 200), plus an announced-but-unreachable media address, wrong
  or missing logins, profile lists that are empty/partly broken/MJPEG-only, odd passwords, silence, refusal, non-ONVIF answers, 40 parallel calls, and WS-Discovery
  over real UDP.
- `tests/onvifEndToEnd.test.ts` puts a real MediaMTX stream (H.264, password-protected) behind the fake device and probes it through the adapter with the real ffprobe
  and ffmpeg: codec, size, frame count and keyframe spacing come out right; a wrong RTSP password is `bad_credentials`; a stream address on an unreachable host falls back to
  the address the device was reached on. Skipped when MediaMTX or ffmpeg is missing.
- Found and fixed this way: passwords containing `%` made a broken RTSP URL; the fallback for an unreachable media address kept the wrong port; a dead stream address made
  ffprobe hang for over a minute (a quick TCP check now reports "unreachable" in seconds).
- **Not covered**: real vendor firmware quirks, ONVIF over HTTPS with a self-signed certificate (not supported yet), multicast discovery across several network
  adapters or through a managed switch, and PTZ/events/analytics services (the adapter reads only the Device and Media services).

## Onboarding a camera (federation plan A4)

Registry > **Add cameras from a device or recorder** (administrators), or `POST /api/sources/onboard`, turns a device into a Registry camera that plays through the media server. Kinds: ONVIF (address and login), Hikvision and Dahua recorders (every channel at once), and a plain `rtsp://` address. One call does:

1. asks the adapter which RTSP stream the camera offers (the main stream; `options.stream: "sub"` or `options.profile` choose another) and refuses at once if a login would have to be stored and there is no key;
2. **probes it through the adapter** (the same real measurement the grid's cameras get) and refuses a camera that is unreachable, refuses the login, or sends no video, with the reason and nothing added (`force` adds it anyway, with no playable path until it is probed again);
3. saves the **profile** under the site `federated`, so the recipe table decides how it is served (plain pull, or an ffmpeg re-encode for H.265, B-frames and the like) exactly as for the grid;
4. saves the **source**: its address without a login, and the address the media server pulls (login inside) **sealed** with AES-256-GCM under `SOURCE_SECRET_KEY`;
5. creates the camera in the **Registry** (owned by the administrator, given to a department if one is chosen), pointing at its media-server path.

If a later step fails the earlier ones are undone. A recorder is a background job (`onboard-channels`, one channel at a time, about 20 s each); the panel shows each channel's result.

| Where | What |
|---|---|
| Firestore `cameras` document | name, owner, `departmentId`, `adapter`, `sourceId` (= the media-server path, `fed-<12 hex>`), `remoteStreamUrl` (the camera's HLS address on the media server; only its path is used to find the stream). **No login.** |
| Postgres `camera_sources` | adapter, device address without login, department, Registry id, and the sealed address. |
| Postgres profiles | site `federated`, camera id = the path. |
| MediaMTX | path `fed-...`, pulled on demand from the camera (or re-encoded), added with `POST /api/sources/apply-media`; also written to the generated paths file next to the grid's, so a restart brings both back. Every path starting `fed-` is managed by the apply, so a removed camera's path is removed. |

Needs `DATABASE_URL` (profiles and sources), `FIREBASE_SERVICE_ACCOUNT` (the Registry), `MEDIA_SERVER_URL` (the stream address) and, for a camera that needs a login, `SOURCE_SECRET_KEY`. Only RTSP sources can be served: an MJPEG or snapshot-only camera is refused with a message.

**Playing.** A tile plays such a camera from the media server only (no WebRTC, still pictures or app proxy: those are the grid's, with the grid's login). **Analysis.** The browser loop captures from the tile as for any camera; the server worker grabs frames straight from the stored address (the login is unsealed only for that call).

**Removing and re-probing.** `DELETE /api/sources/:id` removes the Registry camera, the source and the profile; its media path goes at the next apply. `POST /api/sources/:id/reprobe` measures it again from the stored address.

**Limits worth knowing.**
- **Video access is by the media server's shared viewer password, not by department.** A department's cameras are separated in the Registry and the events, but anyone who is signed in receives the viewer password and could play a path whose name they know. The names are random and appear only in camera documents the person may read, which makes guessing impractical, but it is not access control. Per-user stream tokens belong to the security work (plan A21).
- Not for cameras assigned to a regional gateway (the gateway has no access to the sealed source), and the analysis worker's frame grab from a stored source is built but was not run against a real camera.
- Stored logins cannot be read back if `SOURCE_SECRET_KEY` is lost or changed: re-onboard the cameras.

**How it was tested.** Unit tests with fake adapters and stores (`tests/sources.test.ts`: sealing, path building, every refusal and the rollback, the routes, the recorder job, the apply against a stand-in control API, what a tile needs); and an end-to-end test with nothing mocked but the stores (`tests/sourcesEndToEnd.test.ts`): a real MediaMTX plays the department's camera system behind a login with awkward characters, the real RTSP adapter probes it with ffprobe and ffmpeg, the path is added to a second real MediaMTX through its control API, and its HLS playlist and a decoded video frame are fetched from there; removal takes the path off again, and a wrong login is refused. The Registry panel was opened in a browser (renders, copes with a signed-out caller and with a server that lacks the routes). **Not run:** a real ONVIF device, Hikvision or Dahua recorder (the adapters are tested against fakes, `docs/adapters.md` above), the Firestore writes of the Registry document (tested against a stand-in collection), the Postgres source store (`tests/sourceStorePg.test.ts` is written; it needs `TEST_DATABASE_URL`), the panel with a signed-in administrator and real data, an H.265 re-encode of such a camera on Quick Sync, and a recorder with many channels.

## API

See `docs/openapi.yaml`. All routes are admin only.

| Route | Does |
|---|---|
| `GET /api/adapters` | Lists adapters. |
| `POST /api/adapters/discover` | `{ adapter: "onvif", timeoutMs }` finds devices. |
| `POST /api/adapters/device` | `{ camera }` reads make and model. |
| `POST /api/adapters/endpoints` | `{ camera }` lists streams, logins removed. |
| `POST /api/adapters/probe` | `{ camera, sampleSec }` probes, and stores the profile when `DATABASE_URL` is set. |
| `GET /api/sources` | The cameras onboarded through adapters, with recipe and last probe; whether logins can be stored. |
| `POST /api/sources/onboard` | `{ camera, name?, departmentId?, sampleSec?, force?, location? }` onboards one camera (201, or 422 with the reason and nothing added). |
| `POST /api/sources/onboard-channels` | `{ camera, channels?, namePrefix?, departmentId?, force? }` starts a job for a whole recorder; `GET /api/sources/jobs/:id` reports it. |
| `POST /api/sources/:id/reprobe`, `DELETE /api/sources/:id` | Measure again from the stored address; take it out. |
| `POST /api/sources/apply-media` | `{ dryRun? }` puts the sources' paths on the running media server (default: shows what would change). |

```bash
curl -X POST http://localhost:3000/api/adapters/probe \
  -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
  -d '{"camera":{"id":"gate1","adapter":"onvif","host":"192.168.1.64","credentials":{"user":"admin","pass":"..."}}}'
```

## Network rules

- Discovery uses UDP multicast (239.255.255.250:3702), so it only finds devices on the segment the server is on. Across sites
  it needs a gateway on each segment (gap G6).
- The server refuses private-network addresses unless `ADAPTERS_ALLOW_PRIVATE=true`. Set it only on a server that is meant to
  reach cameras on its own LAN.
- At most three probes run at once; each takes as long as its sample.

## Writing a new adapter

1. Create `server/adapters/<name>.ts` exporting a `SourceAdapter` (copy `directRtsp.ts`, the smallest).
2. For anything ending in a URL ffmpeg can open, call `probeUrl()` from `probeUrl.ts` instead of writing measurement code.
3. Register it in `createDefaultAdapters` in `server/adapters/index.ts`.
4. Test it with a fake transport the way `tests/adapters.test.ts` does for ONVIF.
