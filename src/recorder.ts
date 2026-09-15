import type { RawSegment } from './types';

/** Every segment is recorded as its own complete, independently-playable file
 * (MediaRecorder is stopped and restarted on a timer) so segments can later
 * be concatenated with ffmpeg's stream-copy concat demuxer without
 * re-encoding — that's what keeps exports fast and lossless. */
export class SegmentedRecorder {
  private stopping = false;
  private current: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextIndex = 0;

  constructor(
    private stream: MediaStream,
    private mimeType: string,
    private videoBitsPerSecond: number,
    private segmentMs: number,
    private onSegment: (seg: RawSegment) => void,
    private onError: (err: unknown) => void
  ) {}

  start(): void {
    this.stopping = false;
    this.runSegment();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.current && this.current.state !== 'inactive') {
      this.current.stop();
    }
    this.current = null;
  }

  private runSegment(): void {
    if (this.stopping) return;

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, {
        mimeType: this.mimeType,
        videoBitsPerSecond: this.videoBitsPerSecond
      });
    } catch (err) {
      this.onError(err);
      return;
    }

    const chunks: BlobPart[] = [];
    const startTs = Date.now();
    const index = this.nextIndex++;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (e) => this.onError(e);
    recorder.onstop = () => {
      const endTs = Date.now();
      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: this.mimeType });
        this.onSegment({ index, blob, startTs, endTs });
      }
      if (!this.stopping) this.runSegment();
    };

    this.current = recorder;
    recorder.start();
    this.timer = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, this.segmentMs);
  }
}
