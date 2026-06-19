import os from 'os';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type {
  FileMetadata,
  VersionVector,
  SyncStatus,
  ConflictInfo,
  PeerNode,
  SyncEvent,
  SyncEventType
} from '../../shared/types';
import { compareVersionVectors, mergeVersionVectors } from '../../shared/types';
import { dbManager } from '../database/manager';
import { fileWatcher } from './file-watcher';
import { networkServer } from './network-server';
import { networkClient } from './network-client';
import {
  absolutePath,
  deleteFileSafely,
  ensureDirectoryForFile,
  getFileStats,
  scanFolder
} from '../utils/file-utils';

type EventCallback = () => void;

export class SyncEngine {
  private nodeId: string;
  private nodeName: string;
  private syncFolder: string | null = null;
  private isRunning = false;
  private lastSyncTime: number | null = null;
  private error: string | null = null;
  private syncInProgress = false;
  private syncTimer: NodeJS.Timeout | null = null;
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private inFlightFiles = new Set<string>();
  private peerLastSyncAt = new Map<string, number>();

  constructor() {
    this.nodeId = this.initNodeId();
    this.nodeName = `${os.hostname()}-${this.nodeId.slice(0, 4)}`;
  }

  private initNodeId(): string {
    const existing = dbManager.getSetting('nodeId');
    if (existing) return existing;
    const id = uuidv4();
    dbManager.setSetting('nodeId', id);
    return id;
  }

  getNodeId(): string {
    return this.nodeId;
  }

  getNodeName(): string {
    return this.nodeName;
  }

  on(event: 'status-changed' | 'files-changed' | 'conflicts-changed' | 'peers-changed' | 'new-event', callback: EventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string): void {
    this.listeners.get(event)?.forEach((cb) => cb());
  }

  private addEvent(type: SyncEventType, message: string, data?: Record<string, unknown>): void {
    dbManager.addEvent({ type, message, data });
    this.emit('new-event');
  }

  getStatus(): SyncStatus {
    const files = dbManager.getAllFiles();
    const conflicts = dbManager.getConflicts(true);
    const peers = dbManager.getAllPeers();
    return {
      isRunning: this.isRunning,
      syncFolder: this.syncFolder,
      connectedPeers: peers.filter((p) => p.online).length,
      totalFiles: files.filter((f) => !f.isDeleted).length,
      pendingConflicts: conflicts.length,
      lastSyncTime: this.lastSyncTime,
      error: this.error
    };
  }

  getFiles(): FileMetadata[] {
    return dbManager.getAllFiles();
  }

  getConflicts(): ConflictInfo[] {
    return dbManager.getConflicts(true);
  }

  getPeers(): PeerNode[] {
    const dbPeers = new Map(dbManager.getAllPeers().map((p) => [p.id, p]));
    const livePeers = networkClient.getKnownPeers();
    const all = new Map<string, PeerNode>();
    for (const p of dbPeers.values()) all.set(p.id, p);
    for (const p of livePeers) all.set(p.id, p);
    return [...all.values()];
  }

  getEvents(): SyncEvent[] {
    return dbManager.getRecentEvents(200);
  }

  async setSyncFolder(folder: string): Promise<void> {
    this.syncFolder = folder;
    dbManager.setSetting('syncFolder', folder);
    this.emit('status-changed');
    this.addEvent('sync-started', `同步文件夹已设置: ${folder}`, { folder });
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.error = null;
    const savedFolder = dbManager.getSetting('syncFolder');
    if (savedFolder) {
      this.syncFolder = savedFolder;
    }

    networkServer.setHandlers({
      getSyncFolder: () => this.syncFolder,
      getNodeId: () => this.nodeId,
      getNodeName: () => this.nodeName,
      getAllFiles: () => dbManager.getAllFiles(),
      getFilesSince: (since) => dbManager.getFilesSince(since),
      getFileMetadata: (p) => dbManager.getFile(p),
      onRemoteFileChange: (meta, sender) => this.handleRemoteFileChange(meta, sender),
      onRemoteFileDelete: (p, vv, sender) => this.handleRemoteFileDelete(p, vv, sender),
      onPeerAnnounce: (peer) => this.handlePeerAnnounce(peer),
      onPeerLeave: (id) => this.handlePeerLeave(id),
      getPeers: () => this.getPeers()
    });

    const port = await networkServer.start();
    networkClient.setLocalNodeInfo(this.nodeId, this.nodeName, port);
    networkClient.setHandlers({
      onPeerDiscovered: (peer) => this.handlePeerDiscovered(peer),
      onPeerLost: (id) => this.handlePeerLeave(id),
      onRemoteFileChanged: async () => {},
      onRemoteFileDeleted: async () => {}
    });

    fileWatcher.setHandlers({
      onAdd: (rel, abs) => this.handleLocalFileChange(rel, abs, false),
      onChange: (rel, abs) => this.handleLocalFileChange(rel, abs, true),
      onDelete: (rel) => this.handleLocalFileDelete(rel)
    });

    if (this.syncFolder) {
      fileWatcher.start(this.syncFolder);
      await this.scanAndSyncExisting();
    }

    networkClient.startPeriodicDiscovery();

    this.syncTimer = setInterval(() => {
      this.periodicSync().catch((e) => {
        this.error = e.message;
        this.emit('status-changed');
      });
    }, 10000);

    this.addEvent('sync-started', '同步服务已启动');
    this.emit('status-changed');
    this.emit('peers-changed');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    fileWatcher.stop();
    networkClient.stop();
    networkServer.stop();
    for (const peer of this.getPeers()) {
      dbManager.upsertPeer({ ...peer, online: false });
    }
    this.addEvent('sync-completed', '同步服务已停止');
    this.emit('status-changed');
    this.emit('peers-changed');
  }

