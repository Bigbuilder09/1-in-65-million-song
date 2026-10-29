const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'game-save.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const flags = ['balanceFixFrom','billionaireFrom','clubMoralFrom','clubRandomFrom','storyV2From','storyV3From','storyV4From','storyV5From','storyV6From','caseResolutionFrom','bossCombatFrom','memorialStoryFrom','bossStoryFrom'];
const game = () => ({ seed:42, events:[], ...Object.fromEntries(flags.map(f => [f,0])) });
const remote = (id='hero') => ({ id, engine:'o65m-replay-1', payload:JSON.stringify(game()), name:'Hero', age:10, generation:1, revision:1 });
function server() {
  return { records:new Map([['hero',remote()]]), watchers:[], offline:false, beforeWrite:null,
    emit() { const data=clone([...this.records.values()]); this.watchers.forEach(fn=>fn(data)); },
    advance(id='hero') { const record=this.records.get(id); const g=JSON.parse(record.payload);g.events.push({gate:'choice',value:1});record.payload=JSON.stringify(g);record.revision++;record.age++;this.emit(); }
  };
}
function device(server, { guest=false, local=null, ready=Promise.resolve() }={}) {
  const all=[], nodes=new Map(), listeners={}, docListeners={}, storage=new Map(), timers=new Map();
  let reads=0,writes=0,reloads=0,nextTimer=0,storageFailure=false;
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.events={};this.textContent='';this.removed=false;all.push(this);}
    append(...nodes){this.children.push(...nodes);}
    addEventListener(name,fn){(this.events[name] ||= []).push(fn);}
    setAttribute(){}
    querySelector(selector){return this.children.find(n=>n.tag===selector)||null;}
    showModal(){this.open=true;}
    close(){this.open=false;(this.events.close||[]).forEach(fn=>fn());}
    remove(){this.removed=true;}
    replaceChildren(){this.children=[];}
  }
  const body=new Element('body');
  for(const name of ['#syncBtn','#charactersBtn','#restartBtn'])nodes.set(name,new Element('button'));
  const document={body,hidden:false,createElement:tag=>new Element(tag),querySelector:s=>nodes.get(s)||all.find(n=>'#'+n.id===s&&!n.removed)||null,addEventListener:(name,fn)=>docListeners[name]=fn};
  if(local)storage.set('o65m_characters_v1:account',JSON.stringify([local]));
  const context={document,console:{warn(){}},crypto:require('node:crypto').webcrypto,TextEncoder,
    location:{reload(){reloads++;}},sessionStorage:{getItem:key=>key==='o65m_open'?'hero':null,setItem(){},removeItem(){}},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>{if(storageFailure)throw Error('quota');storage.set(key,value);}},
    setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),addEventListener:(name,fn)=>listeners[name]=fn,
    alert:message=>{throw Error(message);}, confirm:()=>true,
    CloudSave:{configured:true,user:guest?null:{uid:'account'},ready,
      async logout(){this.user=null;},
      async list(){reads++;if(server.offline)throw Error('offline');return clone([...server.records.values()]);},
      watch(fn){server.watchers.push(fn);return ()=>server.watchers.splice(server.watchers.indexOf(fn),1);},
      async write(record){writes++;if(server.offline)throw Error('offline');await server.beforeWrite?.(record);
        const found=server.records.get(record.id);
        if((found?.revision||0)!==record.cloudRevision)return {conflict:clone(found)};
        const revision=(found?.revision||0)+1;
        server.records.set(record.id,{id:record.id,engine:record.engine,payload:JSON.stringify(record.game),name:record.name,age:record.age,generation:record.generation,revision});
        server.emit();return {revision};
      }
    }
  };
  context.window=context;vm.createContext(context);vm.runInContext(source,context);
  return {api:context.SaveGame,context,nodes,timers,all,docListeners,listeners,
    async start(){const record=await this.api.init();if(record)this.api.start(record);return record;},
    choose(value=1){let finish;this.api.gate('choice',fn=>{finish=fn;});finish(value);},
    prompt(){this.api.gate('choice',()=>{});},
    saves(){return JSON.parse(storage.get('o65m_characters_v1:'+(guest?'guest':'account'))||'[]');},
    dialog(){return document.querySelector('#saveConflict');},
    async click(label){const button=all.find(n=>n.tag==='button'&&n.textContent===label&&!n.removed);assert.ok(button,label);for(const fn of button.events.click||[])await fn({currentTarget:button});},
    status(){return body.children.find(n=>n.id==='saveBar').children[0].textContent;},
    failStorage(value){storageFailure=value;},stats:()=>({reads,writes,reloads})
  };
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('two devices opening an unchanged save never upload or conflict',async()=>{
 const s=server(),a=device(s),b=device(s);await a.start();await b.start();a.prompt();b.prompt();await a.api.sync();await b.api.sync();
 assert.equal(a.stats().writes+b.stats().writes,0);assert.equal(a.dialog(),null);assert.equal(b.dialog(),null);
});
test('new remote progress prompts the active device without modifying its running log',async()=>{
 const s=server(),a=device(s),b=device(s);await a.start();await b.start();a.choose();await a.api.sync();
 assert.ok(b.dialog());assert.equal(b.api.active.game.events.length,0);assert.equal(b.stats().writes,0);
 await b.click('โหลดเซฟออนไลน์');assert.equal(b.saves()[0].game.events.length,1);assert.equal(b.stats().reloads,1);
});
test('inactive character library receives remote updates and deletion tombstones',async()=>{
 const s=server(),d=device(s);await d.api.init();s.advance();assert.equal(d.saves()[0].game.events.length,1);assert.equal(d.dialog(),null);
 const record=s.records.get('hero');const g=JSON.parse(record.payload);g.deleted=true;record.payload=JSON.stringify(g);record.revision++;s.emit();assert.equal(d.saves()[0].game.deleted,true);
});
test('divergent decisions preserve both branches when selected',async()=>{
 const s=server(),a=device(s),b=device(s);await a.start();await b.start();a.choose(1);b.choose(2);await a.api.sync();assert.ok(b.dialog());
 await b.click('เก็บทั้งสองชุด');await b.api.sync();await tick();
 assert.equal(s.records.size,2);assert.deepEqual([...s.records.values()].map(r=>JSON.parse(r.payload).events[0].value).sort(),[1,2]);
});
test('offline save remains dirty and reconnect retries successfully',async()=>{
 const s=server(),d=device(s);await d.start();d.choose();s.offline=true;await d.nodes.get('#syncBtn').onclick({currentTarget:d.nodes.get('#syncBtn')});
 assert.equal(d.saves()[0].dirty,true);assert.match(d.status(),/ยังไม่สำเร็จ/);assert.equal(d.nodes.get('#syncBtn').disabled,false);
 s.offline=false;await d.listeners.online();await d.api.sync();assert.equal(d.saves()[0].dirty,false);assert.equal(JSON.parse(s.records.get('hero').payload).events.length,1);
});
test('new decision during upload stays dirty and own listener echo is not a conflict',async()=>{
 const s=server(),d=device(s);await d.start();d.choose(1);s.beforeWrite=async()=>{s.beforeWrite=null;d.choose(2);};await d.api.sync();
 assert.equal(d.api.active.dirty,true);assert.equal(d.dialog(),null);await d.api.sync();assert.equal(d.api.active.dirty,false);assert.equal(JSON.parse(s.records.get('hero').payload).events.length,2);
});
test('handoff button drains an upload that gains another decision',async()=>{
 const s=server(),d=device(s);await d.start();d.choose(1);s.beforeWrite=async()=>{s.beforeWrite=null;d.choose(2);};
 await d.nodes.get('#syncBtn').onclick({currentTarget:d.nodes.get('#syncBtn')});assert.equal(d.stats().writes,2);assert.equal(d.saves()[0].dirty,false);assert.match(d.status(),/เปิดอีกเครื่อง/);
});
test('returning to visible tab pulls updates even if listener missed them',async()=>{
 const s=server(),d=device(s);await d.start();s.watchers=[];s.advance();const before=d.stats().reads;
 d.context.document.hidden=false;await d.docListeners.visibilitychange();await d.api.sync();assert.ok(d.stats().reads>before);assert.ok(d.dialog());
});
test('account change prevents upload',async()=>{
 const s=server(),d=device(s);await d.start();d.choose();d.context.CloudSave.user={uid:'someone-else'};await d.api.sync();assert.equal(d.stats().writes,0);
});
test('guest stays local and has no handoff button',async()=>{
 const s=server(),d=device(s,{guest:true});await d.api.init();assert.equal(d.nodes.get('#syncBtn').hidden,true);await d.api.sync();assert.equal(d.stats().reads+d.stats().writes,0);
});
test('keep-both storage failure rolls back without losing the conflict',async()=>{
 const s=server(),d=device(s);await d.start();d.choose(2);s.advance();assert.ok(d.dialog());d.failStorage(true);await d.click('เก็บทั้งสองชุด');assert.equal(d.api.active.id,'hero');assert.equal(d.saves().length,1);assert.equal(d.dialog().open,true);
});
test('newer identical payload updates revision without a false conflict',async()=>{
 const s=server(),d=device(s);await d.start();s.records.get('hero').revision++;s.emit();assert.equal(d.api.active.cloudRevision,2);assert.equal(d.dialog(),null);
});

