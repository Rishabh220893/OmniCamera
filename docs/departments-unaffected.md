# What this platform does to a department's own systems (gap A25: "departments unaffected")

A note for the departments whose cameras and systems are connected. It says what the platform does, what it never does, and what a department can verify. Written 2026-10-11.
Where a statement is about code, it names the test that checks it; where it is about behaviour on a real department system, **it has not been checked against one** (no real recorder
or VMS was available), only against fakes that follow the vendors' public documentation.

## What the platform does with your system

| It does | How | Load it puts on you |
|---|---|---|
| Reads your cameras' streams | A pull of the camera's RTSP address or HLS through the media server: **one pull per camera, however many people watch** | One stream per camera, like one extra viewer, and only while someone watches (on demand) or when recording is switched on |
| Reads a still frame now and then for analysis | One short RTSP grab per analysis interval per camera (default one a minute), limited per minute for the camera grid | A brief session per grab; the interval and the limit are settings |
| Reads your events | A read-only login to your VMS or recorder events (Hikvision, Dahua, ONVIF, or a connector for your system), or you push events to the platform | One event connection per system; polling at your VMS's pace, with a minimum gap |
| Lists your cameras | A read of the camera list (names, ids, online state) | A request at start-up and when it changes |

## What it never does

- It **never writes** to your system: no configuration, no PTZ control, no deletion, no recording control. The connectors are read-only by design (`docs/connectors-vms.md`). Credentials you
  give are used for reading and are stored sealed (`docs/security-architecture.md`).
- It **never takes over your recording**. In the federation profile your system remains the video store; the platform keeps metadata (events, alerts, plate reads, tags) and tells people
  when your retention means video is probably no longer held (`docs/federated-report.md`).
- It **never shares your video with another department** unless you give them access to the cameras: another department sees your events only as counts (reports, trails) and the fact that
  an incident that involves you exists. Video access follows department scope when per-user video access is on (`docs/security-architecture.md` 3.2).
- It **never requires your system to change**: nothing to install, no firewall opening toward you beyond the read access you grant, no software on your recorders.
- It **never hides what it did**: every use of a sensitive permission and every refusal is in the access log, and your cameras' events are visible to your own users with the roles you set.

## What a department can verify

1. **Look at your own system's logs.** Every connection the platform makes comes from the addresses you gave it permission for; with a read-only account, any write would be refused by your own system.
2. **Count the streams.** One pull per camera at the media server; watch your NVR's connection list while ten people view one camera.
3. **Ask for the access log** for your cameras (an auditor's sealed export: `GET /api/access-log/export`).
4. **Revoke at any time.** Disable the federation client or the system in the platform, or the account on your side: the platform stops at once and keeps nothing it cannot explain (events already stored remain; they
   are metadata about your cameras, which you may ask to have removed).
5. **Test in a lab first.** The reference department systems used in the tests (`tests/lab/fakeVms.ts`) show exactly what is sent and asked.

## What can still affect you (said plainly)

- **Connection limits.** A recorder that allows only a few simultaneous connections can refuse a second one. The platform keeps its connections few, but it cannot know your limit: tell us.
  **There is no per-system connection cap yet** (only a minimum gap between calls and one runner per system), so a limit like that has to be handled by giving the platform a read-only account on a
  system that can take it, or by adding the cap. This is the main thing that has not been checked against real devices.
- **Analysis cadence.** If you set a short analysis interval for many cameras, the grabs add up on your camera network; the platform spreads them out and limits them per minute, but the numbers
  are yours to choose.
- **Time and format differences.** Vendors report times and plate formats in their own ways. Expect to adjust the mapping on first contact with each make, and tell us what you see.
- **Retention.** If your system keeps video for 7 days and an incident is found on day 9, the video is gone on your side. The platform says so; it does not and cannot bring it back.
