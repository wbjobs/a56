import { create } from 'zustand';
import type {
  SyncStatus,
  FileMetadata,
  ConflictInfo,
  PeerNode,
  SyncEvent
} from '../../../shared/types';

interface SyncStore {
  status: SyncStatus;
  files: FileMetadata[];
  conflicts: ConflictInfo[];
  peers: PeerNode[];
  events: SyncEvent[];
  initialized: boolean;

  setStatus: (s: SyncStatus) => void;
  setFiles: (f: FileMetadata[]) => void;
  setConflicts: (c: ConflictInfo[]) => void;
  setPeers: (p: PeerNode[]) => void;
  setEvents: (e: SyncEvent[]) => void;
  setInitialized: (v: boolean) => void;
}

export const useSyncStore = create<SyncStore>((set) => ({
  status: {
    isRunning: false,
    syncFolder: null,
    connectedPeers: 0,
    totalFiles: 0,
    pendingConflicts: 0,
    lastSyncTime: null,
    error: null
  },
  files: [],
  conflicts: [],
  peers: [],
  events: [],
  initialized: false,

  setStatus: (status) => set({ status }),
  setFiles: (files) => set({ files }),
  setConflicts: (conflicts) => set({ conflicts }),
  setPeers: (peers) => set({ peers }),
  setEvents: (events) => set({ events }),
  setInitialized: (initialized) => set({ initialized })
}));
