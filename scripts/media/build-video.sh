#!/bin/sh
# Build docs/media/portalforge-demo.mp4 from the recording made by scripts/media/record-demo.ts.
set -eu
RAW=docs/media/raw
FPS=15
START=$(python3 -c "import json;print(json.load(open('$RAW/timeline.json'))['trimStart'])")
python3 - "$RAW" "$START" <<'PY'
import json, sys, wave
raw, start = sys.argv[1], float(sys.argv[2])
t = json.load(open(f"{raw}/timeline.json"))
rate, width = 22050, 2
frames_total = 0
import os
nframes = len([f for f in os.listdir(f"{raw}/frames") if f.endswith('.jpg')])
length = nframes / 15
buf = bytearray(int(length * rate) * width)
for s in t['scenes']:
    w = wave.open(f"{raw}/narration/{s['id']}.wav"); data = w.readframes(w.getnframes()); w.close()
    off = int((s['start'] - start) * rate) * width
    end = min(len(buf), off + len(data)); buf[off:end] = data[: end - off]
out = wave.open(f"{raw}/narration.wav", 'wb'); out.setnchannels(1); out.setsampwidth(width); out.setframerate(rate); out.writeframes(bytes(buf)); out.close()
print(f"narration track {length:.1f}s")
PY
swift scripts/media/compose.swift "$RAW/frames" $FPS "$RAW/narration.wav" docs/media/portalforge-demo.mp4
