import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { FileMetadata, VersionVector, PeerNode, SyncEventType } from '../../shared/types';
import {
  absolutePath,
  computeFileHash,
  ensureDirectoryForFile,
  relativePath
} from '../utils/file-utils';

const PORT = 0;

export interface NetworkServerHandlers {
  getSyncFolder: () => string | null;
  getNodeId: () => string;
  getNodeName: () => string;
  getAllFiles: () => FileMetadata[];
  getFileMetadata: (relPath: string) => FileMetadata | null;
  onRemoteFileChange: (metadata: FileMetadata, senderNodeId: string) => Promise<'updated' | 'conflict' | 'ignored'>;
  onRemoteFileDelete: (relPath: string, versionVector: VersionVector, senderNodeId: string) => Promise<'updated' | 'conflict' | 'ignored'>;
  onPeerAnnounce: (peer: PeerNode) => void;
  onPeerLeave: (peerId: string) => void;
  getPeers: () => PeerNode[];
}

interface WsPeerMessage {
  type: 'peer-announce' | 'peer-leave' | 'file-changed' | 'file-deleted' | 'request-full-sync' | 'ping' | 'pong';
  data: unknown;
}

export class NetworkServer {
  private app: express.Express;
  private server: http.Server;
  private wss: WebSocketServer;
  private handlers: NetworkServerHandlers | null = null;
  private listeningPort = 0;
  private upload: multer.Multer;
  private connectedClients = new Map<string, WebSocket>();
  private tempDir: string;

  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.tempDir = path.join(os.tmpdir(), `lan-sync-${uuidv4().slice(0, 8)}`);
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    this.upload = multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, this.tempDir),
        filename: (req, file, cb) => cb(null, uuidv4())
      }),
      limits: { fileSize: 1024 * 1024 * 1024 }
    });
    this.setupRoutes();
    this.setupWebSocket();
  }

  setHandlers(handlers: NetworkServerHandlers): void {
    this.handlers = handlers;
  }

  private setupRoutes(): void {
    this.app.use(cors());
    this.app.use(express.json({ limit: '50mb' }));

    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', nodeId: this.handlers?.getNodeId() });
    });

    this.app.get('/node-info', (req, res) => {
      if (!this.handlers) return res.status(500).json({ error: 'not initialized' });
      res.json({
        id: this.handlers.getNodeId(),
        name: this.handlers.getNodeName(),
        port: this.listeningPort
      });
    });

    this.app.get('/files', (req, res) => {
      if (!this.handlers) return res.status(500).json({ error: 'not initialized' });
      res.json({ files: this.handlers.getAllFiles() });
    });

    this.app.get('/files/:filePath(*)', (req, res) => {
      if (!this.handlers) return res.status(500).json({ error: 'not initialized' });
      const folder = this.handlers.getSyncFolder();
      if (!folder) return res.status(404).json({ error: 'no sync folder' });
      const relPath = decodeURIComponent(req.params.filePath);
      const absPath = absolutePath(folder, relPath);
      if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'file not found' });
      res.download(absPath, path.basename(absPath));
    });

    this.app.get('/metadata/:filePath(*)', (req, res) => {
      if (!this.handlers) return res.status(500).json({ error: 'not initialized' });
      const relPath = decodeURIComponent(req.params.filePath);
      const meta = this.handlers.getFileMetadata(relPath);
      if (!meta) return res.status(404).json({ error: 'not found' });
      res.json(meta);
    });

    this.app.post('/upload/:filePath(*)', this.upload.single('file'), async (req, res) => {
      if (!this.handlers) return res.status(500).json({ error: 'not initialized' });
      const folder = this.handlers.getSyncFolder();
      if (!folder) return res.status(400).json({ error: 'no sync folder' });

      const relPath = decodeURIComponent(req.params.filePath);
      const absPath = absolutePath(folder, relPath);
      const metadata = JSON.parse(req.body.metadata) as FileMetadata;
      const senderNodeId = req.body.senderNodeId as string;

      if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

      try {
        const uploadedHash = await computeFileHash(req.file.path);
        if (uploadedHash !== metadata.hash) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: 'hash mismatch' });
        }

        ensureDirectoryForFile(absPath);
        fs.copyFileSync(req.file.path, absPath);
        fs.unlinkSync(req.file.path);

        fs.utimesSync(absPath, metadata.modifiedAt / 1000, metadata.modifiedAt / 1000);

        const result = await this.handlers.onRemoteFileChange(metadata, senderNodeId);
        res.json({ result });
      } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    this.app.post('/delete', async (req, res) => {
      if (!this.handlers) return res.status(500).json({ error: 'not initialized' });
      const folder = this.handlers.getSyncFolder();
      if (!folder) return res.status(400).json({ error: 'no sync folder' });

      const { path: relPath, versionVector, senderNodeId } = req.body as {
        path: string;
        versionVector: VersionVector;
        senderNodeId: string;
      };

      const absPath = absolutePath(folder, relPath);
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
      }

      const result = await this.handlers.onRemoteFileDelete(relPath, versionVector, senderNodeId);
      res.json({ result });
    });

    this.app.get('/peers', (req, res) => {
      if (!this.handlers) return res.status(500).json({ error: 'not initialized' });
      res.json({ peers: this.handlers.getPeers() });
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      const clientId = uuidv4();
      this.connectedClients.set(clientId, ws);

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as WsPeerMessage;
          await this.handleMessage(ws, msg, clientId);
        } catch {
          // ignore parse errors
        }
      });

      ws.on('close', () => {
        this.connectedClients.delete(clientId);
      });

      ws.on('error', () => {
        this.connectedClients.delete(clientId);
      });
    });
  }

  private async handleMessage(ws: WebSocket, msg: WsPeerMessage, _clientId: string): Promise<void> {
    if (!this.handlers) return;

    switch (msg.type) {
      case 'peer-announce': {
        const peer = msg.data as PeerNode;
        this.handlers.onPeerAnnounce(peer);
        this.handlers.onPeerAnnounce({
          id: this.handlers.getNodeId(),
          name: this.handlers.getNodeName(),
          address: '',
          port: this.listeningPort,
          lastSeen: Date.now(),
          online: true
        });
        break;
      }
      case 'peer-leave': {
        const peerId = msg.data as string;
        this.handlers.onPeerLeave(peerId);
        break;
      }
      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong', data: Date.now() } as WsPeerMessage));
        break;
      }
      case 'pong':
        break;
      case 'file-changed':
      case 'file-deleted':
      case 'request-full-sync':
        break;
    }
  }

  broadcastToPeers(message: WsPeerMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.connectedClients.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(PORT, () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this.listeningPort = addr.port;
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get port'));
        }
      });
      this.server.on('error', reject);
    });
  }

  getPort(): number {
    return this.listeningPort;
  }

  getLocalAddresses(): string[] {
    const nets = os.networkInterfaces();
    const addresses: string[] = [];
    for (const net of Object.values(nets)) {
      if (!net) continue;
      for (const n of net) {
        if (n.family === 'IPv4' && !n.internal) {
          addresses.push(n.address);
        }
      }
    }
    return addresses;
  }

  stop(): void {
    this.wss.close();
    this.server.close();
    for (const ws of this.connectedClients.values()) {
      ws.close();
    }
    this.connectedClients.clear();
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }
}

export const networkServer = new NetworkServer();
