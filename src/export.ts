import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import type { RawSegment } from './types';

const LOAD_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_MS = 60_000;

let ffmpegPromise: Promise<FFmpeg> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
      const base = `${location.origin}${import.meta.env.BASE_URL}ffmpeg`;
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm')
      ]);
      await withTimeout(
        ffmpeg.load({ coreURL, wasmURL }),
        LOAD_TIMEOUT_MS,
        'Video processor took too long to load. Check your connection and try again.'
      );
      return ffmpeg;
    })().catch((err) => {
      // Don't cache a failed load — the next capture attempt should retry
      // from scratch instead of repeating the same stale rejection forever.
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

/** Fire-and-forget warm-up so the (lazily loaded, several-MB) ffmpeg core is
 * ready by the time the user actually saves a clip. */
export function preloadFFmpeg(): void {
  getFFmpeg().catch(() => {
    /* surfaced properly on first real export attempt */
  });
}

function extFromMime(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/**
 * Losslessly concatenates the given segments (already sorted, already
 * trimmed to the segments that overlap the capture window) into a single
 * playable file using ffmpeg's concat demuxer with stream copy — no
 * re-encoding, so quality exactly matches what the camera captured.
 */
export async function concatSegments(
  segments: RawSegment[],
  mimeType: string,
  onLog?: (msg: string) => void
): Promise<Blob> {
  if (segments.length === 0) throw new Error('No segments to export');
  const ext = extFromMime(mimeType);
  const ffmpeg = await getFFmpeg(onLog);

  const jobId = Math.random().toString(36).slice(2, 8);
  const cleanup: string[] = [];
  const rmAll = async () => {
    for (const n of cleanup) {
      try {
        await ffmpeg.deleteFile(n);
      } catch {
        /* best effort cleanup */
      }
    }
  };

  const run = async (): Promise<Blob> => ext === 'mp4' ? concatMp4(ffmpeg, segments, jobId, cleanup, mimeType) : concatSimple(ffmpeg, segments, ext, jobId, cleanup, mimeType);

  try {
    return await withTimeout(run(), EXEC_TIMEOUT_MS, 'Saving that clip took too long and was cancelled.');
  } finally {
    await rmAll();
  }
}

/** webm/vp9 segments concatenate cleanly with a plain stream-copy concat. */
async function concatSimple(
  ffmpeg: FFmpeg,
  segments: RawSegment[],
  ext: string,
  jobId: string,
  cleanup: string[],
  mimeType: string
): Promise<Blob> {
  const names: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const name = `in_${jobId}_${i}.${ext}`;
    await ffmpeg.writeFile(name, new Uint8Array(await segments[i].blob.arrayBuffer()));
    names.push(name);
    cleanup.push(name);
  }
  const listName = `list_${jobId}.txt`;
  await ffmpeg.writeFile(listName, names.map((n) => `file '${n}'`).join('\n'));
  cleanup.push(listName);

  const outName = `out_${jobId}.${ext}`;
  cleanup.push(outName);
  await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', outName]);

  const data = (await ffmpeg.readFile(outName)) as Uint8Array;
  return new Blob([data as unknown as BlobPart], { type: mimeType });
}

/**
 * mp4/h264 segments are each their own independent recording, so their
 * SPS/PPS (codec description) can differ slightly between segments even at
 * identical settings — mp4's concat demuxer with `-c copy` requires an
 * exact match and can produce a broken file otherwise. The standard fix:
 * remux each segment through MPEG-TS (which repeats SPS/PPS in-stream
 * instead of relying on one global copy), concatenate the TS byte streams,
 * then remux once back to mp4 — still a lossless stream copy throughout.
 */
async function concatMp4(
  ffmpeg: FFmpeg,
  segments: RawSegment[],
  jobId: string,
  cleanup: string[],
  mimeType: string
): Promise<Blob> {
  const tsNames: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const inName = `in_${jobId}_${i}.mp4`;
    const tsName = `seg_${jobId}_${i}.ts`;
    await ffmpeg.writeFile(inName, new Uint8Array(await segments[i].blob.arrayBuffer()));
    cleanup.push(inName, tsName);
    await ffmpeg.exec(['-i', inName, '-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'mpegts', tsName]);
    tsNames.push(tsName);
  }

  const outName = `out_${jobId}.mp4`;
  cleanup.push(outName);
  await ffmpeg.exec([
    '-i',
    `concat:${tsNames.join('|')}`,
    '-c',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    '-movflags',
    'faststart',
    outName
  ]);

  const data = (await ffmpeg.readFile(outName)) as Uint8Array;
  return new Blob([data as unknown as BlobPart], { type: mimeType });
}
