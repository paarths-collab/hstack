import { DiscoveryError } from './errors.js';
import { desktopSocialAction } from './desktop-credentials.js';

// Private IPC: requests arrive on stdin; never print keys or provider responses.
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) throw new Error('Request too large.');
  }
  const result = await desktopSocialAction(JSON.parse(input), process.env);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  const recovery = error instanceof DiscoveryError ? error.details.recovery : undefined;
  process.stdout.write(JSON.stringify(recovery === 'migrate_credentials'
    ? {state:'migration_required',message:'Existing plaintext credentials need migration. Choose Encrypt existing key, or save a replacement.'}
    : recovery === 'unlock_credentials'
    ? {state:'vault_unavailable',message:'Unlock the system keychain or check the configured private master-key file. No plaintext fallback was used.'}
    : { state: 'error', message: 'Could not complete the request. Check your key, network and private storage permissions.' }));
  process.exitCode = 1;
}
