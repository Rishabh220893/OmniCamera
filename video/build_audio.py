#!/usr/bin/env python3
"""Voice-over, timeline and subtitles for the explainer.

  python3 build_audio.py en|hi

Reads script.json, speaks each cue with edge-tts (the voice and rate set there), lays the cues end to end and writes, in out/<lang>/:
  voiceover.wav   the narration alone
  timeline.json   when each cue and scene starts and ends (the picture is drawn from this)
  <lang>.srt      subtitles that match the narration
  <other>.srt     the same cue times with the other language's text
Spoken cues are cached in .cache/, so editing one line re-speaks only that line.
"""
import asyncio, hashlib, json, os, subprocess, sys
from pathlib import Path
import edge_tts

HERE = Path(__file__).parent
LEAD, CUE_GAP, SCENE_GAP, TAIL = 0.5, 0.18, 0.45, 2.2   # seconds

def dur(p):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)]))

async def speak(text, voice, rate, out):
    for attempt in range(4):
        try:
            await edge_tts.Communicate(text, voice, rate=rate, proxy=os.environ.get('HTTPS_PROXY')).save(str(out))
            if out.stat().st_size > 0: return
        except Exception as e:
            err = e
        await asyncio.sleep(2 * (attempt + 1))
    raise SystemExit(f'could not speak: {text[:40]}... ({err})')

def stamp(t):
    ms = round(t * 1000); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f'{h:02}:{m:02}:{s:02},{ms:03}'

def srt(cues, lang):
    return ''.join(f"{i}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c[lang]}\n\n" for i, c in enumerate(cues, 1))

async def main(lang):
    sc = json.loads((HERE / 'script.json').read_text())
    voice, rate = sc['voices'][lang], sc['rate']
    cache = HERE / '.cache'; cache.mkdir(exist_ok=True)
    out = HERE / 'out' / lang; out.mkdir(parents=True, exist_ok=True)
    t, cues, scenes, parts = LEAD, [], [], []
    for si, scene in enumerate(sc['scenes']):
        s_start = 0.0 if si == 0 else t - SCENE_GAP / 2
        for ci, cue in enumerate(scene['cues']):
            say = cue.get(lang + '_say', cue[lang])
            key = hashlib.sha1(f'{voice}|{rate}|{say}'.encode()).hexdigest()[:16]
            mp3, wav = cache / f'{key}.mp3', cache / f'{key}.wav'
            if not wav.exists():
                await speak(say, voice, rate, mp3)
                # trim the silence the service pads each clip with, so the gaps are the ones set above
                subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(mp3), '-af',
                                'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
                                '-ar', '48000', '-ac', '1', str(wav)], check=True)
            d = dur(wav)
            cues.append({'id': cue['id'], 'scene': scene['id'], 'start': round(t, 3), 'end': round(t + d, 3), 'en': cue['en'], 'hi': cue['hi']})
            parts.append((t, wav))
            t += d + (CUE_GAP if ci < len(scene['cues']) - 1 else SCENE_GAP)
        scenes.append({'id': scene['id'], 'start': round(s_start, 3)})
    total = round(t - SCENE_GAP + TAIL, 3)
    for i, s in enumerate(scenes):
        s['end'] = scenes[i + 1]['start'] if i + 1 < len(scenes) else total
    # one track: each clip delayed to its start
    cmd = ['ffmpeg', '-y', '-v', 'error']
    for _, w in parts: cmd += ['-i', str(w)]
    filt = ''.join(f'[{i}]adelay={round(s * 1000)}[a{i}];' for i, (s, _) in enumerate(parts))
    filt += ''.join(f'[a{i}]' for i in range(len(parts))) + f'amix=inputs={len(parts)}:normalize=0,apad=whole_dur={total},loudnorm=I=-16:TP=-1.5:LRA=11[o]'
    subprocess.run(cmd + ['-filter_complex', filt, '-map', '[o]', '-ar', '48000', '-t', str(total), str(out / 'voiceover.wav')], check=True)
    (out / 'timeline.json').write_text(json.dumps({'lang': lang, 'total': total, 'scenes': scenes, 'cues': cues}, ensure_ascii=False, indent=1))
    other = 'hi' if lang == 'en' else 'en'
    (out / f'{lang}.srt').write_text(srt(cues, lang), encoding='utf-8')
    (out / f'{other}.srt').write_text(srt(cues, other), encoding='utf-8')
    words = sum(len(c[lang].split()) for c in cues)
    print(f'{lang}: {len(cues)} cues, {words} words, {total:.1f} s')
    for s in scenes: print(f"  {s['id']} {s['start']:6.1f} - {s['end']:6.1f}")

asyncio.run(main(sys.argv[1]))