  private async scanAndSyncExisting(): Promise<void> {
    if (!this.syncFolder) return;
    fileWatcher.pause();
    const results = scanFolder(this.syncFolder);

    for (const item of results) {
      const abs = absolutePath(this.syncFolder, item.path);
      const existing = dbManager.getFile(item.path);
      const needsUpdate = !existing || existing.modifiedAt !== item.modifiedAt || existing.size !== item.size;
      if (needsUpdate) {
        try {
          await this.handleLocalFileChange(item.path, abs, !!existing);
        } catch {
          // skip
        }
      }
    }
    fileWatcher.resume();
  }

  private bumpLocalVersion(prev?: VersionVector): VersionVector {
    const vv: VersionVector = { ...(prev || {}) };
    vv[this.nodeId] = (vv[this.nodeId] || 0) + 1;
    return vv;
  }

  private async handleLocalFileChange(relPath: string, absPath: string, isModify: boolean): Promise<void> {
    if (!this.syncFolder || this.inFlightFiles.has(relPath)) return;
    this.inFlightFiles.add(relPath);

    try {
      const existing = dbManager.getFile(relPath);
      const { size, modifiedAt, hash } = await getFileStats(absPath);

      if (existing && existing.hash === hash) {
        this.inFlightFiles.delete(relPath);
        return;
      }

      const newVV = this.bumpLocalVersion(existing?.versionVector);
      const now = Date.now();
      const metadata: FileMetadata = {
        path: relPath,
        hash,
        size,
        modifiedAt,
        lastUpdated: now,
        versionVector: newVV,
        lastModifier: this.nodeId,
        isDeleted: false
      };

      dbManager.upsertFile(metadata);

      const eventType: SyncEventType = isModify ? 'file-modified' : 'file-added';
      this.addEvent(eventType, `${isModify ? '修改' : '新增'}文件: ${relPath}`, {
        path: relPath
      });

      this.emit('files-changed');
      await this.propagateToPeers(metadata, absPath);
    } catch (err) {
      this.addEvent('error', `处理本地文件变更失败 ${relPath}: ${(err as Error).message}`);
    } finally {
      this.inFlightFiles.delete(relPath);
    }
  }

  private handleLocalFileDelete(relPath: string): void {
    if (!this.syncFolder || this.inFlightFiles.has(relPath)) return;
    this.inFlightFiles.add(relPath);

    try {
      const existing = dbManager.getFile(relPath);
      if (!existing || existing.isDeleted) {
        this.inFlightFiles.delete(relPath);
        return;
      }

      const newVV = this.bumpLocalVersion(existing.versionVector);
      const now = Date.now();
      const metadata: FileMetadata = {
        ...existing,
        isDeleted: true,
        modifiedAt: now,
        lastUpdated: now,
        versionVector: newVV,
        lastModifier: this.nodeId
      };

      dbManager.upsertFile(metadata);
      this.addEvent('file-deleted', `删除文件: ${relPath}`, { path: relPath });
      this.emit('files-changed');

      (async () => {
        try {
          await this.propagateDeleteToPeers(metadata);
        } catch {
          // ignore
        } finally {
          this.inFlightFiles.delete(relPath);
        }
      })();
    } catch (err) {
      this.inFlightFiles.delete(relPath);
      this.addEvent('error', `处理本地删除失败 ${relPath}: ${(err as Error).message}`);
    }
  }

