import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitWithSignal } from '../dist/cancellation.js';

test('waiting on queued work is cancellable before the work completes',async()=>{
 let complete;
 const work=new Promise(resolve=>{complete=resolve;});
 const abort=new AbortController();
 const waiting=waitWithSignal(work,abort.signal);
 abort.abort();
 await assert.rejects(waiting,error=>error.details.code==='CANCELLED');
 complete('late result');
});

test('already aborted waiting still observes a later work rejection',async()=>{
 let fail;
 const work=new Promise((_,reject)=>{fail=reject;});
 const abort=new AbortController();abort.abort();
 await assert.rejects(waitWithSignal(work,abort.signal));
 fail(new Error('late work failure'));
 await new Promise(resolve=>setImmediate(resolve));
});

test('normal values and failures pass through unchanged',async()=>{
 const signal=new AbortController().signal;
 assert.equal(await waitWithSignal(Promise.resolve(7),signal),7);
 const error=new Error('fixture');
 await assert.rejects(waitWithSignal(Promise.reject(error),signal),actual=>actual===error);
});
