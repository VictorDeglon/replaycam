import type { FacingMode, QualityId, QualityPreset } from './types';

export const QUALITY_PRESETS: QualityPreset[] = [
  { id: 'max', label: 'Max', sublabel: '4K · 60fps', width: 3840, height: 2160, frameRate: 60, videoBitrate: 50_000_000 },
  { id: 'high', label: 'High', sublabel: '1080p · 60fps', width: 1920, height: 1080, frameRate: 60, videoBitrate: 16_000_000 },
  { id: 'balanced', label: 'Balanced', sublabel: '1080p · 30fps', width: 1920, height: 1080, frameRate: 30, videoBitrate: 8_000_000 },
  { id: 'saver', label: 'Data saver', sublabel: '720p · 30fps', width: 1280, height: 720, frameRate: 30, videoBitrate: 4_000_000 }
];

export function getPreset(id: QualityId): QualityPreset {
  return QUALITY_PRESETS.find((p) => p.id === id) ?? QUALITY_PRESETS[1];
}

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];

export function pickMimeType(): string {
  for (const candidate of MIME_CANDIDATES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return 'video/webm';
}

export interface CameraResult {
  stream: MediaStream;
  preset: QualityPreset;
  demo: boolean;
  fallbackNote: string | null;
}

async function tryGetUserMedia(preset: QualityPreset, facing: FacingMode, mic: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: facing,
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate }
    },
    audio: mic
  });
}

/**
 * Requests the camera at the given preset, stepping down through lower
 * presets if the device/browser can't deliver it. Falls back to a synthetic
 * canvas "demo" stream if no camera is available at all (e.g. desktop
 * testing, permission denied), so the rest of the app remains usable.
 */
export async function startCamera(
  qualityId: QualityId,
  facing: FacingMode,
  mic: boolean
): Promise<CameraResult> {
  const startIdx = QUALITY_PRESETS.findIndex((p) => p.id === qualityId);
  const order = QUALITY_PRESETS.slice(startIdx < 0 ? 0 : startIdx);

  let lastError: unknown = null;
  for (let i = 0; i < order.length; i++) {
    try {
      const stream = await tryGetUserMedia(order[i], facing, mic);
      const fallbackNote = i > 0 ? `Camera doesn't support ${order[0].sublabel}. Using ${order[i].sublabel}.` : null;
      return { stream, preset: order[i], demo: false, fallbackNote };
    } catch (err) {
      lastError = err;
    }
  }

  // No usable camera — fall back to a demo pattern so the buffer/export
  // pipeline can still be exercised (also useful on desktop dev machines).
  const preset = order[order.length - 1];
  const stream = createDemoStream(preset);
  const reason = lastError instanceof Error ? lastError.message : 'no camera available';
  return {
    stream,
    preset,
    demo: true,
    fallbackNote: `No camera access (${reason}). Showing a demo pattern instead.`
  };
}

export function createDemoStream(preset: QualityPreset): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(preset.width, 1280);
  canvas.height = Math.min(preset.height, 720);
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;

  let raf = 0;
  const start = performance.now();
  function draw() {
    const t = (performance.now() - start) / 1000;
    const hue = (t * 40) % 360;
    ctx.fillStyle = `hsl(${hue}, 55%, 12%)`;
    ctx.fillRect(0, 0, w, h);

    const r = Math.min(w, h) * 0.18;
    const cx = w / 2 + Math.cos(t) * w * 0.28;
    const cy = h / 2 + Math.sin(t * 1.3) * h * 0.28;
    ctx.fillStyle = `hsl(${(hue + 180) % 360}, 70%, 60%)`;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `${Math.round(h * 0.06)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('DEMO PATTERN — no camera detected', w / 2, h * 0.12);
    ctx.font = `${Math.round(h * 0.045)}px -apple-system, system-ui, sans-serif`;
    ctx.fillText(new Date().toLocaleTimeString(), w / 2, h * 0.9);

    raf = requestAnimationFrame(draw);
  }
  draw();

  const stream = canvas.captureStream(preset.frameRate);
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => cancelAnimationFrame(raf));

  // Silent audio track so the recorder pipeline behaves the same as with a real mic.
  try {
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(dest);
    osc.start();
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  } catch {
    // Audio context unavailable — demo stream just won't have an audio track.
  }

  return stream;
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}
