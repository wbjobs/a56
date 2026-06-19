import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebSocket } from 'ws';
import type { FileMetadata, VersionVector, PeerNode } from '../../shared/types';
import { v4 as uuidv4 } from 'uuid';

const PEER_DISCOVERY_RANGE_START = 100;
const PEER_DISCOVERY_RANGE_END = 254;
const PEER_DEFAULT_PORT_MIN = 30000;
const PEER_DEFAULT_PORT_MAX = 30100;

export interface NetworkClientHandlers {
  onPeerDiscovered: (peer: PeerNode) => void;
  onPeerLost: (peerId: string) => void;
  onRemoteFileChanged: (peer: PeerNode, metadata: FileMetadata) => Promise<void>;
  onRemoteFileDeleted: (peer: PeerNode, relPath: string, vv: VersionVector) => Promise<void>;
}

interface WsMessage {
  type: 'peer-announce' | 'peer-leave' | 'file-changed' | 'file-deleted' | 'request-full-sync' | 'ping' | 'pong';
  data: unknown;
}

export class NetworkClient {
  private handlers: NetworkClientHandlers | null = null;
  private knownPeers = new Map<string, PeerNode & { ws?: WebSocket }>();
  private scanTimer: NodeJS.Timeout | null = null;
  private nodeId = '';
  private nodeName = '';
  private nodePort = 0;
  private isScanning = false;

  setHandlers(handlers: NetworkClientHandlers): void {
    this.handlers = handlers;
  }

  setLocalNodeInfo(id: string, name: string, port: number): void {
    this.nodeId = id;
    this.nodeName = name;
    this.nodePort = port;
  }

  private getLocalSubnets(): string[] {
    const nets = os.networkInterfaces();
    const subnets: string[] = [];
    for (const net of Object.values(nets)) {
      if (!net) continue;
      for (const n of net) {
        if (n.family === 'IPv4' && !n.internal) {
          const parts = n.address.split('.');
          parts.pop();
          subnets.push(parts.join('.'));
        }
      }
    }
    return [...new Set(subnets)];
  }

  async discoverPeers(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;
    const subnets = this.getLocalSubnets();
    const addresses: string[] = [];

    for (const subnet of subnets) {
      for (let i = PEER_DISCOVERY_RANGE_START; i <= PEER_DISCOVERY_RANGE_END; i++) {
        addresses.push(`${subnet}.${i}`);
      }
    }

    const now = Date.now();
    for (let port = PEER_DEFAULT_PORT_MIN; port <= PEER_DEFAULT_PORT_MAX; port++) {
      for (const addr of addresses.slice(0, 30)) {
        const key = `${addr}:${port}`;
        const existing = [...this.knownPeers.values()].find(
          (p) => p.address === addr && p.port === port
        );
        if (existing && now - existing.lastSeen < 10000) continue;
        this.tryConnect(addr, port).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    this.isScanning = false;
  }

  private async tryConnect(address: string, port: number): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`http://${address}:${port}/node-info`, {
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) return;
      const info = (await res.json()) as { id: string; name: string; port: number };
      if (info.id === this.nodeId) return;

      const peer: PeerNode = {
        id: info.id,
        name: info.name,
        address,
        port,
        lastSeen: Date.now(),
        online: true
      };

      this.knownPeers.set(peer.id, peer);
      this.handlers?.onPeerDiscovered(peer);
      this.openWebSocket(peer);
    } catch {
      // connection failed
    }
  }

