'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), native = require('node:fs');
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const stream = native.createReadStream;
let reads = [];
native.createReadStream = function(file, ...args) { reads.push(String(file)); return stream.call(this, file, ...args); };
const {Engine} = require('../src/engine.cjs');
native.createReadStream = stream;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'revision-cache-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), base);
    assert(path.basename(resolved).startsWith('revision-cache-test-'));
    await fs.rm(resolved, {recursive:true, force:true});
  });
  const destination = path.join(root, 'target'); await fs.mkdir(destination);
  const job = {id:'fixture', destination}, publications = new Map(), objects = new Map(), downloads = [], progress = [];
  function publish(id, name, old, next) {
    const record = {format:'quark-file-revision',schema_version:1,revision_id:id,path:name,
      previous_sha256:hash(old),sha256:hash(next),size:Buffer.byteLength(next),reason:'reviewed',
      created_at:'2026-09-15T00:00:00Z',content_path:'.sync-revisions/objects/'+hash(next)};
    publications.set(id+'.json', {record, entry:{file_name:id+'.json',file:true,size:JSON.stringify(record).length,
      fid:id,updated_at:1000,created_at:900,l_updated_at:1000}});
    objects.set(record.content_path,next); return record;
  }
  const record = publish('r1','28.zip','OLD','NEW');
  await fs.writeFile(path.join(destination,'28.zip'),'OLD');
  const client = {list:async fid => fid==='root' ? [{file_name:'.sync-revisions',dir:true,fid:'revisions'}]
    : fid==='revisions' ? [{file_name:'records',dir:true,fid:'records'}]
    : [...publications.values()].map(p=>({...p.entry}))};
  let engine, mountCalls=0, active=0, peak=0;
  const f = {root,destination,job,record,publications,publish,downloads,progress, fail:null, onDownload:null};
  f.restart = () => {
    engine = new Engine({dataDir:root,update:(_id,s)=>progress.push(s),log(){},persist:async()=>{},notify(){}});
    engine.mount = async () => {mountCalls++; return '/fixture'};
    engine.downloadFile = async (_mount,rel,file) => {
      downloads.push(rel); active++; peak=Math.max(peak,active);
      try {
        await new Promise(r=>setTimeout(r,5));
        if(f.fail===rel)throw Error('simulated download failure');
        await f.onDownload?.(rel);
        const text = objects.get(rel) ?? JSON.stringify(publications.get(path.basename(rel)).record);
        await fs.writeFile(file,text);
      } finally {active--}
    };
  };
  f.restart();
  f.apply = (options={}) => engine.applyRevisions(job,'root',client,options.signal ?? new AbortController().signal,options);
  f.reset = () => {downloads.length=0;reads=[];mountCalls=0;peak=0};
  f.reads = () => reads.filter(p=>p===path.join(destination,'28.zip')).length;
  f.mounts = () => mountCalls;
  f.peak = () => peak;
  return f;
}

