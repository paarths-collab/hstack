#!/usr/bin/env node
import { validateQuickBooksStore } from '../../dist/vendor-lock.js';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg !== '--allow-native-writes')) throw new Error('Unsupported QuickBooks launcher option.');
  await validateQuickBooksStore(process.env.QUICKBOOKS_TOKEN_STORE_PATH);
  process.env.HSTACK_QUICKBOOKS_NON_INTERACTIVE = 'true';
  process.env.HSTACK_QUICKBOOKS_READ_ONLY = args.includes('--allow-native-writes') ? 'false' : 'true';
  await import('./build/compat/dist/index.js');
} catch {
  console.error('QuickBooks could not start. Build the pinned compatibility runtime and configure a private native token-store file first.');
  process.exitCode = 1;
}