  private openWebSocket(peer: PeerNode): void {
    try {
      const existing = this.knownPeers.get(peer.id);
      if (existing?.ws && existing.ws.readyState <= 1) return;

      const ws = new WebSocket(`ws://${peer.address}:${peer.port}`);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'peer-announce',
            data: {
              id: this.nodeId,
              name: this.nodeName,
              address: '',
              port: this.nodePort,
              lastSeen: Date.now(),
              online: true
            } as PeerNode
          } as WsMessage)
        );
        this.knownPeers.set(peer.id, { ...peer, ws, lastSeen: Date.now(), online: true });
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data.toString()) as WsMessage;
          this.handleWsMessage(peer, msg);
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        const p = this.knownPeers.get(peer.id);
        if (p) {
          this.knownPeers.set(peer.id, { ...p, online: false, ws: undefined });
        }
        this.handlers?.onPeerLost(peer.id);
      };
      ws.onerror = () => {
        ws.close();
      };
    } catch {
      // ignore
    }
  }

  private handleWsMessage(peer: PeerNode, msg: WsMessage): void {
    switch (msg.type) {
      case 'peer-announce': {
        const p = msg.data as PeerNode;
        if (p.id !== peer.id) return;
        this.knownPeers.set(peer.id, { ...peer, name: p.name, lastSeen: Date.now(), online: true });
        this.handlers?.onPeerDiscovered({ ...peer, name: p.name, online: true });
        break;
      }
      case 'peer-leave': {
        const peerId = msg.data as string;
        this.knownPeers.delete(peerId);
        this.handlers?.onPeerLost(peerId);
        break;
      }
      default:
        break;
    }
  }

  startPeriodicDiscovery(): void {
    this.discoverPeers();
    this.scanTimer = setInterval(() => {
      this.discoverPeers();
      this.checkPeerAlive();
    }, 15000);
  }

  private checkPeerAlive(): void {
    const now = Date.now();
    for (const [id, peer] of this.knownPeers) {
      if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
        try {
          peer.ws.send(JSON.stringify({ type: 'ping', data: now } as WsMessage));
        } catch {
          // close on error
        }
      }
      if (now - peer.lastSeen > 45000 && peer.online) {
        this.knownPeers.set(id, { ...peer, online: false });
        this.handlers?.onPeerLost(id);
      }
    }
  }

  stopPeriodicDiscovery(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  getKnownPeers(): PeerNode[] {
    return [...this.knownPeers.values()].map(({ ws, ...p }) => p);
  }

  async fetchPeerFiles(peer: PeerNode): Promise<FileMetadata[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`http://${peer.address}:${peer.port}/files`, {
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) return [];
      const data = (await res.json()) as { files: FileMetadata[] };
      return data.files;
    } catch {
      return [];
    }
  }

  async downloadFile(peer: PeerNode, relPath: string): Promise<Buffer | null> {
    try {
      const encodedPath = encodeURIComponent(relPath);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(`http://${peer.address}:${peer.port}/files/${encodedPath}`, {
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch {
      return null;
    }
  }

  async uploadFile(
    peer: PeerNode,
    relPath: string,
    filePath: string,
    metadata: FileMetadata
  ): Promise<'updated' | 'conflict' | 'ignored' | null> {
    try {
      const formData = new FormData();
      const fileBlob = new Blob([fs.readFileSync(filePath)], { type: 'application/octet-stream' });
      formData.append('file', fileBlob as unknown as File, path.basename(filePath));
      formData.append('metadata', JSON.stringify(metadata));
      formData.append('senderNodeId', this.nodeId);

      const encodedPath = encodeURIComponent(relPath);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      const res = await fetch(`http://${peer.address}:${peer.port}/upload/${encodedPath}`, {
        method: 'POST',
        body: formData as unknown as BodyInit,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data = (await res.json()) as { result: 'updated' | 'conflict' | 'ignored' };
      return data.result;
    } catch {
      return null;
    }
  }

  async sendDelete(
    peer: PeerNode,
    relPath: string,
    versionVector: VersionVector
  ): Promise<'updated' | 'conflict' | 'ignored' | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`http://${peer.address}:${peer.port}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: relPath,
          versionVector,
          senderNodeId: this.nodeId
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data = (await res.json()) as { result: 'updated' | 'conflict' | 'ignored' };
      return data.result;
    } catch {
      return null;
    }
  }

  announceShutdown(): void {
    for (const peer of this.knownPeers.values()) {
      if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
        try {
          peer.ws.send(
            JSON.stringify({ type: 'peer-leave', data: this.nodeId } as WsMessage)
          );
        } catch {
          // ignore
        }
      }
    }
  }

  stop(): void {
    this.announceShutdown();
    this.stopPeriodicDiscovery();
    for (const peer of this.knownPeers.values()) {
      if (peer.ws) {
        try {
          peer.ws.close();
        } catch {
          // ignore
        }
      }
    }
    this.knownPeers.clear();
  }

  private tempFileSuffix = () => `.tmp-${uuidv4().slice(0, 8)}`;
}

export const networkClient = new NetworkClient();
