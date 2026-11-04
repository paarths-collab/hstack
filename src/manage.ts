import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseConnections, loadConnection, resolveConnection } from './connections.js';
import { oauthStore, loginOAuth, type OAuthConnection } from './oauth.js';
import { DiscoveryError } from './errors.js';
import { verifyService, hasOperationalVerifier } from './verify-service.js';
import { checkSetup } from './setup-check.js';
import { planConnections, prepareConnections, setupCatalogue } from './prepare.js';

// Explicit local setup utility; never launched by the MCP server or the agent.
const path = process.env.HSTACK_CONNECTIONS_FILE ?? fileURLToPath(new URL('../connections.json', import.meta.url));
try {
  const [action, id, ...extra] = process.argv.slice(2);
  const batch = action === 'plan' || action === 'prepare';
  if ((!batch && extra.length) || !['init', 'list', 'catalog', 'plan', 'prepare', 'doctor', 'check', 'verify', 'login', 'disconnect', 'migrate-credentials'].includes(action ?? '')
    || (['plan', 'prepare', 'doctor', 'check', 'verify', 'login', 'disconnect', 'migrate-credentials'].includes(action!) ? !id : !!id)) {
    throw new DiscoveryError('Usage: node --env-file=.env dist/manage.js init|list|catalog|plan <id...>|prepare <id...>|doctor <id>|check <id>|verify <id>|login <id>|disconnect <id>|migrate-credentials <id>');
  }
  if (action === 'catalog') {
    for (const entry of await setupCatalogue()) console.log(`${entry.id}: ${entry.canPrepare ? 'candidate template available' : 'vendor setup unresolved'}; ${entry.evidence}`);
  } else if (batch) {
    const ids = [id!,...extra];
    if (action === 'plan') console.log(JSON.stringify(await planConnections(path,ids),null,2));
    else {
      const prepared = await prepareConnections(path,ids);
      for (const item of prepared.plan.selections) console.log(`${item.id}: ${item.action}`);
      console.log(`Candidate: ${prepared.candidatePath}`);
      console.log('Review the private candidate before selecting it with HSTACK_CONNECTIONS_FILE. The source file was preserved; nothing was activated.');
      console.log('The candidate is a snapshot. Later source-file edits are not merged automatically. No install, sign-in or tool execution has run.');
    }
  } else if (action === 'init') {
    const example = await readFile(new URL('../connections.example.json', import.meta.url), 'utf8');
    try { await writeFile(path, example, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DiscoveryError('connections.json already exists; your configuration was preserved.');
      throw error;
    }
    console.log('Created disabled connection templates. Choose a service and follow docs/connections.md.');
  } else {
    const configs = parseConnections(JSON.parse(await readFile(path, 'utf8')));
    if (action === 'list') {
      for (const config of configs) console.log(`${config.id}: ${config.enabled ? 'enabled' : 'disabled'}; ${config.oauth ? 'OAuth login' : config.transport === 'http' ? 'environment credential' : 'configured local executable'}`);
    } else {
      const config = configs.find((item) => item.id === id);
      if (!config) throw new DiscoveryError('Unknown connection ID. Run list first.');
      if (action === 'doctor') {
        const report = await checkSetup(config, process.env);
        // Public bundled guidance only; never inspect credentials or contact a vendor here.
        const catalogue = JSON.parse(await readFile(new URL('../catalog/services.json', import.meta.url), 'utf8')) as Array<{ id:string; setupGuide?:string; setupRequirements?:string[] }>;
        const guide = catalogue.find((entry) => entry.id === config.id);
        if (guide?.setupGuide && /^integrations\/[a-z0-9-]+\/README\.md$/.test(guide.setupGuide)) report.notes.push(`Setup guide: ${guide.setupGuide}`);
        for (const requirement of guide?.setupRequirements ?? []) report.notes.push(`Vendor prerequisite: ${requirement}`);
        console.log(`${config.id}: ${report.issues.length ? 'setup incomplete' : 'offline prerequisites checked; vendor access unverified'}`);
        for (const issue of report.issues) console.log(`- Missing/fix: ${issue}`);
        for (const note of report.notes) console.log(`- ${note}`);
        if (report.issues.length) process.exitCode = 1;
      } else if (action === 'check' || action === 'verify') {
        if (action === 'verify' && !hasOperationalVerifier(config.id)) throw new DiscoveryError('Operational verification is currently implemented for Redis, Mailchimp, MongoDB, MySQL, Zendesk, QuickBooks and Google Analytics only; check verifies discovery for other services.');
        const provider = await loadConnection(config, process.env);
        try {
          if (action === 'verify') {
            await verifyService(provider);
            console.log(`${config.id}: ${config.id === 'redis' ? 'database' : config.id === 'mongodb' ? 'database-list' : config.id === 'mysql' ? 'database schema' : config.id === 'zendesk' ? 'API group' : config.id === 'quickbooks' ? 'company API' : config.id === 'google-analytics' ? 'account-summary API' : 'API audience'} read verified. No account content printed. No write executed.`);
          } else {
            console.log(`${config.id}: MCP discovery succeeded; ${provider.tools.length} tools discovered. No tool was executed. Account operations remain unverified.`);
            for (const tool of provider.tools) console.log(`- ${tool.name}`);
          }
        } finally { await provider.close?.(); }
      } else {
        if (!config.oauth) throw new DiscoveryError('This connection uses environment credentials or an external sign-in flow; follow its vendor setup instructions.');
        const oauthConfig = resolveConnection(config, process.env) as OAuthConnection;
        if (action === 'migrate-credentials') {
          const store = oauthStore(oauthConfig, process.env);
          const changed = await store.locked(AbortSignal.timeout(30_000), () => store.migrate());
          console.log(changed ? 'Legacy OAuth credentials encrypted. No vendor request was made.' : 'No plaintext OAuth credentials needed migration.');
        } else if (action === 'login') {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
          try {
            await loginOAuth(oauthConfig, process.env, async (url) => {
              // Authorization URL has state/PKCE, never an access token or secret. Review before opening.
              console.log('Open this URL in your own browser to review permissions and sign in:');
              console.log(url.href);
            }, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]));
            console.log(`${config.id}: OAuth credentials saved locally. Run check ${config.id} to verify MCP access; no tools have run.`);
          } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
        } else {
          const store = oauthStore(oauthConfig, process.env);
          await store.locked(AbortSignal.timeout(30_000), () => store.remove());
          console.log(`${config.id}: local OAuth credentials removed. Restart Hstack. Revoke access in the vendor account settings separately.`);
        }
      }
    }
  }
} catch (error) {
  console.error(error instanceof DiscoveryError ? error.message : 'Setup failed. Check configuration and local file permissions; raw errors are hidden.');
  process.exitCode = 1;
}
