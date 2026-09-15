export type QualityId = 'max' | 'high' | 'balanced' | 'saver';

export interface QualityPreset {
  id: QualityId;
  label: string;
  sublabel: string;
  width: number;
  height: number;
  frameRate: number;
  videoBitrate: number;
}

export type FacingMode = 'environment' | 'user';

export interface Settings {
  preRollSec: number;
  postRollSec: number;
  quality: QualityId;
  facing: FacingMode;
  micEnabled: boolean;
}

export interface RawSegment {
  index: number;
  blob: Blob;
  startTs: number;
  endTs: number;
}

export interface CaptureJob {
  id: string;
  startTs: number;
  endTs: number;
  createdAt: number;
  mergedCount: number;
  status: 'buffering' | 'exporting' | 'done' | 'error';
}

export interface ClipRecord {
  id: string;
  blob: Blob;
  mimeType: string;
  createdAt: number;
  durationMs: number;
  sizeBytes: number;
  preRollSec: number;
  postRollSec: number;
  mergedCount: number;
}