test('unchanged checks and restart reuse records and archive hashes without mounting the downloader',async t=>{
  const f=await fixture(t); assert.equal((await f.apply()).updated,1);
  for(let i=0;i<2;i++) {
    f.reset();f.restart();const result=await f.apply();
    assert.equal(result.updated,0);assert.deepEqual(f.downloads,[]);assert.equal(f.reads(),0);assert.equal(f.mounts(),0);
    assert.match(result.summary,/记录复用 1\/1.*文件复用 1\/1/);
  }
});
test('one new publication only downloads the new record and object',async t=>{
  const f=await fixture(t);await f.apply();f.reset();
  f.publish('r2','other.zip','before','after');
  assert.equal((await f.apply()).updated,1);
  assert.deepEqual(f.downloads.filter(p=>p.includes('/records/')),['.sync-revisions/records/r2.json']);
  assert.equal(f.reads(),0);
});
test('same-size local edit with restored mtime invalidates verification and retains the edited bytes',async t=>{
  const f=await fixture(t);await f.apply();f.reset();
  const file=path.join(f.destination,'28.zip'),stat=await fs.stat(file);
  await fs.writeFile(file,'BAD');await fs.utimes(file,stat.atime,stat.mtime);
  assert.equal((await f.apply()).updated,1);assert(f.reads()>0);
  assert.deepEqual(f.downloads,[f.record.content_path]);
  assert.equal(await fs.readFile(path.join(f.destination,'.sync-recycle',hash('BAD'),'28.zip'),'utf8'),'BAD');
});
test('changed cloud identity or timestamp rechecks records and detects immutable record edits',async t=>{
  for(const field of ['fid','updated_at','l_updated_at','size'])await t.test(field,async t=>{
    const f=await fixture(t);await f.apply();f.reset();
    const p=f.publications.get('r1.json');p.entry[field]=typeof p.entry[field]==='number'?p.entry[field]+1:'changed';
    p.record={...p.record,reason:'changed'};
    await assert.rejects(f.apply,/同编号修订记录已改变/);
    assert.equal(f.downloads.length,1);
    assert.equal(await fs.readFile(path.join(f.destination,'28.zip'),'utf8'),'NEW');
  });
});
test('cached canonical records still require identical new copies and complete history',async t=>{
  const f=await fixture(t);await f.apply();f.reset();
  f.publications.set('r1(1).json',{record:{...f.record,reason:'conflict'},entry:{...f.publications.get('r1.json').entry,file_name:'r1(1).json',fid:'copy'}});
  await assert.rejects(f.apply,/副本内容冲突/);
  assert.deepEqual(f.downloads,['.sync-revisions/records/r1(1).json']);
  f.publications.clear();await assert.rejects(f.apply,/缺少已应用/);
});
test('missing or damaged cache, metadata, and explicit force fall back to full verification',async t=>{
  for(const kind of ['missing','malformed','null','checksum','metadata','force'])await t.test(kind,async t=>{
    const f=await fixture(t);await f.apply();f.reset();
    const cache=path.join(f.root,'revision-cache-fixture.json');
    if(kind==='missing')await fs.unlink(cache);
    if(kind==='malformed')await fs.writeFile(cache,'{');
    if(kind==='null')await fs.writeFile(cache,'null');
    if(kind==='checksum') {const data=JSON.parse(await fs.readFile(cache,'utf8'));data.sha256='0'.repeat(64);await fs.writeFile(cache,JSON.stringify(data))}
    if(kind==='metadata')delete f.publications.get('r1.json').entry.updated_at;
    await f.apply({force:kind==='force'});
    assert.equal(f.downloads.length,1);
    if(kind!=='metadata')assert(f.reads()>0);
  });
});
test('failed explicit full verification cannot reuse the old successful receipts',async t=>{
  const f=await fixture(t);await f.apply();f.reset();
  f.fail='.sync-revisions/records/r1.json';await assert.rejects(()=>f.apply({force:true}),/simulated/);
  f.fail=null;f.reset();f.restart();await f.apply();
  assert.equal(f.downloads.length,1);assert(f.reads()>0);
});
test('local record edits are not hidden by cached cloud publications',async t=>{
  const f=await fixture(t);await f.apply();f.reset();
  await fs.writeFile(path.join(f.destination,'.sync-revisions/records/r1.json'),JSON.stringify({...f.record,reason:'edited'}));
  await assert.rejects(f.apply,/同编号修订记录已改变/);assert.equal(f.downloads.length,0);
});
test('engine forwards full verification and retains the reuse summary after a zero-new scan',async t=>{
  const f=await fixture(t),forces=[],states=[];
  const engine=new Engine({dataDir:f.root,quark:{list:async()=>[]},update:(_id,s)=>states.push(s),log(){},persist:async()=>{},notify(){}});
  engine.applyRevisions=async(_job,_fid,_client,_signal,options)=>{
    forces.push(options.force);return{paths:new Set(['28.zip']),updated:0,summary:'修订记录复用 1/1，文件复用 1/1，更新 0'};
  };
  const job={...f.job,source:{kind:'drive',fid:'root'},revisionUpdates:true,interval:60};
  await engine.run(job);await engine.run(job,{forceRevisions:true});
  assert.deepEqual(forces,[false,true]);assert.match(states.at(-1).current,/没有新增文件.*文件复用 1\/1/);
  assert.equal(states.at(-1).skipped,1);assert.match(states.at(-1).current,/已跳过 1 个已有文件/);
});
test('cached verification does not bypass pending audit recovery or missing target repair',async t=>{
  const f=await fixture(t);await f.apply();f.reset();
  const pending=path.join(f.destination,'.sync-revisions/pending/r1.json');
  await fs.writeFile(pending,JSON.stringify(f.record));
  await f.apply();await assert.rejects(fs.stat(pending),{code:'ENOENT'});
  await fs.unlink(path.join(f.destination,'28.zip'));f.reset();
  assert.equal((await f.apply()).updated,1);assert.deepEqual(f.downloads,[f.record.content_path]);
});
test('partial downloads are reusable after restart while failed records are retried',async t=>{
  const f=await fixture(t);f.publish('r2','other.zip','old','next');
  f.fail='.sync-revisions/records/r2.json';await assert.rejects(f.apply,/simulated/);
  f.fail=null;f.reset();f.restart();await f.apply();
  assert.deepEqual(f.downloads.filter(p=>p.includes('/records/')),['.sync-revisions/records/r2.json']);
});
test('cold record downloads are bounded and cancellation never claims a complete run',async t=>{
  const f=await fixture(t);for(let i=2;i<=9;i++)f.publish('r'+i,i+'.zip','old','next'+i);
  await f.apply();assert(f.peak()>1);assert(f.peak()<=4);
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>f.apply({signal:controller.signal}),{name:'AbortError'});
});
