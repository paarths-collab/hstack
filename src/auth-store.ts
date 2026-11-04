import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encryptedEnvelope } from './credential-codec.js';
import type { CredentialCodec } from './credential-codec.js';
import { DiscoveryError } from './errors.js';

const unsafe = () => new DiscoveryError('OAuth storage is unsafe or unreadable. Use a private, owner-only directory; symlinks are not supported.', { code: 'UNAVAILABLE' });

/** Atomic owner-only storage, optionally sealed by the credential vault.
 * Callers hold the lock throughout refresh, migration and use. */
export class AuthStore {
  readonly path: string;
  readonly lockPath: string;
  constructor(readonly root: string, binding: unknown, private readonly codec?: CredentialCodec) {
    if (!isAbsolute(root) || process.platform === 'win32') throw unsafe();
    const key = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
    this.path = join(root, `${key}.json`);
    this.lockPath = join(root, `${key}.lock`);
  }

  static root(env: NodeJS.ProcessEnv): string {
    return env.HSTACK_STATE_DIR ?? join(homedir(), '.hstack-auth');
  }

  private async prepare() {
    try {
      await mkdir(this.root, { mode: 0o700 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafe(); }
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || info.uid !== process.getuid?.()) throw unsafe();
  }

  async locked<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.prepare();
    while (true) {
      if (signal.aborted) throw new DiscoveryError('OAuth credential lock wait cancelled or timed out.', {
        code: signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED',
      });
      try { await mkdir(this.lockPath, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafe();
        let info;
        try { info = await lstat(this.lockPath); }
        catch (error) {
          // The previous owner may release between mkdir(EEXIST) and lstat.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw unsafe();
        }
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
          || info.uid !== process.getuid?.()) throw unsafe();
        // Never steal a lock: a paused process could still rotate a refresh token.
        try { await delay(25, undefined, { signal }); } catch { /* checked above */ }
      }
    }
    try { return await operation(); }
    finally { await rmdir(this.lockPath); }
  }

  private async readBytes(): Promise<string | undefined> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()
        || info.size > 1_000_000 || info.nlink !== 1) throw unsafe();
      return await handle.readFile('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw unsafe();
    } finally { await handle?.close(); }
  }

  private async readRaw(): Promise<unknown | undefined> {
    const bytes = await this.readBytes();
    if (bytes === undefined) return undefined;
    try { return JSON.parse(bytes); } catch { throw unsafe(); }
  }

  async read(): Promise<unknown | undefined> {
    const value = await this.readRaw();
    if (value === undefined) return undefined;
    if (this.codec) return this.codec.open(value, this.path);
    if (encryptedEnvelope(value)) throw new DiscoveryError('Encrypted credentials require their configured vault backend. No plaintext fallback was used.', {code:'UNAVAILABLE', recovery:'unlock_credentials'});
    return value;
  }

  async write(value: unknown): Promise<void> {
    await this.read();
    await this.replace(value);
  }

  /** Explicit replacement can recover from a lost key; never follows unsafe files. */
  async replace(value: unknown): Promise<void> {
    await this.readBytes();
    const stored = this.codec ? await this.codec.seal(value, this.path) : value;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(stored));
      await handle.sync();
      await handle.close();
      await rename(temporary, this.path);
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => {});
    }
  }

  async migrate(): Promise<boolean> {
    if (!this.codec) throw new DiscoveryError('Choose an encrypted credential backend before migration.', {code:'UNAVAILABLE'});
    const value = await this.readRaw();
    if (value === undefined) return false;
    if (encryptedEnvelope(value)) { await this.read(); return false; }
    await this.replace(value);
    return true;
  }

  async remove(): Promise<void> {
    // Local disconnect remains possible even when the keychain is locked.
    if (await this.readBytes() !== undefined) await unlink(this.path);
  }
}
