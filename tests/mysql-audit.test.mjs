import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonStream, assessAudit } from '../integrations/mysql/audit.mjs';

const inventory={pkgSymbols:[{name:'synthetic.symbol'}]},metadata=[{config:{}},{SBOM:{}}];
test('Go audit parser handles streamed objects and quoted/escaped braces',()=>{
  const input=[{config:{description:'brace } and "quote"'}},{SBOM:{}},{finding:{osv:'GO-synthetic',trace:[{module:'synthetic'}]}}];
  assert.deepEqual(parseJsonStream(input.map(item=>JSON.stringify(item,null,2)).join('\n')),input);
});
test('Go audit rejects partial, empty and non-object output rather than treating it as clean',()=>{
  for(const text of ['', '  ', '{}\n{"unfinished":', '[]','{}invalid'])assert.throws(()=>parseJsonStream(text));
});
test('Go audit blocks package/symbol findings even when the scanner JSON command exits zero',()=>{
  for(const trace of [[{module:'synthetic',package:'synthetic/affected'}],[{module:'synthetic',function:'Affected'}]])
    assert.throws(()=>assessAudit([...metadata,{finding:{osv:'GO-synthetic',trace}}],inventory),/Linked vulnerable/);
  assert.throws(()=>assessAudit(metadata,{}),/symbol inventory/);
  assert.throws(()=>assessAudit([],inventory),/metadata is incomplete/);
  assert.throws(()=>assessAudit([...metadata,{finding:{osv:'GO-synthetic'}}],inventory),/Malformed/);
  assert.throws(()=>assessAudit([...metadata,{finding:null}],inventory),/Malformed/);
});
test('Go audit retains module-only matches explicitly without claiming the whole graph is clean',()=>{
  const summary=assessAudit([...metadata,{finding:{osv:'GO-synthetic',trace:[{module:'synthetic'}]}}],inventory);
  assert.deepEqual(summary.linkedAdvisories,[]);assert.deepEqual(summary.moduleOnlyAdvisories,['GO-synthetic']);
  assert.match(summary.note,/not a zero-advisory module graph claim/);
});