  private async propagateToPeers(metadata: FileMetadata, absPath: string): Promise<void> {
    const peers = this.getPeers().filter((p) => p.online);
    for (const peer of peers) {
      try {
        await networkClient.uploadFile(peer, metadata.path, absPath, metadata);
      } catch {
        // skip
      }
    }
    this.lastSyncTime = Date.now();
    this.emit('status-changed');
  }

  private async propagateDeleteToPeers(metadata: FileMetadata): Promise<void> {
    const peers = this.getPeers().filter((p) => p.online);
    for (const peer of peers) {
      try {
        await networkClient.sendDelete(peer, metadata.path, metadata.versionVector);
      } catch {
        // skip
      }
    }
    this.lastSyncTime = Date.now();
    this.emit('status-changed');
  }

  private async handleRemoteFileChange(
    remote: FileMetadata,
    senderNodeId: string
  ): Promise<'updated' | 'conflict' | 'ignored'> {
    if (!this.syncFolder) return 'ignored';

    const local = dbManager.getFile(remote.path);

    if (local) {
      const cmp = compareVersionVectors(local.versionVector, remote.versionVector);

      if (cmp === 'equal' || cmp === 'a-greater') {
        return 'ignored';
      }

      if (cmp === 'conflict') {
        await this.createConflict(remote, senderNodeId, local);
        return 'conflict';
      }
    }

    const absPath = absolutePath(this.syncFolder, remote.path);
    ensureDirectoryForFile(absPath);

    const vv = local ? mergeVersionVectors(local.versionVector, remote.versionVector) : remote.versionVector;

    const metadata: FileMetadata = {
      ...remote,
      versionVector: vv,
      lastUpdated: Date.now()
    };

    dbManager.upsertFile(metadata);
    this.emit('files-changed');

    const eventType: SyncEventType = local ? 'file-modified' : 'file-added';
    const senderName = this.getPeers().find((p) => p.id === senderNodeId)?.name || senderNodeId.slice(0, 8);
    this.addEvent(eventType, `来自 ${senderName} 的文件 ${local ? '更新' : '新增'}: ${remote.path}`, {
      path: remote.path
    });

    return 'updated';
  }

  private async handleRemoteFileDelete(
    relPath: string,
    remoteVV: VersionVector,
    senderNodeId: string
  ): Promise<'updated' | 'conflict' | 'ignored'> {
    if (!this.syncFolder) return 'ignored';

    const local = dbManager.getFile(relPath);
    if (!local || local.isDeleted) {
      return 'ignored';
    }

    const cmp = compareVersionVectors(local.versionVector, remoteVV);

    if (cmp === 'a-greater') {
      return 'ignored';
    }

    if (cmp === 'conflict') {
      await this.createConflict(
        {
          ...local,
          isDeleted: true,
          versionVector: remoteVV,
          lastUpdated: Date.now()
        },
        senderNodeId,
        local
      );
      return 'conflict';
    }

    const absPath = absolutePath(this.syncFolder, relPath);
    deleteFileSafely(absPath);

    const now = Date.now();
    const vv = mergeVersionVectors(local.versionVector, remoteVV);
    dbManager.upsertFile({
      ...local,
      isDeleted: true,
      versionVector: vv,
      lastModifier: senderNodeId,
      modifiedAt: now,
      lastUpdated: now
    });
    this.emit('files-changed');

    const senderName = this.getPeers().find((p) => p.id === senderNodeId)?.name || senderNodeId.slice(0, 8);
    this.addEvent('file-deleted', `来自 ${senderName} 的删除: ${relPath}`, { path: relPath });
    return 'updated';
  }

  private async createConflict(
    remote: FileMetadata,
    senderNodeId: string,
    local: FileMetadata
  ): Promise<void> {
    const existingConflicts = dbManager.getConflicts(true);
    const hasConflict = existingConflicts.some(
      (c) => c.path === remote.path && c.remoteNodeId === senderNodeId
    );
    if (hasConflict) return;

    const senderName = this.getPeers().find((p) => p.id === senderNodeId)?.name || senderNodeId.slice(0, 8);

    const conflict: Omit<ConflictInfo, 'resolved'> = {
      id: uuidv4(),
      path: remote.path,
      localVersion: local.versionVector,
      remoteVersion: remote.versionVector,
      remoteNodeId: senderNodeId,
      remoteNodeName: senderName,
      localModifiedAt: local.modifiedAt,
      remoteModifiedAt: remote.modifiedAt
    };

    dbManager.addConflict(conflict);
    this.addEvent('conflict-detected', `检测到冲突: ${remote.path} (来自 ${senderName})`, {
      path: remote.path
    });
    this.emit('conflicts-changed');
  }

