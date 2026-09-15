# ReplayCam

An always-buffering "instant replay" camera for your phone's browser. Start a
session and it continuously records at the best quality/fps your camera can
do; tap the shutter and it saves the moments **before** and **after** the tap
as one clip — no need to hit record before something happens.

- Default: **15s before**, **10s after** the tap (both adjustable, 0–60s).
- Tap again before a clip finishes and the two windows **merge into one
  longer clip** instead of producing two files.
- Quality presets from 720p30 up to 4K60, picked automatically down a notch
  if your camera/browser can't deliver the top one.
- Clips save to on-device storage (IndexedDB) with a gallery to play,
  download, share, or delete them.
- Keeps the screen awake for the length of a session (where the browser
  supports the Wake Lock API).

## How it works

1. **Segmented recording.** `MediaRecorder` is restarted on a rolling
   1-second timer instead of run continuously. Every segment is therefore a
   small, independently-valid video file.
2. **Ring buffer.** Segments older than the configured pre-roll are dropped;
   everything else is kept in memory.
3. **Tap to capture.** Marks a window of `[now - preRoll, now + postRoll]`.
   The app waits for that window to finish recording, then hands the
   overlapping segments to `ffmpeg.wasm`, which **stream-copies** (no
   re-encode) and concatenates them into a single output file — so exported
   quality is identical to what the camera captured, and export is fast.
4. **Merging.** A new tap that overlaps an in-flight capture extends that
   capture's window instead of starting a second one.

See [`src/buffer-manager.ts`](src/buffer-manager.ts) for the merge/export
state machine and [`src/recorder.ts`](src/recorder.ts) for the segmented
recorder.

## Important limitation: backgrounding

Browsers (iOS Safari in particular) suspend camera capture when the tab is
fully backgrounded or the screen locks — there is no way around this from a
web app. ReplayCam keeps the screen awake automatically during a session to
minimize this, but **keep the tab in the foreground** for reliable buffering.
A true always-on-even-when-locked background recorder needs a native app
(AVFoundation on iOS / CameraX on Android), which is a separate, much larger
build — ask if you want that version too.

## Running it

Requires Node 18+.

```bash
npm install   # also copies the ffmpeg.wasm core into public/ffmpeg and needs
              # rsvg-convert on PATH the first time you run `npm run icons`
npm run icons # generates PNG app icons from public/icon.svg (needs rsvg-convert:
              # `brew install librsvg`)
npm run dev   # starts the Vite dev server
```

Camera access requires a **secure context** (HTTPS, or `localhost`). To test
on your phone over your LAN, either:

- Use a tunnel (e.g. `npx localtunnel --port 5173` or `ngrok http 5173`), or
- Open the deployed GitHub Pages URL below directly from your phone.

### GitHub Pages

Pushing to `main` builds and deploys automatically via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) to
`https://<github-user>.github.io/replaycam/`. One-time setup in the repo's
GitHub settings: **Settings → Pages → Source → GitHub Actions**.

The build passes `PAGES_BASE=/replaycam/` so all asset paths and the PWA
manifest's `start_url`/`scope`/icons resolve under that subpath (see
`vite.config.ts`). A plain local `npm run build` still targets `/`.

Add it to your home screen from the browser's share sheet for a fullscreen,
app-like experience (it's a installable PWA).

## Project layout

```
src/
  camera.ts          getUserMedia + quality presets + demo-pattern fallback
  recorder.ts         segmented MediaRecorder engine
  buffer-manager.ts   ring buffer, capture/merge state machine
  export.ts            ffmpeg.wasm stream-copy concat
  storage.ts           IndexedDB clip storage
  wakelock.ts           Screen Wake Lock wrapper
  main.ts               UI + wiring
  style.css              design system
scripts/
  make-icons.mjs         SVG -> PNG app icons
  copy-ffmpeg-core.mjs   vendors the ffmpeg.wasm core into public/ffmpeg
```
