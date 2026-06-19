import { useEffect, useMemo, useState } from 'react';
import type { VersionVector } from '../../shared/types';
import { useSyncStore } from './store/syncStore';

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: undefined
  });
};

const formatRelativeTime = (ts: number): string => {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return formatTime(ts);
};

const shortNodeId = (id: string): string => id.slice(0, 8);

const formatVersionVector = (vv: VersionVector): React.ReactNode => {
  const entries = Object.entries(vv);
  if (entries.length === 0) return <span className="vv-tag">空</span>;
  return (
    <span className="version-display">
      {entries.map(([n, v]) => (
        <span key={n} className="version-entry">
          {shortNodeId(n)}: v{v}
        </span>
      ))}
    </span>
  );
};

const getFileIcon = (name: string, isDeleted: boolean): string => {
  if (isDeleted) return '🗑️';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return '🖼️';
  if (['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) return '🎵';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'h', 'json', 'html', 'css', 'yaml', 'yml', 'toml', 'md'].includes(ext)) return '💻';
  if (['txt', 'log'].includes(ext)) return '📄';
  return '📄';
};

const getEventTypeIcon = (type: string): string => {
  switch (type) {
    case 'file-added': return '➕';
    case 'file-modified': return '✏️';
    case 'file-deleted': return '🗑️';
    case 'conflict-detected': return '⚠️';
    case 'sync-started': return '▶️';
    case 'sync-completed': return '✅';
    case 'peer-connected': return '🔌';
    case 'peer-disconnected': return '📴';
    case 'error': return '❌';
    default: return 'ℹ️';
  }
};

export default function App() {
  const store = useSyncStore();
  const [searchFiles, setSearchFiles] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);

  useEffect(() => {
    const init = async (): Promise<void> => {
      const [status, files, conflicts, peers, events] = await Promise.all([
        window.lanSync.getSyncStatus(),
        window.lanSync.getFiles(),
        window.lanSync.getConflicts(),
        window.lanSync.getPeers(),
        window.lanSync.getEvents()
      ]);
      store.setStatus(status);
      store.setFiles(files);
      store.setConflicts(conflicts);
      store.setPeers(peers);
      store.setEvents(events);
      store.setInitialized(true);
    };
    init();

    const offStatus = window.lanSync.onSyncStatus((s) => store.setStatus(s));
    const offFiles = window.lanSync.onFilesChanged((f) => store.setFiles(f));
    const offConflicts = window.lanSync.onConflictsChanged((c) => store.setConflicts(c));
    const offPeers = window.lanSync.onPeersChanged((p) => store.setPeers(p));
    const offEvents = window.lanSync.onEvent((e) => store.setEvents(e));

    return () => {
      offStatus?.();
      offFiles?.();
      offConflicts?.();
      offPeers?.();
      offEvents?.();
    };
  }, [store]);

  const handleSelectFolder = async (): Promise<void> => {
    const folder = await window.lanSync.selectFolder();
    if (folder) {
      await window.lanSync.setSyncFolder(folder);
      if (!store.status.isRunning) {
        await window.lanSync.startSync();
      }
    }
  };

  const handleStart = async (): Promise<void> => {
    await window.lanSync.startSync();
  };

  const handleStop = async (): Promise<void> => {
    await window.lanSync.stopSync();
  };

  const handleResolve = async (
    id: string,
    resolution: 'local' | 'remote' | 'merged'
  ): Promise<void> => {
    setResolving(id);
    try {
      await window.lanSync.resolveConflict(id, resolution);
    } finally {
      setResolving(null);
    }
  };

  const handleResolveAll = async (
    resolution: 'local' | 'remote' | 'merged'
  ): Promise<void> => {
    setResolving('all');
    try {
      await window.lanSync.resolveAllConflicts(resolution);
    } finally {
      setResolving(null);
    }
  };

  const filteredFiles = useMemo(() => {
    if (!searchFiles) return store.files;
    const q = searchFiles.toLowerCase();
    return store.files.filter((f) => f.path.toLowerCase().includes(q));
  }, [store.files, searchFiles]);

  const { status, conflicts, peers, events, initialized } = store;
  const onlinePeers = peers.filter((p) => p.online).length;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">L</div>
          <div>
            <div className="app-title">LAN 文件夹同步</div>
            <div className="app-subtitle">基于版本向量的局域网文件同步工具</div>
          </div>
        </div>
        <div className="header-right">
          {status.syncFolder && (
            <div className="folder-info" title={status.syncFolder}>
              <span>📁</span>
              <span className="folder-info-path">{status.syncFolder}</span>
            </div>
          )}
          <span className={`status-indicator ${status.isRunning ? 'running' : 'stopped'}`}>
            <span className="status-dot" />
            {status.isRunning ? '同步中' : '已停止'}
          </span>
          <button className="btn btn-secondary" onClick={handleSelectFolder}>
            📂 选择文件夹
          </button>
          {status.isRunning ? (
            <button className="btn btn-danger" onClick={handleStop}>
              ⏹ 停止同步
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={handleStart}
              disabled={!status.syncFolder}
            >
              ▶ 启动同步
            </button>
          )}
        </div>
      </header>

      <main className="main">
        <section className="panel-top">
          <div className="stat-card">
            <div className="stat-label">📊 文件总数</div>
            <div className="stat-value accent">{initialized ? status.totalFiles : '—'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">🌐 在线节点</div>
            <div className={`stat-value ${onlinePeers > 0 ? 'success' : ''}`}>
              {initialized ? `${onlinePeers}` : '—'}
              <span className="stat-value small" style={{ color: 'var(--text-muted)' }}>
                {' '}/ {peers.length}
              </span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">⚠️ 待解决冲突</div>
            <div className={`stat-value ${conflicts.length > 0 ? 'danger' : ''}`}>
              {initialized ? conflicts.length : '—'}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">🕒 最后同步</div>
            <div className="stat-value small">
              {initialized ? (status.lastSyncTime ? formatRelativeTime(status.lastSyncTime) : '尚未同步') : '—'}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              📁 文件列表 <span className="badge badge-accent">{filteredFiles.length}</span>
            </div>
          </div>
          <div className="filter-bar">
            <input
              type="text"
              className="filter-input"
              placeholder="🔍 搜索文件名..."
              value={searchFiles}
              onChange={(e) => setSearchFiles(e.target.value)}
            />
          </div>
          <div className="panel-content">
            {!initialized ? (
              <div className="empty-state">
                <div className="empty-state-icon">⏳</div>
                <div className="empty-state-text">加载中...</div>
              </div>
            ) : filteredFiles.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📂</div>
                <div className="empty-state-text">
                  {status.syncFolder ? '尚无文件记录' : '请选择要同步的文件夹以开始'}
                </div>
              </div>
            ) : (
              filteredFiles.map((file) => (
                <div key={file.path} className={`file-item ${file.isDeleted ? 'file-deleted' : ''}`}>
                  <div className="file-icon">{getFileIcon(file.path, file.isDeleted)}</div>
                  <div className="file-info">
                    <div className="file-name" title={file.path}>{file.path}</div>
                    <div className="file-meta">
                      <span>{formatBytes(file.size)}</span>
                      <span>修改于 {formatTime(file.modifiedAt)}</span>
                      <span className="vv-tag">修改者: {shortNodeId(file.lastModifier)}</span>
                    </div>
                    {formatVersionVector(file.versionVector)}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              ⚠️ 冲突文件 <span className={`badge ${conflicts.length > 0 ? 'badge-warning' : 'badge-success'}`}>{conflicts.length}</span>
            </div>
            {conflicts.length > 0 && (
              <div className="conflict-bulk-actions">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={resolving === 'all'}
                  onClick={() => handleResolveAll('local')}
                >
                  🖥️ 全部保留本地
                </button>
                <button
                  className="btn btn-warning btn-sm"
                  disabled={resolving === 'all'}
                  onClick={() => handleResolveAll('remote')}
                >
                  🌐 全部保留远程
                </button>
              </div>
            )}
          </div>
          <div className="panel-content">
            {!initialized ? (
              <div className="empty-state">
                <div className="empty-state-icon">⏳</div>
                <div className="empty-state-text">加载中...</div>
              </div>
            ) : conflicts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">✅</div>
                <div className="empty-state-text">暂无冲突，一切正常！</div>
              </div>
            ) : (
              conflicts.map((c) => (
              <div key={c.id} className="conflict-item">
                <div className="conflict-header">
                  <div className="conflict-path">⚠️ {c.path}</div>
                </div>
                <div className="conflict-body">
                  <div className="conflict-side local">
                    <div className="conflict-side-title">本地版本</div>
                    <div className="conflict-side-info">
                      修改于 {formatTime(c.localModifiedAt)}
                      <small>{formatVersionVector(c.localVersion)}</small>
                    </div>
                  </div>
                  <div className="conflict-vs">VS</div>
                  <div className="conflict-side remote">
                    <div className="conflict-side-title">远程版本 ({c.remoteNodeName})</div>
                    <div className="conflict-side-info">
                      修改于 {formatTime(c.remoteModifiedAt)}
                      <small>{formatVersionVector(c.remoteVersion)}</small>
                    </div>
                  </div>
                </div>
                <div className="conflict-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={resolving === c.id}
                    onClick={() => handleResolve(c.id, 'local')}
                  >
                    💻 保留本地
                  </button>
                  <button
                    className="btn btn-warning btn-sm"
                    disabled={resolving === c.id}
                    onClick={() => handleResolve(c.id, 'remote')}
                  >
                    🌐 保留远程
                  </button>
                  <button
                    className="btn btn-success btn-sm"
                    disabled={resolving === c.id}
                    onClick={() => handleResolve(c.id, 'merged')}
                  >
                    🔀 手动合并（本地+版本合并）
                  </button>
                </div>
              </div>
            ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              🌐 网络节点 <span className="badge badge-accent">{onlinePeers}在线</span>
            </div>
          </div>
          <div className="panel-content">
            {!initialized ? (
              <div className="empty-state">
                <div className="empty-state-icon">⏳</div>
                <div className="empty-state-text">加载中...</div>
              </div>
            ) : peers.length === 0 ? (
              <div className="empty-state">
              <div className="empty-state-icon">🔍</div>
              <div className="empty-state-text">
                {status.isRunning ? '正在扫描局域网中的节点...' : '启动同步后自动发现节点'}
              </div>
            </div>
            ) : (
              peers.map((p) => (
                <div key={p.id} className="peer-item">
                  <div className={`peer-status ${p.online ? 'online' : 'offline'}`} />
                  <div className="peer-info">
                    <div className="peer-name">{p.name}</div>
                    <div className="peer-address">{p.address}:{p.port}</div>
                  </div>
                  <div className="peer-last-seen">{formatRelativeTime(p.lastSeen)}</div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              📜 同步日志 <span className="badge badge-accent">{events.length}</span>
            </div>
          </div>
          <div className="panel-content">
            {!initialized ? (
              <div className="empty-state">
                <div className="empty-state-icon">⏳</div>
                <div className="empty-state-text">加载中...</div>
              </div>
            ) : events.length === 0 ? (
              <div className="empty-state">
              <div className="empty-state-icon">📝</div>
                <div className="empty-state-text">暂无活动记录</div>
              </div>
            ) : (
              events.map((e, i) => (
                <div key={i} className="event-item">
                  <span className="event-type-icon">{getEventTypeIcon(e.type)}</span>
                  <div className="event-body">
                    <div className="event-message">{e.message}</div>
                  </div>
                  <div className="event-time">{formatTime(e.timestamp)}</div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