  private handlePeerAnnounce(peer: PeerNode): void {
    if (peer.id === this.nodeId) return;
    dbManager.upsertPeer({ ...peer, online: true });
    this.emit('peers-changed');
  }

  private handlePeerDiscovered(peer: PeerNode): void {
    if (peer.id === this.nodeId) return;
    dbManager.upsertPeer({ ...peer, online: true });
    this.addEvent('peer-connected', `发现节点: ${peer.name} (${peer.address}:${peer.port})`);
    this.emit('peers-changed');

    (async () => {
      try {
        await this.syncWithPeer(peer);
      } catch {
        // ignore
      }
    })();
  }

  private handlePeerLeave(peerId: string): void {
    const peer = this.getPeers().find((p) => p.id === peerId);
    if (peer) {
      dbManager.upsertPeer({ ...peer, online: false });
      this.addEvent('peer-disconnected', `节点离线: ${peer.name}`);
      this.emit('peers-changed');
    }
  }

  private async periodicSync(): Promise<void> {
    if (this.syncInProgress) return;
    this.syncInProgress = true;
    try {
      const peers = this.getPeers().filter((p) => p.online);
      for (const peer of peers) {
        try {
          await this.syncWithPeer(peer);
        } catch {
          // skip
        }
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  private async syncWithPeer(peer: PeerNode): Promise<void> {
    if (!this.syncFolder) return;

    const lastSyncAt = this.peerLastSyncAt.get(peer.id) || 0;
    const isFirstSync = lastSyncAt === 0;

    let remoteFiles: FileMetadata[] = [];
    let usedIncremental = false;

    if (lastSyncAt > 0) {
      const result = await networkClient.fetchPeerFilesSince(peer, lastSyncAt);
      remoteFiles = result.files;
      usedIncremental = result.incremental;
    }

    if (remoteFiles.length === 0 && !usedIncremental) {
      remoteFiles = await networkClient.fetchPeerFiles(peer);
    }

    if (remoteFiles.length === 0) {
      this.peerLastSyncAt.set(peer.id, Date.now());
      return;
    }

    const localMap = new Map(dbManager.getAllFiles().map((f) => [f.path, f]));
    let maxLastUpdated = lastSyncAt;

    for (const remote of remoteFiles) {
      if (remote.lastUpdated > maxLastUpdated) {
        maxLastUpdated = remote.lastUpdated;
      }

      const local = localMap.get(remote.path);
      const cmp = local
        ? compareVersionVectors(local.versionVector, remote.versionVector)
        : 'b-greater';

      if (cmp === 'b-greater') {
        if (remote.isDeleted) {
          await this.handleRemoteFileDelete(remote.path, remote.versionVector, peer.id);
        } else {
          const data = await networkClient.downloadFile(peer, remote.path);
          if (data) {
            const absPath = absolutePath(this.syncFolder!, remote.path);
            ensureDirectoryForFile(absPath);
            fs.writeFileSync(absPath, data);
            fs.utimesSync(absPath, remote.modifiedAt / 1000, remote.modifiedAt / 1000);
            await this.handleRemoteFileChange(remote, peer.id);
          }
        }
      } else if (cmp === 'conflict' && local && !local.isDeleted) {
        await this.createConflict(remote, peer.id, local);
      } else if (cmp === 'a-greater' && local && !local.isDeleted) {
        const abs = absolutePath(this.syncFolder, local.path);
        if (fs.existsSync(abs)) {
          await networkClient.uploadFile(peer, local.path, abs, local);
        }
      }
    }

    this.peerLastSyncAt.set(peer.id, maxLastUpdated + 1);

    if (isFirstSync) {
      this.addEvent('sync-completed', `与 ${peer.name} 完成首次全量同步（${remoteFiles.length} 个文件）`, {
        peer: peer.name,
        count: remoteFiles.length
      });
    } else if (usedIncremental && remoteFiles.length > 0) {
      this.addEvent('sync-completed', `与 ${peer.name} 完成增量同步（${remoteFiles.length} 个变更文件）`, {
        peer: peer.name,
        count: remoteFiles.length,
        incremental: true
      });
    }

    this.lastSyncTime = Date.now();
    this.emit('status-changed');
  }

  async resolveConflict(
    conflictId: string,
    resolution: 'local' | 'remote' | 'merged'
  ): Promise<void> {
    const conflicts = dbManager.getConflicts(true);
    const conflict = conflicts.find((c) => c.id === conflictId);
    if (!conflict || !this.syncFolder) throw new Error('冲突不存在');

    const peer = this.getPeers().find((p) => p.id === conflict.remoteNodeId);

    dbManager.resolveConflict(conflictId, resolution);
    const local = dbManager.getFile(conflict.path);
    if (!local) throw new Error('本地文件不存在');

    if (resolution === 'remote') {
      if (peer) {
        const remote = await networkClient.fetchPeerFiles(peer).then((files) =>
          files.find((f) => f.path === conflict.path)
        );
        if (remote && !remote.isDeleted) {
          const data = await networkClient.downloadFile(peer, conflict.path);
          if (data) {
            const abs = absolutePath(this.syncFolder, conflict.path);
            ensureDirectoryForFile(abs);
            fs.writeFileSync(abs, data);
            fs.utimesSync(abs, remote.modifiedAt / 1000, remote.modifiedAt / 1000);
            await this.handleRemoteFileChange(remote, peer.id);
          }
        }
      }
    } else if (resolution === 'local' && peer) {
      const abs = absolutePath(this.syncFolder, conflict.path);
      if (fs.existsSync(abs)) {
        const newVV = this.bumpLocalVersion(local.versionVector);
        const { size, modifiedAt, hash } = await getFileStats(abs);
        const now = Date.now();
        const meta: FileMetadata = {
          ...local,
          hash,
          size,
          modifiedAt,
          lastUpdated: now,
          versionVector: newVV,
          lastModifier: this.nodeId
        };
        dbManager.upsertFile(meta);
        await networkClient.uploadFile(peer, meta.path, abs, meta);
      }
    } else if (resolution === 'merged') {
      const newVV = mergeVersionVectors(local.versionVector, conflict.remoteVersion);
      const abs = absolutePath(this.syncFolder, conflict.path);
      if (fs.existsSync(abs)) {
        const { size, modifiedAt, hash } = await getFileStats(abs);
        const now = Date.now();
        const meta: FileMetadata = {
          ...local,
          hash,
          size,
          modifiedAt,
          lastUpdated: now,
          versionVector: this.bumpLocalVersion(newVV),
          lastModifier: this.nodeId
        };
        dbManager.upsertFile(meta);
        if (peer) {
          await networkClient.uploadFile(peer, meta.path, abs, meta);
        }
      }
    }

    this.addEvent('sync-completed', `冲突已解决: ${conflict.path} (${resolution === 'local' ? '保留本地' : resolution === 'remote' ? '保留远程' : '已合并'})`);
    this.emit('conflicts-changed');
    this.emit('files-changed');
  }

  async resolveAllConflicts(resolution: 'local' | 'remote' | 'merged'): Promise<number> {
    const conflicts = dbManager.getConflicts(true);
    if (conflicts.length === 0) return 0;

    let resolved = 0;
    for (const conflict of conflicts) {
      try {
        await this.resolveConflict(conflict.id, resolution);
        resolved++;
      } catch {
        // skip individual failures
      }
    }

    const label = resolution === 'local' ? '全部保留本地' : resolution === 'remote' ? '全部保留远程' : '全部合并';
    this.addEvent('sync-completed', `批量解决冲突：${label}（${resolved}/${conflicts.length} 个）`, {
      resolution,
      count: resolved
    });

    return resolved;
  }

  async resolveConflictsByPeer(peerId: string, resolution: 'local' | 'remote' | 'merged'): Promise<number> {
    const conflicts = dbManager.getConflicts(true).filter((c) => c.remoteNodeId === peerId);
    if (conflicts.length === 0) return 0;

    let resolved = 0;
    for (const conflict of conflicts) {
      try {
        await this.resolveConflict(conflict.id, resolution);
        resolved++;
      } catch {
        // skip
      }
    }

    const peerName = this.getPeers().find((p) => p.id === peerId)?.name || peerId.slice(0, 8);
    const label = resolution === 'local' ? '保留本地' : resolution === 'remote' ? '保留远程' : '合并';
    this.addEvent('sync-completed', `批量解决 ${peerName} 的冲突：${label}（${resolved} 个）`, {
      peer: peerName,
      resolution,
      count: resolved
    });

    return resolved;
  }
}

export const syncEngine = new SyncEngine();