test('metadata reconstructed by replay is clean; age changes after a decision are uploaded',async()=>{
 const s=server(),d=device(s);await d.start();d.context.CUR={p:{name:'Hero',age:10,gen:1}};d.prompt();assert.equal(d.api.active.dirty,false);
 d.choose();await d.api.sync();d.context.CUR.p.age=11;d.prompt();assert.equal(d.api.active.dirty,true);await d.api.sync();assert.equal(s.records.get('hero').age,11);
});
test('conflict panel loads the latest server version even when it later matches local payload',async()=>{
 const s=server(),d=device(s);await d.start();d.choose(2);s.advance();assert.ok(d.dialog());
 const r=s.records.get('hero');r.payload=JSON.stringify(d.api.active.game);r.revision++;s.emit();await d.click('โหลดเซฟออนไลน์');assert.equal(d.saves()[0].game.events[0].value,2);assert.equal(d.saves()[0].cloudRevision,r.revision);
});

test('handoff never confirms the previous account after auth changes',async()=>{
 const s=server(),d=device(s);await d.start();await d.api.sync();d.context.CloudSave.user={uid:'other-account'};
 await d.nodes.get('#syncBtn').onclick({currentTarget:d.nodes.get('#syncBtn')});assert.match(d.status(),/บัญชีเปลี่ยน/);assert.doesNotMatch(d.status(),/เปิดอีกเครื่อง/);
});
test('guest can skip a slow account load without touching the cloud',async()=>{
 const s=server(),d=device(s,{ready:new Promise(()=>{})});
 const pending=d.api.init();d.api.skipToGuest();const record=await pending;
 assert.ok(record);assert.equal(d.api.signedIn,false);assert.equal(d.stats().reads,0);
 assert.equal(d.nodes.get('#syncBtn').hidden,true);assert.equal(d.all.find(n=>n.id==='logoutBtn').hidden,true);
 assert.equal(JSON.parse(d.context.localStorage.getItem('o65m_characters_v1:guest')).length,1);
});
test('logout uploads pending progress before signing out',async()=>{
 const s=server(),d=device(s);await d.start();d.choose();
 const button=d.all.find(n=>n.id==='logoutBtn');assert.equal(button.hidden,false);
 await button.onclick();
 assert.equal(JSON.parse(s.records.get('hero').payload).events.length,1);
 assert.equal(d.context.CloudSave.user,null);assert.equal(d.stats().reloads,1);
});
