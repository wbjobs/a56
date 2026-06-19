import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { dbManager } from './database/manager';
import { syncEngine } from './services/sync-engine';

let mainWindow: BrowserWindow | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'LAN 文件夹同步',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

const broadcastToRenderer = (channel: string, getData: () => unknown): void => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, getData());
  }
};

const setupListeners = (): void => {
  syncEngine.on('status-changed', () =>
    broadcastToRenderer(IPC_CHANNELS.ON_SYNC_STATUS, () => syncEngine.getStatus())
  );
  syncEngine.on('files-changed', () =>
    broadcastToRenderer(IPC_CHANNELS.ON_FILES_CHANGED, () => syncEngine.getFiles())
  );
  syncEngine.on('conflicts-changed', () =>
    broadcastToRenderer(IPC_CHANNELS.ON_CONFLICTS_CHANGED, () => syncEngine.getConflicts())
  );
  syncEngine.on('peers-changed', () =>
    broadcastToRenderer(IPC_CHANNELS.ON_PEERS_CHANGED, () => syncEngine.getPeers())
  );
  syncEngine.on('new-event', () =>
    broadcastToRenderer(IPC_CHANNELS.ON_EVENT, () => syncEngine.getEvents())
  );
};

const setupIpc = (): void => {
  ipcMain.handle(IPC_CHANNELS.GET_SYNC_STATUS, () => syncEngine.getStatus());
  ipcMain.handle(IPC_CHANNELS.SET_SYNC_FOLDER, async (_e, folder: string) => {
    await syncEngine.setSyncFolder(folder);
    return syncEngine.getStatus();
  });
  ipcMain.handle(IPC_CHANNELS.START_SYNC, async () => {
    await syncEngine.start();
    return syncEngine.getStatus();
  });
  ipcMain.handle(IPC_CHANNELS.STOP_SYNC, async () => {
    await syncEngine.stop();
    return syncEngine.getStatus();
  });
  ipcMain.handle(IPC_CHANNELS.GET_FILES, () => syncEngine.getFiles());
  ipcMain.handle(IPC_CHANNELS.GET_CONFLICTS, () => syncEngine.getConflicts());
  ipcMain.handle(
    IPC_CHANNELS.RESOLVE_CONFLICT,
    async (_e, id: string, resolution: 'local' | 'remote' | 'merged') => {
      await syncEngine.resolveConflict(id, resolution);
      return syncEngine.getConflicts();
    }
  );
  ipcMain.handle(IPC_CHANNELS.GET_PEERS, () => syncEngine.getPeers());
  ipcMain.handle(IPC_CHANNELS.GET_EVENTS, () => syncEngine.getEvents());
  ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择要同步的文件夹'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
};

app.whenReady().then(async () => {
  dbManager.initialize();
  setupListeners();
  setupIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', async (e) => {
  if (syncEngine.getStatus().isRunning) {
    e.preventDefault();
    await syncEngine.stop();
    dbManager.close();
    app.quit();
  } else {
    dbManager.close();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
