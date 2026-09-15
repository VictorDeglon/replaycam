import './style.css';
import { QUALITY_PRESETS, getPreset, pickMimeType, startCamera, stopStream } from './camera';
import { SegmentedRecorder } from './recorder';
import { BufferManager } from './buffer-manager';
import { saveClip, listClips, deleteClip } from './storage';
import { WakeLockGuard } from './wakelock';
import { preloadFFmpeg } from './export';
import { ICONS } from './icons';
import type { CaptureJob, ClipRecord, FacingMode, QualityId, Settings } from './types';

const SEGMENT_MS = 1000;
const SETTINGS_KEY = 'replaycam:settings:v1';

const DEFAULT_SETTINGS: Settings = {
  preRollSec: 15,
  postRollSec: 10,
  quality: 'max',
  facing: 'environment',
  micEnabled: true
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* ignore malformed storage */
  }
  return { ...DEFAULT_SETTINGS };
}

function persistSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

function fmtSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

function fmtClipDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function extFromMime(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

interface ToastOpts {
  kind?: 'success' | 'error' | 'info';
  duration?: number;
}

class App {
  settings = loadSettings();
  mimeType = pickMimeType();
  activePreset = getPreset(this.settings.quality);

  stream: MediaStream | null = null;
  recorder: SegmentedRecorder | null = null;
  bufferMgr: BufferManager | null = null;
  wakeLock = new WakeLockGuard();

  live = false;
  demo = false;
  sessionStartedAt = 0;
  sessionTimer: ReturnType<typeof setInterval> | null = null;
  pendingTicker: ReturnType<typeof setInterval> | null = null;
  currentJobId: string | null = null;

  clips: ClipRecord[] = [];
  clipUrls = new Map<string, string>();

  root = document.getElementById('app')!;
  video = el('video');
  startScreen = el('div', 'start-screen');
  topbar = el('div', 'topbar');
  statusPill = el('div', 'status-pill');
  bufferPill = el('div', 'buffer-pill');
  galleryBtn = el('button', 'side-btn right', ICONS.gallery);
  galleryBadge = el('span', 'badge');
  shutterWrap = el('div', 'shutter-wrap');
  shutterFill = el('div', 'shutter-fill');
  pendingLabel = el('div', 'pending-label');
  toastStack = el('div', 'toast-stack');
  shutterFlashEl = el('div', 'shutter-flash');
  bufferRingFg!: SVGCircleElement;

  settingsSheet: HTMLElement | null = null;
  gallerySheet: HTMLElement | null = null;
  playerModal: HTMLElement | null = null;

  async init(): Promise<void> {
    this.buildShell();
    this.renderStartScreen();
    this.clips = await listClips().catch(() => []);
    this.updateGalleryBadge();
    preloadFFmpeg();
  }

  // ---------------------------------------------------------------- shell

  private buildShell(): void {
    const stage = el('div', 'stage');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    stage.append(
      this.video,
      el('div', 'scrim-top'),
      el('div', 'scrim-bottom'),
      this.shutterFlashEl,
      this.buildTopbar(),
      this.buildControls(),
      this.toastStack
    );
    this.root.append(stage, this.startScreen);
  }

  private buildTopbar(): HTMLElement {
    this.statusPill.append(el('span', 'status-dot'), el('span', undefined, 'Off'));

    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as SVGSVGElement;
    ring.setAttribute('viewBox', '0 0 16 16');
    ring.setAttribute('class', 'ring');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('cx', '8');
    track.setAttribute('cy', '8');
    track.setAttribute('r', '6.5');
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'rgba(255,255,255,0.18)');
    track.setAttribute('stroke-width', '2.5');
    const fg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    fg.setAttribute('cx', '8');
    fg.setAttribute('cy', '8');
    fg.setAttribute('r', '6.5');
    fg.setAttribute('fill', 'none');
    fg.setAttribute('stroke', 'var(--good)');
    fg.setAttribute('stroke-width', '2.5');
    fg.setAttribute('stroke-linecap', 'round');
    fg.setAttribute('transform', 'rotate(-90 8 8)');
    const circumference = 2 * Math.PI * 6.5;
    fg.setAttribute('stroke-dasharray', `${circumference}`);
    fg.setAttribute('stroke-dashoffset', `${circumference}`);
    ring.append(track, fg);
    this.bufferRingFg = fg;

    const bufferText = el('span', undefined, 'Buffer 0.0s');
    this.bufferPill.append(ring, bufferText);
    this.bufferPill.style.display = 'none';

    const settingsBtn = el('button', 'icon-btn', ICONS.gear);
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.onclick = () => this.openSettings();

    const left = el('div', undefined);
    left.append(this.statusPill);
    const right = el('div', 'topbar-right');
    right.append(this.bufferPill, settingsBtn);

    this.topbar.append(left, right);
    return this.topbar;
  }

  private buildControls(): HTMLElement {
    const controls = el('div', 'controls');
    const row = el('div', 'controls-row');

    const stopBtn = el('button', 'side-btn left', ICONS.stop);
    stopBtn.setAttribute('aria-label', 'End session');
    stopBtn.onclick = () => this.stopSession();

    const ringSvg = `
      <svg class="shutter-ring" viewBox="0 0 100 100">
        <circle class="track" cx="50" cy="50" r="46"></circle>
      </svg>`;
    this.shutterWrap.innerHTML = ringSvg;
    const shutterBtn = el('button', 'shutter');
    shutterBtn.append(this.shutterFill);
    this.shutterWrap.append(shutterBtn, this.pendingLabel);
    shutterBtn.onclick = () => this.onCapture();

    this.galleryBtn.setAttribute('aria-label', 'Saved clips');
    this.galleryBadge.textContent = '0';
    this.galleryBadge.style.display = 'none';
    this.galleryBtn.append(this.galleryBadge);
    this.galleryBtn.onclick = () => this.openGallery();

    row.append(stopBtn, this.shutterWrap, this.galleryBtn);
    controls.append(row);
    return controls;
  }

  private startScreenDesc: HTMLParagraphElement | null = null;

  private startScreenCopy(): string {
    return `Start a session and the camera buffers continuously in the background. Tap the shutter and it saves the last ${this.settings.preRollSec}s plus the next ${this.settings.postRollSec}s — automatically merged if you tap again before it finishes.`;
  }

  private renderStartScreen(): void {
    this.startScreen.innerHTML = '';
    const brand = el('div', 'brand-icon', ICONS.camera);
    const title = el('h1', undefined, 'ReplayCam');
    const desc = el('p', undefined, this.startScreenCopy());
    this.startScreenDesc = desc;
    const startBtn = el('button', 'start-btn', 'Start recording');
    startBtn.onclick = () => this.startSession();

    const settingsLink = el('div', 'start-meta', `${ICONS.gear} Adjust pre/post-roll & quality`);
    settingsLink.style.cursor = 'pointer';
    settingsLink.onclick = () => this.openSettings();

    const note = el(
      'div',
      'start-note',
      `${ICONS.warn}<span>Keep this tab in the foreground and the screen on during a session — phones pause camera capture for fully backgrounded or locked browsers. ReplayCam keeps the screen awake for you while it can.</span>`
    );

    this.startScreen.append(brand, title, desc, startBtn, settingsLink, note);
  }

  // ------------------------------------------------------------- session

  private async startSession(): Promise<void> {
    const startBtn = this.startScreen.querySelector<HTMLButtonElement>('.start-btn');
    if (startBtn) {
      startBtn.textContent = 'Starting camera…';
      startBtn.disabled = true;
    }

    let result;
    try {
      result = await startCamera(this.settings.quality, this.settings.facing, this.settings.micEnabled);
    } catch (err) {
      this.toast(`Couldn't start the camera: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      if (startBtn) {
        startBtn.textContent = 'Start recording';
        startBtn.disabled = false;
      }
      return;
    }

    this.stream = result.stream;
    this.activePreset = result.preset;
    this.demo = result.demo;
    if (result.fallbackNote) {
      this.toast(result.fallbackNote, { kind: result.demo ? 'error' : 'info', duration: 6000 });
    }

    this.video.srcObject = this.stream;
    this.video.classList.toggle('mirrored', this.settings.facing === 'user' && !this.demo);
    await this.video.play().catch(() => {});

    this.mimeType = pickMimeType();
    this.bufferMgr = new BufferManager({
      mimeType: this.mimeType,
      getPreRollMs: () => this.settings.preRollSec * 1000,
      onJobUpdate: (job) => this.onJobUpdate(job),
      onClipExported: (job, blob) => this.onClipExported(job, blob),
      onExportError: (_job, err) => {
        this.toast(`Couldn't save that clip: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
      },
      onBufferChange: (ms) => this.updateBufferPill(ms)
    });

    this.recorder = new SegmentedRecorder(
      this.stream,
      this.mimeType,
      this.activePreset.videoBitrate,
      SEGMENT_MS,
      (seg) => this.bufferMgr?.addSegment(seg),
      (err) => {
        this.toast('Recording error — ending session.', { kind: 'error' });
        console.error(err);
        this.stopSession();
      }
    );
    this.recorder.start();

    const wakeLockOk = await this.wakeLock.enable();
    if (!wakeLockOk) {
      this.toast('Your browser can’t keep the screen awake automatically — raise your phone’s auto-lock timeout for long sessions.', {
        kind: 'info',
        duration: 6000
      });
    }

    this.live = true;
    this.sessionStartedAt = Date.now();
    this.startScreen.style.display = 'none';
    this.bufferPill.style.display = 'inline-flex';
    this.updateStatusPill();
    this.sessionTimer = setInterval(() => this.updateStatusPill(), 1000);

    if (startBtn) {
      startBtn.textContent = 'Start recording';
      startBtn.disabled = false;
    }
  }

  private stopSession(): void {
    if (!this.live) return;
    this.bufferMgr?.flushPending();
    // Give in-flight exports a beat before we tear the polling loop down;
    // they run independently of it and will still resolve afterward.
    setTimeout(() => this.bufferMgr?.destroy(), 50);

    this.recorder?.stop();
    this.recorder = null;
    stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
    this.wakeLock.disable();

    this.live = false;
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    this.sessionTimer = null;
    this.clearPendingTicker();

    this.startScreen.style.display = 'flex';
    this.bufferPill.style.display = 'none';
    this.shutterWrap.classList.remove('pending');
    this.pendingLabel.textContent = '';
    this.currentJobId = null;
    this.updateStatusPill();
  }

  private async restartForSettingsChange(note: string): Promise<void> {
    if (!this.live) return;
    this.toast(note, { kind: 'info' });
    this.bufferMgr?.flushPending();
    setTimeout(() => this.bufferMgr?.destroy(), 50);
    this.recorder?.stop();
    this.recorder = null;
    stopStream(this.stream);
    this.stream = null;
    this.live = false;
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    await this.startSession();
  }

  private updateStatusPill(): void {
    this.statusPill.classList.toggle('live', this.live);
    const dot = this.statusPill.querySelector('.status-dot');
    const label = this.statusPill.querySelector('span:last-child');
    if (!label || !dot) return;
    if (!this.live) {
      label.textContent = 'Off';
      return;
    }
    const elapsed = Date.now() - this.sessionStartedAt;
    const m = Math.floor(elapsed / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    const timeStr = `${m}:${s.toString().padStart(2, '0')}`;
    label.textContent = this.demo ? `Demo · ${timeStr}` : `Live · ${timeStr}`;
  }

  private updateBufferPill(ms: number): void {
    const label = this.bufferPill.querySelector('span:last-child');
    if (label) label.textContent = `Buffer ${fmtSeconds(ms)}`;
    const target = this.settings.preRollSec * 1000;
    const ratio = target > 0 ? Math.min(1, ms / target) : 1;
    const circumference = 2 * Math.PI * 6.5;
    this.bufferRingFg.setAttribute('stroke-dashoffset', `${circumference * (1 - ratio)}`);
  }

  // ------------------------------------------------------------- capture

  private triggerFlash(): void {
    this.shutterFlashEl.classList.remove('flash');
    this.shutterFlashEl.style.transition = 'none';
    this.shutterFlashEl.style.opacity = '0.85';
    requestAnimationFrame(() => {
      this.shutterFlashEl.classList.add('flash');
      this.shutterFlashEl.style.transition = '';
      this.shutterFlashEl.style.opacity = '0';
    });
  }

  private onCapture(): void {
    if (!this.live || !this.bufferMgr) return;
    this.triggerFlash();
    const job = this.bufferMgr.capture(this.settings.preRollSec * 1000, this.settings.postRollSec * 1000);
    const wasMerged = job.mergedCount > 1;
    this.currentJobId = job.id;
    this.shutterWrap.classList.add('pending');
    this.startPendingTicker();
    if (wasMerged) {
      this.toast(`Extended — clip will now be ~${fmtSeconds(job.endTs - job.startTs)} long`, { kind: 'success' });
    }
  }

  private startPendingTicker(): void {
    this.clearPendingTicker();
    this.pendingTicker = setInterval(() => {
      if (!this.currentJobId || !this.bufferMgr) return;
      const job = this.bufferMgr.getActiveJobs().find((j) => j.id === this.currentJobId);
      if (!job) {
        this.clearPendingTicker();
        return;
      }
      if (job.status === 'buffering') {
        const remaining = Math.max(0, job.endTs - Date.now());
        this.pendingLabel.textContent = `Saving in ${Math.ceil(remaining / 1000)}s…`;
      } else {
        this.pendingLabel.textContent = 'Processing…';
      }
    }, 200);
  }

  private clearPendingTicker(): void {
    if (this.pendingTicker) clearInterval(this.pendingTicker);
    this.pendingTicker = null;
  }

  private onJobUpdate(job: CaptureJob): void {
    if (job.id !== this.currentJobId) return;
    if (job.status === 'done' || job.status === 'error') {
      this.shutterWrap.classList.remove('pending');
      this.pendingLabel.textContent = '';
      this.clearPendingTicker();
      this.currentJobId = null;
    }
  }

  private async onClipExported(job: CaptureJob, blob: Blob): Promise<void> {
    const clip: ClipRecord = {
      id: job.id,
      blob,
      mimeType: this.mimeType,
      createdAt: job.createdAt,
      durationMs: job.endTs - job.startTs,
      sizeBytes: blob.size,
      preRollSec: this.settings.preRollSec,
      postRollSec: this.settings.postRollSec,
      mergedCount: job.mergedCount
    };
    try {
      await saveClip(clip);
    } catch (err) {
      this.toast('Saved to memory, but could not write to on-device storage — download it before closing the tab.', {
        kind: 'error',
        duration: 6000
      });
      console.error(err);
    }
    this.clips.unshift(clip);
    this.updateGalleryBadge();
    if (this.gallerySheet) this.renderGalleryGrid();

    const mergeNote = job.mergedCount > 1 ? ` (merged ×${job.mergedCount})` : '';
    this.toast(`Saved ${fmtClipDuration(clip.durationMs)} clip${mergeNote}`, { kind: 'success' });
  }

  // -------------------------------------------------------------- toasts

  private toast(message: string, opts: ToastOpts = {}): void {
    const kind = opts.kind ?? 'info';
    const node = el('div', `toast ${kind === 'error' ? 'error' : 'success'}`);
    node.append(el('span', 'dot'), el('span', undefined, message));
    this.toastStack.append(node);
    const duration = opts.duration ?? (kind === 'error' ? 5000 : 3200);
    setTimeout(() => {
      node.style.transition = 'opacity 0.25s ease';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 260);
    }, duration);
  }

  // ------------------------------------------------------------ settings

  private openSettings(): void {
    this.closeSheets();
    const backdrop = el('div', 'sheet-backdrop');
    const sheet = el('div', 'sheet');
    sheet.append(el('div', 'sheet-grabber'));

    const header = el('div', 'sheet-header');
    header.append(el('h2', undefined, 'Settings'));
    const closeBtn = el('button', 'sheet-close', ICONS.close);
    closeBtn.onclick = () => this.closeSheets();
    header.append(closeBtn);
    sheet.append(header);

    sheet.append(this.buildRollSetting('Before the tap (pre-roll)', 'preRollSec', 0, 60));
    sheet.append(this.buildRollSetting('After the tap (post-roll)', 'postRollSec', 0, 60));
    sheet.append(this.buildQualitySetting());
    sheet.append(this.buildFacingSetting());
    sheet.append(this.buildMicSetting());
    sheet.append(this.buildMemoryEstimate());

    backdrop.onclick = () => this.closeSheets();
    this.root.append(backdrop, sheet);
    this.settingsSheet = sheet;
    (backdrop as unknown as { _partner?: HTMLElement })._partner = sheet;
  }

  private buildRollSetting(label: string, key: 'preRollSec' | 'postRollSec', min: number, max: number): HTMLElement {
    const group = el('div', 'setting-group');
    const row = el('div', 'setting-label-row');
    row.append(el('span', 'setting-label', label));
    const value = el('span', 'setting-value', `${this.settings[key]}s`);
    row.append(value);
    const input = el('input', undefined) as HTMLInputElement;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(this.settings[key]);
    input.oninput = () => {
      const v = Number(input.value);
      this.settings[key] = v;
      value.textContent = `${v}s`;
      persistSettings(this.settings);
      const mem = group.parentElement?.querySelector('.memory-estimate');
      if (mem) mem.innerHTML = this.memoryEstimateHtml();
      if (this.startScreenDesc) this.startScreenDesc.textContent = this.startScreenCopy();
    };
    group.append(row, input);
    return group;
  }

  private buildQualitySetting(): HTMLElement {
    const group = el('div', 'setting-group');
    group.append(el('div', 'setting-label-row', '<span class="setting-label">Quality</span>'));
    const seg = el('div', 'segmented');
    for (const preset of QUALITY_PRESETS) {
      const btn = el('button', preset.id === this.settings.quality ? 'active' : '', `${preset.label}<span class="sub">${preset.sublabel}</span>`);
      btn.onclick = () => {
        if (this.settings.quality === preset.id) return;
        this.settings.quality = preset.id as QualityId;
        persistSettings(this.settings);
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.refreshMemoryEstimate();
        void this.restartForSettingsChange(`Switching to ${preset.label} (${preset.sublabel})…`);
      };
      seg.append(btn);
    }
    group.append(seg);
    group.append(el('div', 'setting-hint', 'Changing quality mid-session briefly restarts the camera and resets the buffer.'));
    return group;
  }

  private buildFacingSetting(): HTMLElement {
    const group = el('div', 'setting-group');
    const row = el('div', 'row-toggle');
    row.append(el('div', 'row-toggle-text', '<span class="row-toggle-title">Rear camera</span><span class="row-toggle-sub">Off uses the front camera</span>'));
    const btn = el('button', `switch ${this.settings.facing === 'environment' ? 'on' : ''}`);
    btn.onclick = () => {
      this.settings.facing = (this.settings.facing === 'environment' ? 'user' : 'environment') as FacingMode;
      persistSettings(this.settings);
      btn.classList.toggle('on', this.settings.facing === 'environment');
      void this.restartForSettingsChange(`Switching camera…`);
    };
    row.append(btn);
    group.append(row);
    return group;
  }

  private buildMicSetting(): HTMLElement {
    const group = el('div', 'setting-group');
    const row = el('div', 'row-toggle');
    row.append(el('div', 'row-toggle-text', '<span class="row-toggle-title">Microphone</span><span class="row-toggle-sub">Record audio with clips</span>'));
    const btn = el('button', `switch ${this.settings.micEnabled ? 'on' : ''}`);
    btn.onclick = () => {
      this.settings.micEnabled = !this.settings.micEnabled;
      persistSettings(this.settings);
      btn.classList.toggle('on', this.settings.micEnabled);
      void this.restartForSettingsChange(`${this.settings.micEnabled ? 'Enabling' : 'Disabling'} microphone…`);
    };
    row.append(btn);
    group.append(row);
    return group;
  }

  private memoryEstimateHtml(): string {
    const totalSec = this.settings.preRollSec;
    const bytes = (this.activePreset.videoBitrate / 8) * totalSec;
    return `${ICONS.warn}<span>Buffer holds roughly <strong>${fmtBytes(bytes)}</strong> in memory (${totalSec}s at ${this.activePreset.sublabel}).</span>`;
  }

  private buildMemoryEstimate(): HTMLElement {
    const box = el('div', 'memory-estimate', this.memoryEstimateHtml());
    return box;
  }

  private refreshMemoryEstimate(): void {
    const box = this.settingsSheet?.querySelector('.memory-estimate');
    if (box) box.innerHTML = this.memoryEstimateHtml();
  }

  // ------------------------------------------------------------- gallery

  private openGallery(): void {
    this.closeSheets();
    const backdrop = el('div', 'sheet-backdrop');
    const sheet = el('div', 'sheet gallery-sheet');
    sheet.append(el('div', 'sheet-grabber'));
    const header = el('div', 'sheet-header');
    header.append(el('h2', undefined, `Saved clips (${this.clips.length})`));
    const closeBtn = el('button', 'sheet-close', ICONS.close);
    closeBtn.onclick = () => this.closeSheets();
    header.append(closeBtn);
    sheet.append(header);
    const grid = el('div', 'gallery-grid');
    sheet.append(grid);

    backdrop.onclick = () => this.closeSheets();
    this.root.append(backdrop, sheet);
    this.gallerySheet = sheet;
    this.renderGalleryGrid();
  }

  private clipUrl(clip: ClipRecord): string {
    let url = this.clipUrls.get(clip.id);
    if (!url) {
      url = URL.createObjectURL(clip.blob);
      this.clipUrls.set(clip.id, url);
    }
    return url;
  }

  private renderGalleryGrid(): void {
    const grid = this.gallerySheet?.querySelector('.gallery-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const header = this.gallerySheet?.querySelector('h2');
    if (header) header.textContent = `Saved clips (${this.clips.length})`;

    if (this.clips.length === 0) {
      grid.append(
        el(
          'div',
          'gallery-empty',
          `${ICONS.gallery}<p>No clips yet</p><span>Start a session and tap the shutter to save your first replay.</span>`
        )
      );
      return;
    }

    for (const clip of this.clips) {
      const card = el('div', 'clip-card');
      const video = el('video') as HTMLVideoElement;
      video.src = this.clipUrl(clip);
      video.muted = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.onloadedmetadata = () => {
        try {
          video.currentTime = Math.min(0.15, video.duration / 2);
        } catch {
          /* ignore seek issues on some browsers */
        }
      };
      card.append(video);

      const meta = el('div', 'clip-meta');
      meta.append(el('span', 'clip-duration', fmtClipDuration(clip.durationMs)));
      meta.append(el('span', 'clip-time', fmtRelative(clip.createdAt)));
      card.append(meta);

      const actions = el('div', 'clip-actions');
      const delBtn = el('button', 'clip-action-btn', ICONS.trash);
      delBtn.onclick = (e) => {
        e.stopPropagation();
        void this.deleteClipConfirmed(clip);
      };
      actions.append(delBtn);
      card.append(actions);

      card.onclick = () => this.openPlayer(clip);
      grid.append(card);
    }
  }

  private async deleteClipConfirmed(clip: ClipRecord): Promise<void> {
    if (!confirm(`Delete this ${fmtClipDuration(clip.durationMs)} clip? This can't be undone.`)) return;
    await deleteClip(clip.id).catch(() => {});
    const url = this.clipUrls.get(clip.id);
    if (url) {
      URL.revokeObjectURL(url);
      this.clipUrls.delete(clip.id);
    }
    this.clips = this.clips.filter((c) => c.id !== clip.id);
    this.updateGalleryBadge();
    this.renderGalleryGrid();
    this.closePlayer();
  }

  private updateGalleryBadge(): void {
    if (this.clips.length > 0) {
      this.galleryBadge.textContent = this.clips.length > 99 ? '99+' : String(this.clips.length);
      this.galleryBadge.style.display = 'flex';
    } else {
      this.galleryBadge.style.display = 'none';
    }
  }

  // -------------------------------------------------------------- player

  private openPlayer(clip: ClipRecord): void {
    this.closePlayer();
    const backdrop = el('div', 'player-backdrop');
    const video = el('video') as HTMLVideoElement;
    video.src = this.clipUrl(clip);
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;

    const closeBtn = el('button', 'player-close', ICONS.close);
    closeBtn.onclick = () => this.closePlayer();

    const actions = el('div', 'player-actions');
    const downloadBtn = el('button', 'pill-btn', `${ICONS.download}<span>Save file</span>`);
    downloadBtn.onclick = () => this.downloadClip(clip);
    actions.append(downloadBtn);

    if (typeof navigator.share === 'function') {
      const shareBtn = el('button', 'pill-btn', `${ICONS.share}<span>Share</span>`);
      shareBtn.onclick = () => void this.shareClip(clip);
      actions.append(shareBtn);
    }

    const delBtn = el('button', 'pill-btn danger', `${ICONS.trash}<span>Delete</span>`);
    delBtn.onclick = () => void this.deleteClipConfirmed(clip);
    actions.append(delBtn);

    backdrop.append(closeBtn, video, actions);
    backdrop.onclick = (e) => {
      if (e.target === backdrop) this.closePlayer();
    };
    this.root.append(backdrop);
    this.playerModal = backdrop;
  }

  private closePlayer(): void {
    this.playerModal?.remove();
    this.playerModal = null;
  }

  private clipFilename(clip: ClipRecord): string {
    const d = new Date(clip.createdAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `replaycam_${stamp}.${extFromMime(clip.mimeType)}`;
  }

  private downloadClip(clip: ClipRecord): void {
    const a = document.createElement('a');
    a.href = this.clipUrl(clip);
    a.download = this.clipFilename(clip);
    document.body.append(a);
    a.click();
    a.remove();
  }

  private async shareClip(clip: ClipRecord): Promise<void> {
    try {
      const file = new File([clip.blob], this.clipFilename(clip), { type: clip.mimeType });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        this.downloadClip(clip);
        return;
      }
      await navigator.share({ files: [file], title: 'ReplayCam clip' });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      this.toast('Sharing failed — downloading instead.', { kind: 'error' });
      this.downloadClip(clip);
    }
  }

  // ---------------------------------------------------------------- misc

  private closeSheets(): void {
    this.root.querySelectorAll('.sheet-backdrop, .sheet').forEach((n) => n.remove());
    this.settingsSheet = null;
    this.gallerySheet = null;
  }
}

const app = new App();
void app.init();
