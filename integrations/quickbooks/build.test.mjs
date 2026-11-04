import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { patchClient, patchDecoder, patchRecords, patchToolErrors, replaceExactly } from './build.mjs';

test('source patches reject upstream drift and protect launch policy before dotenv overrides',()=>{
  assert.throws(()=>replaceExactly('none','missing','replacement'));
  assert.throws(()=>replaceExactly('x x','x','y'));
  const source=patchClient("dotenv.config({ path: TOKEN_STORE_PATH, override: true });\nprivate async startOAuthFlow(): Promise<void> {");
  assert.ok(source.indexOf('const hstackNonInteractive')<source.indexOf('dotenv.config'));
  assert.match(source,/if \(hstackNonInteractive\) throw new Error/);
  assert.match(source,/QUICKBOOKS_DISABLE_DELETE = 'true'/);
});

test('Zod record migration retains explicit string-keyed dictionaries',()=>{
  assert.equal(patchRecords('z.record(z.any())'),'z.record(z.string(), z.any())');
});

test('AST error fix marks only explicit error branches and leaves successful payloads intact',()=>{
  const source='function tool(response) { if (response.isError) return {content: [{text: response.error}]}; return {content: [{text: "Error: is allowed user data"}]}; }';
  const patched=patchToolErrors(source);assert.equal(patched.count,1);
  const js=ts.transpile(patched.source);const context={};vm.createContext(context);vm.runInContext(js,context);
  assert.equal(context.tool({isError:true,error:'synthetic'}).isError,true);
  assert.equal(context.tool({isError:false}).isError,undefined);
  assert.equal(context.tool({isError:false}).content[0].text,'Error: is allowed user data');
  assert.equal(patchToolErrors('if (!parsed.success) { return {content: []}; }').count,1);
});

test('Zod upgrade retains strict object contracts and the original optional any-valued fields',()=>{
  const patched=patchToolErrors('const schema=z.object({ payload:z.any().describe("Opaque payload"), optional:z.any().optional(), items:z.array(z.any()) });');
  assert.equal(patched.strictObjects,1);assert.equal(patched.optionalAny,1);
  assert.match(patched.source,/z.strictObject/);
  assert.match(patched.source,/z.any\(\).describe\("Opaque payload"\).optional\(\)/);
  assert.doesNotMatch(patched.source,/optional\(\).optional\(\)/);
  const multiline=patchToolErrors('const schema = z\n.object({ criteria:z.unknown().describe("criteria") });');
  assert.equal(multiline.strictObjects,1);assert.equal(multiline.optionalAny,1);
});

test('installed patched decoder works through the actual native OAuth query parser',()=>{
  const require=createRequire(new URL('./build/compat/node_modules/intuit-oauth/src/OAuthClient.js',import.meta.url));
  const query=require('query-string');
  assert.equal(query.parse('code=%E2%9C%93&state=synthetic').code,'✓');
  assert.equal(query.parse('code=synthetic%20value').code,'synthetic value');
  assert.equal(typeof query.parse('code=%E0%A4%A').code,'string');
});

test('decoder compatibility selects the patched ESM default callable for the legacy query parser',()=>{
  const source=patchDecoder("const decodeComponent = require('decode-uri-component');\nglobalThis.result = decodeComponent('%E2%9C%93');");
  const context={require:()=>({default:decodeURIComponent})};vm.createContext(context);vm.runInContext(source,context);
  assert.equal(context.result,'✓');
});
