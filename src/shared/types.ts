export type NodeId = string;
export type FileVersion = number;
export type FilePath = string;

export interface VersionVector {
  [nodeId: NodeId]: FileVersion;
}

export interface FileMetadata {
  path: FilePath;
  hash: string;
  size: number;
  modifiedAt: number;
  lastUpdated: number;
  versionVector: VersionVector;
  lastModifier: NodeId;
  isDeleted: boolean;
}

export interface ConflictInfo {
  id: string;
  path: FilePath;
  localVersion: VersionVector;
  remoteVersion: VersionVector;
  remoteNodeId: NodeId;
  remoteNodeName: string;
  localModifiedAt: number;
  remoteModifiedAt: number;
  resolved: boolean;
  resolution?: 'local' | 'remote' | 'merged';
}

export interface PeerNode {
  id: NodeId;
  name: string;
  address: string;
  port: number;
  lastSeen: number;
  online: boolean;
}

export interface SyncStatus {
  isRunning: boolean;
  syncFolder: string | null;
  connectedPeers: number;
  totalFiles: number;
  pendingConflicts: number;
  lastSyncTime: number | null;
  error: string | null;
}

export type SyncEventType =
  | 'file-added'
  | 'file-modified'
  | 'file-deleted'
  | 'conflict-detected'
  | 'sync-started'
  | 'sync-completed'
  | 'peer-connected'
  | 'peer-disconnected'
  | 'error';

export interface SyncEvent {
  type: SyncEventType;
  timestamp: number;
  message: string;
  data?: Record<string, unknown>;
}

export const compareVersionVectors = (
  a: VersionVector,
  b: VersionVector
): 'equal' | 'a-greater' | 'b-greater' | 'conflict' => {
  const allNodes = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGreater = false;
  let bGreater = false;

  for (const node of allNodes) {
    const av = a[node] || 0;
    const bv = b[node] || 0;
    if (av > bv) aGreater = true;
    if (bv > av) bGreater = true;
  }

  if (aGreater && bGreater) return 'conflict';
  if (aGreater) return 'a-greater';
  if (bGreater) return 'b-greater';
  return 'equal';
};

export const mergeVersionVectors = (a: VersionVector, b: VersionVector): VersionVector => {
  const result: VersionVector = { ...a };
  for (const [node, version] of Object.entries(b)) {
    result[node] = Math.max(result[node] || 0, version);
  }
  return result;
};
