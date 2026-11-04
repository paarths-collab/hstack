import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = dirname(fileURLToPath(import.meta.url));
const vendor = join(root, 'node_modules/@qboapi/qbo-mcp-server');
const output = join(root, 'build/compat');
const sourceTreeSha256 = '950464bd966f34acb9d59eeb1214b1daa6aa959d889e967eba383c43cd3c48af';

export async function sourceSnapshot(base, relative = 'src') {
  const entries = [];
  for (const entry of await readdir(join(base, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) entries.push(...await sourceSnapshot(base, path));
    else if (entry.isFile()) {
      const bytes = await readFile(join(base, path));
      entries.push([path, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')]);
    } else throw new Error('Unexpected non-regular Intuit source entry.');
  }
  return entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

export function replaceExactly(source, before, after, count = 1) {
  if (source.split(before).length - 1 !== count) throw new Error('Pinned compatibility patch no longer matches the reviewed source.');
  return source.replaceAll(before, after);
}

export function patchClient(source) {
  source = replaceExactly(source, 'dotenv.config({ path: TOKEN_STORE_PATH, override: true });',
    `// Hstack: capture launch policy before the private token store can override it.\nconst hstackNonInteractive = process.env.HSTACK_QUICKBOOKS_NON_INTERACTIVE === 'true';\nconst hstackReadOnly = process.env.HSTACK_QUICKBOOKS_READ_ONLY === 'true';\ndotenv.config({ path: TOKEN_STORE_PATH, override: true });\nif (hstackReadOnly) {\n  process.env.QUICKBOOKS_DISABLE_WRITE = 'true';\n  process.env.QUICKBOOKS_DISABLE_UPDATE = 'true';\n  process.env.QUICKBOOKS_DISABLE_DELETE = 'true';\n}`);
  return replaceExactly(source, 'private async startOAuthFlow(): Promise<void> {',
    `private async startOAuthFlow(): Promise<void> {\n    if (hstackNonInteractive) throw new Error('QuickBooks requires foreground sign-in. Stop the MCP clients and run the explicit vendor auth command, then reconnect.');`);
}

export function patchRecords(source) {
  return source.replaceAll('z.record(z.any())', 'z.record(z.string(), z.any())');
}

export function patchDecoder(source) {
  return replaceExactly(source, "const decodeComponent = require('decode-uri-component');",
    "// Hstack: query-string 6 expects a callable CommonJS export; decoder 0.5.1 is ESM.\nconst decodeComponent = require('decode-uri-component').default;");
}

/** Propagate the handler's explicit error flag instead of guessing from account text. */
export function patchToolErrors(source) {
  let count = 0, strictObjects = 0, optionalAny = 0;
  const file = ts.createSourceFile('tool.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = ts.transform(file, [(context) => {
    const markErrorReturns = (node) => {
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
        if (node.expression.properties.some((property) => property.name?.getText(file) === 'isError')) return node;
        count++;
        return ts.factory.updateReturnStatement(node, ts.factory.updateObjectLiteralExpression(node.expression,
          [ts.factory.createPropertyAssignment('isError', ts.factory.createTrue()), ...node.expression.properties]));
      }
      return ts.visitEachChild(node, markErrorReturns, context);
    };
    const visit = (node) => {
      if (ts.isIfStatement(node) && ['response.isError', '!parsed.success'].includes(node.expression.getText(file))) {
        return ts.factory.updateIfStatement(node, node.expression, markErrorReturns(node.thenStatement),
          node.elseStatement ? ts.visitNode(node.elseStatement, visit) : undefined);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'object' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'z') {
        strictObjects++;
        return ts.factory.updateCallExpression(node, ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('z'), 'strictObject'),
          node.typeArguments, node.arguments.map((argument) => ts.visitNode(argument, visit)));
      }
      if (ts.isPropertyAssignment(node)) {
        let expression = node.initializer, isAny = false, alreadyOptional = false;
        while (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
          if (expression.expression.name.text === 'optional') alreadyOptional = true;
          if (['any','unknown'].includes(expression.expression.name.text)
            && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === 'z') { isAny = true; break; }
          expression = expression.expression.expression;
        }
        if (isAny && !alreadyOptional) {
          optionalAny++;
          const initializer = ts.visitNode(node.initializer, visit);
          return ts.factory.updatePropertyAssignment(node, node.name,
            ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(initializer, 'optional'), undefined, []));
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return visit;
  }]);
  try { return { source: count || strictObjects || optionalAny ? ts.createPrinter().printFile(result.transformed[0]) : source, count, strictObjects, optionalAny }; }
  finally { result.dispose(); }
}

export async function buildQuickBooks() {
  const manifest = JSON.parse(await readFile(join(vendor, 'package.json'), 'utf8'));
  if (manifest.name !== '@qboapi/qbo-mcp-server' || manifest.version !== '0.0.1') throw new Error('Unexpected Intuit source package.');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const installed = lock.packages['node_modules/@qboapi/qbo-mcp-server'];
  if (!installed?.resolved?.endsWith('/31a1dd5c3e170e368dbff651abbaf61aabde6ed9') || !installed.integrity) throw new Error('The Intuit source must match the integrity-locked commit.');
  const entries = await sourceSnapshot(vendor);
  if (entries.length !== 298 || createHash('sha256').update(JSON.stringify(entries)).digest('hex') !== sourceTreeSha256) throw new Error('Installed source does not match the official pinned Git tree.');
  // Keep the installed vendor source unchanged; build a separately labelled copy.
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  await cp(join(vendor, 'src'), join(output, 'src'), { recursive: true });
  for (const filename of ['LICENSE', 'README.md']) await cp(join(vendor, filename), join(output, filename));
  const clientPath = join(output, 'src/clients/quickbooks-client.ts');
  await writeFile(clientPath, patchClient(await readFile(clientPath, 'utf8')));
  const registerPath = join(output, 'src/helpers/register-tool.ts');
  await writeFile(registerPath, replaceExactly(await readFile(registerPath, 'utf8'),
    'server.tool(toolDefinition.name, toolDefinition.description, { params: paramsSchema }, handler);',
    'server.registerTool(toolDefinition.name, { description: toolDefinition.description, inputSchema: z.strictObject({ params: paramsSchema }) }, handler as typeof baseHandler);'));
  let recordCount = 0, errorReturns = 0, strictObjects = 0, optionalAny = 0;
  for (const name of await readdir(join(output, 'src/tools'))) {
    if (!name.endsWith('.ts')) continue;
    const path = join(output, 'src/tools', name);
    let source = await readFile(path, 'utf8');
    if (name === 'search-accounts.tool.ts') {
      // This opaque schema is declared through a variable rather than inline.
      source = replaceExactly(source, 'const criteriaSchema = z.any();', 'const criteriaSchema = z.any().optional();');
      optionalAny++;
    }
    recordCount += source.split('z.record(z.any())').length - 1;
    const patched = patchToolErrors(patchRecords(source));
    errorReturns += patched.count;
    strictObjects += patched.strictObjects; optionalAny += patched.optionalAny;
    await writeFile(path, patched.source);
  }
  if (recordCount !== 9) throw new Error('Unexpected Zod record migration scope.');
  await mkdir(join(output, 'node_modules'), { recursive: true });
  for (const name of ['intuit-oauth', 'query-string']) {
    await cp(join(root, 'node_modules', name), join(output, 'node_modules', name), { recursive: true });
  }
  const decoderPath = join(output, 'node_modules/query-string/index.js');
  const decoderSource = await readFile(decoderPath, 'utf8');
  if (createHash('sha256').update(decoderSource).digest('hex') !== 'e1cfef0cb504e8e820431dbaf79ada5e8c531795b5cbdb37f329ed1cf8a8b036') throw new Error('Unexpected query-string compatibility source.');
  await writeFile(decoderPath, patchDecoder(decoderSource));
  await writeFile(join(output, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(output, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: 'dist',
    esModuleInterop: true, forceConsistentCasingInFileNames: true, strict: true, skipLibCheck: true,
  }, include: ['src/**/*.ts'] }));
  const compiler = join(root, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [compiler, '-p', join(output, 'tsconfig.json')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('QuickBooks compatibility compilation failed.');
  const client = await readFile(join(output, 'dist/clients/quickbooks-client.js'));
  return { commit: '31a1dd5c3e170e368dbff651abbaf61aabde6ed9', build: 'hstack-compat-1',
    sourceTreeSha256, sourceFiles: entries.length,
    clientSha256: createHash('sha256').update(client).digest('hex'), migratedRecords: recordCount, errorReturns, strictObjects, optionalAny };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(JSON.stringify(await buildQuickBooks())); }
  catch (error) { console.error(error instanceof Error ? error.message : 'QuickBooks compatibility build failed.'); process.exitCode = 1; }
}
