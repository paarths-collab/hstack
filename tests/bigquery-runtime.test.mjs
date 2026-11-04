import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyBigQueryRuntime } from '../scripts/verify-bigquery-runtime.mjs';

test('actual Hstack stdio process performs native refresh and cached metadata reads, blocks SQL and never opens a socket (synthetic)',async()=>{
  const result=await verifyBigQueryRuntime();
  assert.deepEqual(result.counts,{refreshes:1,reads:2,sql:0,initializations:1,discovery:1,mcpPosts:5});
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.equal(result.nativeHermes,undefined);
});
