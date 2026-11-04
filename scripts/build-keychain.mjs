import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, renameSync, rmSync, chmodSync, mkdtempSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

if (process.platform === 'darwin' && !['keyfile', 'plaintext'].includes(process.env.HSTACK_CREDENTIAL_BACKEND)) {
  const source = resolve('native/keychain.swift'), target = resolve('dist/keychain-helper');
  const hash = createHash('sha256').update(readFileSync(source)).update(process.arch).digest('hex');
  if (!existsSync(target) || !existsSync(`${target}.sha256`) || readFileSync(`${target}.sha256`, 'utf8') !== hash) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    const cache = mkdtempSync(join(tmpdir(), 'hstack-swift-cache-'));
    try {
      const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', cache, source, '-o', temporary], {encoding:'utf8',timeout:120_000});
      if (result.status !== 0) {
        console.error('Hstack Keychain helper build failed. Install the macOS command line developer tools or use the explicit keyfile backend.');
        process.exitCode=1;
      } else {
        chmodSync(temporary,0o700);renameSync(temporary,target);writeFileSync(`${target}.sha256`,hash,{mode:0o600});
      }
    } finally {rmSync(temporary,{force:true});rmSync(cache,{recursive:true,force:true})}
  }
}
