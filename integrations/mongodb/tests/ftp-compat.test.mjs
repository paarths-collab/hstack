import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { Worker } from 'node:worker_threads';
const require=createRequire(new URL('../package.json',import.meta.url));
const { getUri }=require('get-uri');

test('get-uri FTP path still reads data with the patched basic-ftp dependency', { timeout:10000 }, async(t)=>{
  const sockets=new Set(),dataServers=new Set();
  let listed=false;
  const control=createServer((socket)=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    socket.setEncoding('utf8');socket.write('220 local synthetic fixture\r\n');
    let buffer='',dataSocket;
    let ready;
    socket.on('data',(chunk)=>{
      buffer+=chunk;
      let index;
      while((index=buffer.indexOf('\r\n'))!==-1){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+2);
        const command=line.split(' ')[0].toUpperCase();
        if(command==='USER')socket.write('331 password required\r\n');
        else if(command==='PASS')socket.write('230 logged in\r\n');
        else if(command==='FEAT')socket.write('211-Features\r\n UTF8\r\n211 End\r\n');
        else if(command==='PWD')socket.write('257 "/"\r\n');
        else if(command==='MDTM')socket.write('213 20200101000000\r\n');
        else if(command==='EPSV'){
          const data=createServer((connection)=>{ sockets.add(connection);connection.once('close',()=>sockets.delete(connection));ready(connection); });
          dataServers.add(data);
          dataSocket=new Promise((resolve)=>{ ready=resolve; });
          data.listen(0,'127.0.0.1',()=>socket.write(`229 Entering Extended Passive Mode (|||${data.address().port}|)\r\n`));
        }else if(command==='LIST'||command==='RETR'){
          if(command==='LIST')listed=true;
          socket.write('150 data follows\r\n');
          void dataSocket.then((connection)=>{
            connection.end(command==='LIST' ? '-rw-r--r-- 1 owner group 20 Jan 1 2020 fixture.txt\r\n' : 'synthetic-proxy-data');
            connection.once('close',()=>socket.write('226 transfer complete\r\n'));
          });
        }else if(command==='QUIT')socket.end('221 goodbye\r\n');
        else socket.write('200 accepted\r\n');
      }
    });
  });
  await new Promise((resolve)=>control.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    for(const socket of sockets)socket.destroy();
    await Promise.all([...dataServers,control].map((server)=>new Promise((resolve)=>server.close(resolve))));
  });
  const stream=await getUri(`ftp://synthetic:fixture@127.0.0.1:${control.address().port}/fixture.txt`);
  let data='';for await(const chunk of stream)data+=chunk;
  assert.equal(data,'synthetic-proxy-data');assert.ok(stream.lastModified instanceof Date);
  const client=new (require('basic-ftp').Client)();
  try {
    await client.access({ host:'127.0.0.1',port:control.address().port,user:'synthetic',password:'fixture' });
    const entries=await client.list('/');
    assert.equal(entries[0].name,'fixture.txt');assert.equal(listed,true);
  } finally { client.close(); }
});

test('patched Unix listing parser handles the advisory input within a bounded worker', { timeout:6000 },async(t)=>{
  const worker=new Worker(new URL('./fixtures/ftp-parser.mjs',import.meta.url));
  t.after(()=>worker.terminate());
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('FTP parser exceeded its regression budget')),3000);
    worker.once('message',(value)=>{ clearTimeout(timer);resolve(value); });
    worker.once('error',(error)=>{ clearTimeout(timer);reject(error); });
    worker.once('exit',(code)=>{ if(code!==0){clearTimeout(timer);reject(new Error('FTP parser worker failed'));} });
  });
  assert.equal(result,true);
});
