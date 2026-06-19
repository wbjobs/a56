import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { FileMetadata, VersionVector, ConflictInfo, PeerNode, SyncEvent } from '../../shared/types';

export class DatabaseManager {
  private db: Database.Database | null = null;

  initialize(): void {
    const userDataPath = app.getPath('userData');
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    const dbPath = path.join(userDataPath, 'lan-sync.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createTables();
  }

  private createTables(): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        version_vector TEXT NOT NULL,
        last_modifier TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        last_updated INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conflicts (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        local_version TEXT NOT NULL,
        remote_version TEXT NOT NULL,
        remote_node_id TEXT NOT NULL,
        remote_node_name TEXT NOT NULL,
        local_modified_at INTEGER NOT NULL,
        remote_modified_at INTEGER NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolution TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        port INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        online INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        message TEXT NOT NULL,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private rowToFileMetadata(row: {
    path: string;
    hash: string;
    size: number;
    modified_at: number;
    version_vector: string;
    last_modifier: string;
    is_deleted: number;
  }): FileMetadata {
    return {
      path: row.path,
      hash: row.hash,
      size: row.size,
      modifiedAt: row.modified_at,
      versionVector: JSON.parse(row.version_vector) as VersionVector,
      lastModifier: row.last_modifier,
      isDeleted: row.is_deleted === 1
    };
  }

  upsertFile(file: FileMetadata): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(`
      INSERT INTO files (path, hash, size, modified_at, version_vector, last_modifier, is_deleted, last_updated)
      VALUES (@path, @hash, @size, @modifiedAt, @versionVector, @lastModifier, @isDeleted, @lastUpdated)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        size = excluded.size,
        modified_at = excluded.modified_at,
        version_vector = excluded.version_vector,
        last_modifier = excluded.last_modifier,
        is_deleted = excluded.is_deleted,
        last_updated = excluded.last_updated
    `);
    stmt.run({
      path: file.path,
      hash: file.hash,
      size: file.size,
      modifiedAt: file.modifiedAt,
      versionVector: JSON.stringify(file.versionVector),
      lastModifier: file.lastModifier,
      isDeleted: file.isDeleted ? 1 : 0,
      lastUpdated: Date.now()
    });
  }

  getFile(filePath: string): FileMetadata | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
    return row ? this.rowToFileMetadata(row as never) : null;
  }

  getAllFiles(): FileMetadata[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare('SELECT * FROM files ORDER BY path').all();
    return rows.map((r) => this.rowToFileMetadata(r as never));
  }

  deleteFile(filePath: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
  }

  addConflict(conflict: Omit<ConflictInfo, 'resolved'>): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(`
      INSERT INTO conflicts (id, path, local_version, remote_version, remote_node_id, remote_node_name, local_modified_at, remote_modified_at, resolved, created_at)
      VALUES (@id, @path, @localVersion, @remoteVersion, @remoteNodeId, @remoteNodeName, @localModifiedAt, @remoteModifiedAt, 0, @createdAt)
    `);
    stmt.run({
      id: conflict.id,
      path: conflict.path,
      localVersion: JSON.stringify(conflict.localVersion),
      remoteVersion: JSON.stringify(conflict.remoteVersion),
      remoteNodeId: conflict.remoteNodeId,
      remoteNodeName: conflict.remoteNodeName,
      localModifiedAt: conflict.localModifiedAt,
      remoteModifiedAt: conflict.remoteModifiedAt,
      createdAt: Date.now()
    });
  }

  resolveConflict(id: string, resolution: 'local' | 'remote' | 'merged'): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('UPDATE conflicts SET resolved = 1, resolution = ? WHERE id = ?').run(resolution, id);
  }

  getConflicts(onlyUnresolved = true): ConflictInfo[] {
    if (!this.db) throw new Error('Database not initialized');
    const sql = onlyUnresolved
      ? 'SELECT * FROM conflicts WHERE resolved = 0 ORDER BY created_at DESC'
      : 'SELECT * FROM conflicts ORDER BY created_at DESC LIMIT 100';
    const rows = this.db.prepare(sql).all() as Array<{
      id: string;
      path: string;
      local_version: string;
      remote_version: string;
      remote_node_id: string;
      remote_node_name: string;
      local_modified_at: number;
      remote_modified_at: number;
      resolved: number;
      resolution?: string;
    }>;
    return rows.map((r) => ({
        id: r.id,
        path: r.path,
        localVersion: JSON.parse(r.local_version) as VersionVector,
        remoteVersion: JSON.parse(r.remote_version) as VersionVector,
        remoteNodeId: r.remote_node_id,
        remoteNodeName: r.remote_node_name,
        localModifiedAt: r.local_modified_at,
        remoteModifiedAt: r.remote_modified_at,
        resolved: r.resolved === 1,
        resolution: (r.resolution as 'local' | 'remote' | 'merged' | undefined)
      })
    );
  }

  upsertPeer(peer: PeerNode): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(`
      INSERT INTO peers (id, name, address, port, last_seen, online)
      VALUES (@id, @name, @address, @port, @lastSeen, @online)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        address = excluded.address,
        port = excluded.port,
        last_seen = excluded.last_seen,
        online = excluded.online
    `);
    stmt.run({
      id: peer.id,
      name: peer.name,
      address: peer.address,
      port: peer.port,
      lastSeen: peer.lastSeen,
      online: peer.online ? 1 : 0
    });
  }

  setPeerOffline(peerId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('UPDATE peers SET online = 0 WHERE id = ?').run(peerId);
  }

  getAllPeers(): PeerNode[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db.prepare('SELECT * FROM peers ORDER BY last_seen DESC').all() as Array<{
      id: string;
      name: string;
      address: string;
      port: number;
      last_seen: number;
      online: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      address: r.address,
      port: r.port,
      lastSeen: r.last_seen,
      online: r.online === 1
    }));
  }

  addEvent(event: Omit<SyncEvent, 'timestamp'> & { timestamp?: number }): void {
    if (!this.db) throw new Error('Database not initialized');
    const stmt = this.db.prepare(`
      INSERT INTO events (type, timestamp, message, data)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(
      event.type,
      event.timestamp ?? Date.now(),
      event.message,
      event.data ? JSON.stringify(event.data) : null
    );
  }

  getRecentEvents(limit = 200): SyncEvent[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = this.db
      .prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as Array<{
        type: SyncEvent['type'];
        timestamp: number;
        message: string;
        data: string | null;
      }>;
    return rows
      .map((r) => ({
        type: r.type,
        timestamp: r.timestamp,
        message: r.message,
        data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : undefined
      }))
      .reverse();
  }

  getSetting(key: string): string | null {
    if (!this.db) throw new Error('Database not initialized');
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  }
}

export const dbManager = new DatabaseManager();
