import fs from 'node:fs';
import path from 'node:path';

/** 模型 API Key 受保护存储：存 <dataDir>/secrets.json，Key 永不进数据库/日志/事件 */
export class SecretsStore {
  #file: string;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'secrets.json');
  }

  #load(): Record<string, string> {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  #save(map: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(this.#file, JSON.stringify(map, null, 2), 'utf8');
    try {
      fs.chmodSync(this.#file, 0o600);
    } catch {
      // Windows 上 chmod 可能无效，忽略
    }
  }

  set(ref: string, key: string): void {
    const map = this.#load();
    map[ref] = key;
    this.#save(map);
  }

  get(ref: string): string | null {
    return this.#load()[ref] ?? null;
  }

  delete(ref: string): boolean {
    const map = this.#load();
    if (!(ref in map)) return false;
    delete map[ref];
    this.#save(map);
    return true;
  }
}
