# Explainer video

A two-minute explainer of the platform, with an English and a Hindi narration (Indian female voices at 1.15x speed).

| File | What |
|---|---|
| `out/en/omnicamera-explainer-en.mp4` | English narration. Both subtitle tracks are inside the file, switched off by default. |
| `out/hi/omnicamera-explainer-hi.mp4` | Hindi narration, same picture re-timed to it. |
| `out/<lang>/en.srt`, `out/<lang>/hi.srt` | Subtitles timed to that video's narration, in both languages. Plain text: edit them in any editor. |
| `out/<lang>/voiceover.wav` | The narration alone, for remixing with music. |

The on-screen text is English in both videos. There is no music.

## Changing it

- **The words:** `script.json`. Each cue has `en` and `hi` (what the subtitle shows) and optionally `en_say` / `hi_say`
  (what the voice is given, where an abbreviation needs spelling out). The voices and the speed (`rate`) are at the top.
- **The picture:** `explainer.html`. Each element says when it appears relative to a cue (`data-a="up@c5%40"` is 40% through
  cue `c5`), so it follows whichever narration is used.
- **Rebuild:** `./build.sh` (both) or `./build.sh en`. It needs `pip install edge-tts`, ffmpeg, and node with Playwright's
  Chromium. The narration is spoken by Microsoft's online voices (`speech.platform.bing.com`), so the script text is sent there.
- Editing only an `.srt` needs no rebuild; to put the edited subtitles back inside the mp4:
  `ffmpeg -i in.mp4 -i en.srt -i hi.srt -map 0:v -map 0:a -map 1 -map 2 -c copy -c:s mov_text out.mp4`.

## What it shows, and what is illustrative

The screens are drawn for the video in the app's style; they are not recordings of the running app. The plate, camera names,
route and figures are examples. The features named are the ones described in `docs/` (Full Panel tracking, vehicle trail,
analyzers, rules and alert channels, registry and map, federation, incidents, walls, gateways). The VAHAN and police-record
connectors are mock connectors behind a contract (`docs/connectors.md`), which is why the video says "ready for".
