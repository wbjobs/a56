import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';
import { relativePath } from '../utils/file-utils';
import type { FileWatcher } from '../types/internal';

export class FileSystemWatcher implements FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private folder: string | null = null;
  private onAdd: ((relPath: string, absPath: string) => void) | null = null;
  private onChange: ((relPath: string, absPath: string) => void) | null = null;
  private onDelete: ((relPath: string) => void) | null = null;
  private debounceMap = new Map<string, NodeJS.Timeout>();
  private isPaused = false;

  setHandlers(handlers: {
    onAdd: (relPath: string, absPath: string) => void;
    onChange: (relPath: string, absPath: string) => void;
    onDelete: (relPath: string) => void;
  }): void {
    this.onAdd = handlers.onAdd;
    this.onChange = handlers.onChange;
    this.onDelete = handlers.onDelete;
  }

  private debounce(key: string, fn: () => void, delay = 300): void {
    const existing = this.debounceMap.get(key);
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      this.debounceMap.delete(key);
      if (!this.isPaused) fn();
    }, delay);
    this.debounceMap.set(key, timeout);
  }

  start(folder: string): void {
    this.stop();
    this.folder = folder;

    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }

    this.watcher = chokidar.watch(folder, {
      ignoreInitial: false,
      persistent: true,
      depth: 99,
      ignored: [
        /(^|[\/\\])\../,
        /node_modules/,
        /\.git/,
        /~\$/,
        /\.bak-\d+$/
      ],
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', (absPath) => {
        if (!this.folder) return;
        const rel = relativePath(this.folder, absPath);
        const key = `add:${rel}`;
        this.debounce(key, () => this.onAdd?.(rel, absPath));
      })
      .on('change', (absPath) => {
        if (!this.folder) return;
        const rel = relativePath(this.folder, absPath);
        const key = `change:${rel}`;
        this.debounce(key, () => this.onChange?.(rel, absPath));
      })
      .on('unlink', (absPath) => {
        if (!this.folder) return;
        const rel = relativePath(this.folder, absPath);
        const key = `delete:${rel}`;
        this.debounce(key, () => this.onDelete?.(rel), 500);
      });
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.folder = null;
    for (const t of this.debounceMap.values()) clearTimeout(t);
    this.debounceMap.clear();
  }

  getWatchedFolder(): string | null {
    return this.folder;
  }
}

export const fileWatcher = new FileSystemWatcher();
