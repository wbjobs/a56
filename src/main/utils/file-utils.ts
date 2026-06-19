import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function getFileStats(filePath: string): Promise<{
  size: number;
  modifiedAt: number;
  hash: string;
}> {
  const stats = fs.statSync(filePath);
  const hash = await computeFileHash(filePath);
  return {
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    hash
  };
}

export function relativePath(folder: string, filePath: string): string {
  const rel = path.relative(folder, filePath);
  return rel.split(path.sep).join('/');
}

export function absolutePath(folder: string, relPath: string): string {
  const parts = relPath.split('/');
  return path.join(folder, ...parts);
}

export function ensureDirectoryForFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function writeFileWithBackup(filePath: string, data: Buffer): void {
  ensureDirectoryForFile(filePath);
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak-${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, data);
}

export function deleteFileSafely(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export interface ScanResult {
  path: string;
  size: number;
  modifiedAt: number;
}

export function scanFolder(folder: string): ScanResult[] {
  const results: ScanResult[] = [];

  function walk(currentPath: string): void {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stats = fs.statSync(fullPath);
          results.push({
            path: relativePath(folder, fullPath),
            size: stats.size,
            modifiedAt: stats.mtimeMs
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  if (fs.existsSync(folder)) {
    walk(folder);
  }
  return results;
}
