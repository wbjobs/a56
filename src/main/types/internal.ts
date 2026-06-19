export interface FileWatcher {
  start(folder: string): void;
  stop(): void;
  pause(): void;
  resume(): void;
  getWatchedFolder(): string | null;
}

export interface SyncEngineEvents {
  (event: 'status-changed', data: void): void;
  (event: 'files-changed', data: void): void;
  (event: 'conflicts-changed', data: void): void;
  (event: 'peers-changed', data: void): void;
  (event: 'new-event', data: void): void;
}
