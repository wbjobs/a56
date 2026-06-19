import type { LanSyncAPI } from '../../preload';

declare global {
  interface Window {
    lanSync: LanSyncAPI;
  }
}

export {};
