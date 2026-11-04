#!/usr/bin/env python3
"""Joins the V3 footage (raw-testnet) with the local fault scene and intro (raw) into docs/media/portalforge-demo.mp4.
The wait for finality in the job scene is sped up, and the narration says so."""
import json, os, shutil, subprocess, wave

LOCAL, V3, V3T1, OUT = 'docs/media/raw', 'docs/media/raw-testnet', 'docs/media/raw-testnet-t1', 'docs/media/raw-final'
FPS = 15
ORDER = [(LOCAL, '01-overview'), (LOCAL, '02-network'), (LOCAL, '03-deploy'), (V3T1, 't1-deployed'), (V3, 't2-job'), (V3, 't3-evidence'), (LOCAL, '06-fault'), (V3, 't4-close')]
JOB_TEXT = 'Now a real job. A requestJob transaction goes to V3. The indexer records the event and its native Revive twin, and the workflow waits for finality. It calls the service, sends completeJob from a low-privilege executor, and registers evidence. Every step keeps its real transaction hash and block. The wait for finality is sped up in this video.'

shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(f'{OUT}/frames'); os.makedirs(f'{OUT}/narration')
subprocess.run(['say', '-v', 'Samantha', '-r', '172', '--file-format=WAVE', '--data-format=LEI16@22050', '-o', f'{OUT}/narration/t2-job.wav', JOB_TEXT], check=True)

def scenes(raw):
    t = json.load(open(f'{raw}/timeline.json'))
    frames = len([f for f in os.listdir(f'{raw}/frames') if f.endswith('.jpg')])
    out = {}
    for i, s in enumerate(t['scenes']):
        a = int((s['start'] - t['trimStart']) * FPS)
        b = int((t['scenes'][i + 1]['start'] - t['trimStart']) * FPS) if i + 1 < len(t['scenes']) else frames
        out[s['id']] = (a, min(b, frames))
    return out
ranges = {LOCAL: scenes(LOCAL), V3: scenes(V3), V3T1: scenes(V3T1)}

def wav_of(raw, sid):
    own = f'{OUT}/narration/{sid}.wav'
    return own if os.path.exists(own) else f'{raw}/narration/{sid}.wav'
def seconds(f):
    w = wave.open(f); d = w.getnframes() / w.getframerate(); w.close(); return d

n = 0; rate = 22050; audio = []; report = []
for raw, sid in ORDER:
    a, b = ranges[raw][sid]
    voice = seconds(wav_of(raw, sid))
    real = (b - a) / FPS
    target = min(real, voice + 2.0) if sid == 't2-job' else real
    count = int(target * FPS)
    start = n / FPS
    for k in range(count):
        src = a + int(k * (b - a) / count)
        os.link(f'{raw}/frames/{src:05d}.jpg', f'{OUT}/frames/{n:05d}.jpg'); n += 1
    audio.append((start, wav_of(raw, sid)))
    report.append({'scene': sid, 'start': round(start, 1), 'seconds': round(target, 1), 'realSeconds': round(real, 1), 'source': 'V3 testnet' if raw in (V3, V3T1) else 'local Anvil' if sid != '02-network' else 'live V3 samples'})

buf = bytearray(int(n / FPS * rate) * 2)
for start, f in audio:
    w = wave.open(f); data = w.readframes(w.getnframes()); w.close()
    off = int(start * rate) * 2; end = min(len(buf), off + len(data)); buf[off:end] = data[:end - off]
out = wave.open(f'{OUT}/narration.wav', 'wb'); out.setnchannels(1); out.setsampwidth(2); out.setframerate(rate); out.writeframes(bytes(buf)); out.close()
json.dump({'seconds': round(n / FPS, 1), 'scenes': report}, open(f'{OUT}/timeline.json', 'w'), indent=1)
print(json.dumps({'seconds': round(n / FPS, 1), 'scenes': report}))
if n / FPS > 180: raise SystemExit('video longer than 3 minutes')
subprocess.run(['swift', 'scripts/media/compose.swift', f'{OUT}/frames', str(FPS), f'{OUT}/narration.wav', 'docs/media/portalforge-demo.mp4'], check=True)
