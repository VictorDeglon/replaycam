import type { CaptureJob, RawSegment } from './types';
import { concatSegments } from './export';

const SEGMENT_MARGIN_MS = 1500;
const JOB_POLL_MS = 200;

export interface BufferManagerOptions {
  mimeType: string;
  getPreRollMs: () => number;
  onJobUpdate: (job: CaptureJob) => void;
  onClipExported: (job: CaptureJob, blob: Blob) => void;
  onExportError: (job: CaptureJob, err: unknown) => void;
  onBufferChange: (bufferedMs: number, bufferedBytes: number) => void;
}

/**
 * Owns the rolling pre-roll buffer of recorded segments and turns "capture"
 * requests into exported clips. Overlapping requests (a second tap before
 * the first clip's post-roll has finished) are merged into a single longer
 * clip rather than producing two files, per the product spec.
 */
export class BufferManager {
  private segments: RawSegment[] = [];
  private jobs: CaptureJob[] = [];
  private pollTimer: ReturnType<typeof setInterval>;

  constructor(private opts: BufferManagerOptions) {
    this.pollTimer = setInterval(() => this.checkJobs(), JOB_POLL_MS);
  }

  addSegment(seg: RawSegment): void {
    this.segments.push(seg);
    this.trim();
    this.checkJobs();
    this.reportBuffer();
  }

  capture(preMs: number, postMs: number): CaptureJob {
    const now = Date.now();
    const startTs = now - preMs;
    const endTs = now + postMs;

    const existing = this.jobs.find((j) => j.status === 'buffering' && startTs <= j.endTs);
    if (existing) {
      existing.startTs = Math.min(existing.startTs, startTs);
      existing.endTs = Math.max(existing.endTs, endTs);
      existing.mergedCount += 1;
      this.opts.onJobUpdate(existing);
      return existing;
    }

    const job: CaptureJob = {
      id: crypto.randomUUID(),
      startTs,
      endTs,
      createdAt: now,
      mergedCount: 1,
      status: 'buffering'
    };
    this.jobs.push(job);
    this.opts.onJobUpdate(job);
    return job;
  }

  bufferedMs(): number {
    if (this.segments.length === 0) return 0;
    return this.segments[this.segments.length - 1].endTs - this.segments[0].startTs;
  }

  getActiveJobs(): CaptureJob[] {
    return this.jobs.filter((j) => j.status === 'buffering' || j.status === 'exporting');
  }

  /** Force any still-buffering jobs to export immediately with whatever
   * post-roll footage has been captured so far, instead of waiting for their
   * full window — used when the session is stopped (or the camera is about
   * to restart) with a capture still pending. */
  flushPending(): void {
    for (const job of this.jobs) {
      if (job.status === 'buffering') {
        job.endTs = Math.min(job.endTs, Date.now());
        job.status = 'exporting';
        this.opts.onJobUpdate(job);
        void this.exportJob(job);
      }
    }
  }

  destroy(): void {
    clearInterval(this.pollTimer);
  }

  private trim(): void {
    const now = Date.now();
    const cutoff = now - (this.opts.getPreRollMs() + SEGMENT_MARGIN_MS);
    const pendingStarts = this.jobs.filter((j) => j.status === 'buffering').map((j) => j.startTs);
    const keepFrom = pendingStarts.length > 0 ? Math.min(cutoff, ...pendingStarts) : cutoff;
    this.segments = this.segments.filter((s) => s.endTs >= keepFrom);
  }

  private reportBuffer(): void {
    const bytes = this.segments.reduce((sum, s) => sum + s.blob.size, 0);
    this.opts.onBufferChange(this.bufferedMs(), bytes);
  }

  private checkJobs(): void {
    const now = Date.now();
    for (const job of this.jobs) {
      if (job.status === 'buffering' && now >= job.endTs) {
        job.status = 'exporting';
        this.opts.onJobUpdate(job);
        void this.exportJob(job);
      }
    }
    this.jobs = this.jobs.filter((j) => j.status === 'buffering' || j.status === 'exporting');
  }

  private async exportJob(job: CaptureJob): Promise<void> {
    const overlapping = this.segments
      .filter((s) => s.endTs > job.startTs && s.startTs < job.endTs)
      .sort((a, b) => a.index - b.index);

    try {
      const blob = await concatSegments(overlapping, this.opts.mimeType);
      job.status = 'done';
      this.opts.onJobUpdate(job);
      this.opts.onClipExported(job, blob);
    } catch (err) {
      job.status = 'error';
      this.opts.onJobUpdate(job);
      this.opts.onExportError(job, err);
    } finally {
      this.trim();
    }
  }
}
