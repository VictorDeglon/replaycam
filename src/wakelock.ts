/** Keeps the screen awake for the duration of a recording session, using the
 * Screen Wake Lock API. Automatically re-acquires after a visibility change
 * (iOS/Android release the lock whenever the tab is backgrounded, even
 * briefly — e.g. opening the settings sheet's share dialog). */
export class WakeLockGuard {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private visibilityHandler = () => {
    if (this.wanted && document.visibilityState === 'visible') {
      void this.acquire();
    }
  };

  get supported(): boolean {
    return 'wakeLock' in navigator;
  }

  get active(): boolean {
    return this.sentinel !== null;
  }

  async enable(): Promise<boolean> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.visibilityHandler);
    return this.acquire();
  }

  disable(): void {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.sentinel?.release().catch(() => {});
    this.sentinel = null;
  }

  private async acquire(): Promise<boolean> {
    if (!this.supported) return false;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
      return true;
    } catch {
      this.sentinel = null;
      return false;
    }
  }
}
