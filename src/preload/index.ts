import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type {
  SyncStatus,
  FileMetadata,
  ConflictInfo,
  PeerNode,
  SyncEvent
} from '../shared/types';

const api = {
  getSyncStatus: (): Promise<SyncStatus> => ipcRenderer.invoke(IPC_CHANNELS.GET_SYNC_STATUS),
  setSyncFolder: (folder: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SET_SYNC_FOLDER, folder),
  startSync: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.START_SYNC),
  stopSync: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.STOP_SYNC),
  getFiles: (): Promise<FileMetadata[]> => ipcRenderer.invoke(IPC_CHANNELS.GET_FILES),
  getConflicts: (): Promise<ConflictInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.GET_CONFLICTS),
  resolveConflict: (id: string, resolution: 'local' | 'remote' | 'merged'): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.RESOLVE_CONFLICT, id, resolution),
  getPeers: (): Promise<PeerNode[]> => ipcRenderer.invoke(IPC_CHANNELS.GET_PEERS),
  getEvents: (): Promise<SyncEvent[]> => ipcRenderer.invoke(IPC_CHANNELS.GET_EVENTS),
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER),

  onSyncStatus: (callback: (status: SyncStatus) => void) => {
    const listener = (_e: unknown, status: SyncStatus) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.ON_SYNC_STATUS, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ON_SYNC_STATUS, listener);
  },
  onFilesChanged: (callback: (files: FileMetadata[]) => void) => {
    const listener = (_e: unknown, files: FileMetadata[]) => callback(files);
    ipcRenderer.on(IPC_CHANNELS.ON_FILES_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ON_FILES_CHANGED, listener);
  },
  onConflictsChanged: (callback: (conflicts: ConflictInfo[]) => void) => {
    const listener = (_e: unknown, conflicts: ConflictInfo[]) => callback(conflicts);
    ipcRenderer.on(IPC_CHANNELS.ON_CONFLICTS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ON_CONFLICTS_CHANGED, listener);
  },
  onPeersChanged: (callback: (peers: PeerNode[]) => void) => {
    const listener = (_e: unknown, peers: PeerNode[]) => callback(peers);
    ipcRenderer.on(IPC_CHANNELS.ON_PEERS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ON_PEERS_CHANGED, listener);
  },
  onEvent: (callback: (events: SyncEvent[]) => void) => {
    const listener = (_e: unknown, events: SyncEvent[]) => callback(events);
    ipcRenderer.on(IPC_CHANNELS.ON_EVENT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ON_EVENT, listener);
  }
};

contextBridge.exposeInMainWorld('lanSync', api);

export type LanSyncAPI = typeof api;
