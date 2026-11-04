import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
const require=createRequire(new URL('../../package.json',import.meta.url));
const { parseList }=require('basic-ftp/dist/parseList');
const malformed='-rw-r--r-- 1 '+'a '.repeat(65536)+'!';
const entries=parseList(`${malformed}\r\n-rw-r--r-- 1 owner group 20 Jan 1 2020 fixture.txt\r\n`);
parentPort.postMessage(entries.some((entry)=>entry.name==='fixture.txt'));
