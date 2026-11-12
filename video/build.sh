#!/usr/bin/env bash
# Builds the explainer video for one language or both:  ./build.sh [en|hi]...
# Needs: python3 with edge-tts (pip install edge-tts), ffmpeg, node with playwright and its Chromium.
# Result in out/<lang>/: omnicamera-explainer-<lang>.mp4 (with both subtitle tracks inside, switched off by default),
# voiceover.wav, en.srt and hi.srt (timed to that language's narration), timeline.json.
set -euo pipefail
cd "$(dirname "$0")"
FPS=30
for lang in "${@:-en hi}"; do for l in $lang; do
  other=$([ "$l" = en ] && echo hi || echo en)
  python3 build_audio.py "$l"
  rm -rf ".frames/$l"
  node render.cjs "$l" --fps $FPS
  ffmpeg -y -v error -framerate $FPS -i ".frames/$l/f%05d.jpg" -i "out/$l/voiceover.wav" -i "out/$l/$l.srt" -i "out/$l/$other.srt" \
    -map 0:v -map 1:a -map 2 -map 3 \
    -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
    -c:a aac -b:a 160k -c:s mov_text \
    -metadata:s:a:0 language=$([ "$l" = en ] && echo eng || echo hin) \
    -metadata:s:s:0 language=$([ "$l" = en ] && echo eng || echo hin) -metadata:s:s:1 language=$([ "$other" = en ] && echo eng || echo hin) \
    -disposition:s:0 0 -disposition:s:1 0 -movflags +faststart -shortest "out/$l/omnicamera-explainer-$l.mp4"
  rm -rf ".frames/$l"
  echo "built out/$l/omnicamera-explainer-$l.mp4"
done; done
