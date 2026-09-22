import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

// Execute the real Page and the existing GET-owner helper with synthetic transports.
// This is lifecycle regression coverage, not WeChat renderer/device acceptance.
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const source=(path:string)=>stripTypeScriptTypes(readFileSync(path,"utf8").replace(/^import[^\n]*\n/gm,"").replace(/\bexport /g,""));
const event=(key:string,value:string)=>({currentTarget:{dataset:{[key]:value}}});
function fixture(){
  const state={token:"synthetic-a",revision:1,access:true};
  const calls:any[]=[],modals:any[]=[];let definition:any;
  const request=(options:any)=>new Promise((resolve,reject)=>{
    const call={...options,resolve,reject,aborted:0};
    options.registerAbort?.(()=>{call.aborted+=1;});calls.push(call);
  });
  const helpers=runInNewContext(source("apps/miniprogram/services/page-requests.ts")+"\n;({pageRead,cancelPageReads});",{request});
  const wx={showModal:()=>new Promise((resolve,reject)=>modals.push({resolve,reject})),showToast:()=>{},navigateTo:()=>{}};
  runInNewContext(source("apps/miniprogram/pages/community-activity/index.ts"),{
    ...helpers,request,requireMemberAccess:()=>state.access,currentChromeStyle:()=>"",shouldReduceMotion:()=>false,
    commerceContextRevision:()=>state.revision,getApp:()=>({globalData:{sessionToken:state.token}}),
    wx,Page:(value:any)=>{definition=value;}
  });
  const page={...definition,data:structuredClone(definition.data),updates:[] as any[],
    setData(patch:any){this.updates.push(patch);Object.assign(this.data,patch);}};
  page.sessionToken=state.token;page.contextRevision=state.revision;
  page.data.loading=false;
  return {page,state,calls,modals};
}
const empty={items:[],nextCursor:null,matchingTotal:0};
const row={id:"synthetic-comment",postId:"synthetic-post",memberId:"synthetic-member",state:"published",createdAt:"2026-01-01T00:00:00Z"};
const writes=[
  {method:"removeSaved",key:"synthetic-post",section:"saves"},
  {method:"unblock",key:"synthetic-member",section:"blocks"},
  {method:"deleteComment",key:"synthetic-comment",section:"comments"}
];

describe("community activity request and mutation ownership",()=>{
  for(const action of writes){
    for(const readFirst of [true,false])it(`${action.method}: reconciles a resumed read after write settlement (read first: ${readFirst})`,async()=>{
      const f=fixture();f.page.data.section=action.section;f.page.data.items=[row];
      const operation=f.page[action.method](event("id",action.key));
      f.modals[0].resolve({confirm:true});await flush();const write=f.calls[0];
      f.page.onHide();f.page.onShow();const staleRead=f.calls[1];
      if(readFirst){staleRead.resolve({items:[row],nextCursor:null,matchingTotal:1});await flush();}
      write.resolve({});await operation;
      const reconciliation=f.calls[2];assert.ok(reconciliation,"settled write must supersede the pre-settlement read");
      reconciliation.resolve(empty);await flush();
      if(!readFirst){staleRead.resolve({items:[row],nextCursor:null,matchingTotal:1});await flush();}
      assert.equal(f.page.data.items.length,0);assert.equal(f.page.data.busy,false);
      assert.equal(f.calls.filter(call=>call.method).length,1);
    });
    it(`${action.method}: reconciles after tab ABA without replaying the write`,async()=>{
      const f=fixture();f.page.data.section=action.section;f.page.data.items=[row];
      const operation=f.page[action.method](event("id",action.key));f.modals[0].resolve({confirm:true});await flush();
      f.page.selectSection(event("section","reports"));f.page.selectSection(event("section",action.section));
      f.calls[2].resolve({items:[row],nextCursor:null,matchingTotal:1});await flush();
      f.calls[0].resolve({});await operation;
      assert.ok(f.calls[3],"tab ABA must converge from a new read");f.calls[3].resolve(empty);await flush();
      assert.equal(f.page.data.items.length,0);assert.equal(f.calls.filter(call=>call.method).length,1);
    });
  }
  for(const action of writes){
    for(const fail of [false,true])it(`${action.method}: releases its lock after a tab change and ${fail?"failure":"success"}`,async()=>{
      const f=fixture();f.page.data.section=action.section;f.page.data.items=[row];
      const operation=f.page[action.method](event("id",action.key));
      f.modals[0].resolve({confirm:true});await flush();
      assert.equal(f.page.data.busy,true);const write=f.calls.find(call=>call.method);
      f.page.selectSection(event("section","reports"));
      if(fail)write.reject({title:"old failure"});else write.resolve({});
      await operation;
      assert.equal(f.page.data.busy,false);assert.equal(f.page.data.section,"reports");
      assert.equal(f.page.data.notice,"");assert.equal(f.page.data.error,"");
      assert.equal(f.calls.filter(call=>call.method).length,1);
    });
  }
  it("cancels owned GET subscriptions on hide and ignores their late result",async()=>{
    const f=fixture(),load=f.page.load();const read=f.calls[0];f.page.onHide();
    assert.equal(read.aborted,1);const count=f.page.updates.length;
    read.resolve({items:[row],nextCursor:null,matchingTotal:1});await load;
    assert.equal(f.page.updates.length,count);assert.equal(f.page.data.items.length,0);
    f.page.onShow();assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>!call.method));
    f.calls[1].resolve(empty);await flush();assert.equal(f.page.data.loading,false);
  });
  it("rejects A-to-B-to-A results even when the token string is the same",async()=>{
    const f=fixture(),load=f.page.load();f.state.token="synthetic-b";f.state.revision+=1;
    f.state.token="synthetic-a";f.state.revision+=1;
    f.calls[0].resolve({items:[row],nextCursor:null,matchingTotal:1});await load;
    assert.equal(f.page.data.items.length,0);
    f.page.onShow();assert.equal(f.calls.length,2);
  });
  it("does not dispatch a modal-confirmed write after hide",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.page.onHide();f.modals[0].resolve({confirm:true});await operation;
    assert.equal(f.calls.length,0);
  });
  it("does not dispatch a modal-confirmed write after a context revision change",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.state.revision+=1;f.modals[0].resolve({confirm:true});await flush();
    assert.equal(f.calls.length,0);await operation;
  });
  it("never submits stale visible rows under a newly changed account before onShow",async()=>{
    const f=fixture();f.page.data.items=[row];f.state.token="synthetic-b";f.state.revision+=1;
    const operation=f.page.deleteComment(event("id",row.id));f.modals[0].resolve({confirm:true});await flush();
    assert.equal(f.calls.length,0);await operation;
  });
  it("an old account's completion cannot unlock a newer account's operation",async()=>{
    const f=fixture();f.page.data.items=[row];const first=f.page.deleteComment(event("id",row.id));
    f.modals[0].resolve({confirm:true});await flush();const oldWrite=f.calls[0];
    f.state.token="synthetic-b";f.state.revision+=1;f.page.onShow();f.page.data.items=[row];
    const second=f.page.deleteComment(event("id",row.id));f.modals[1].resolve({confirm:true});await flush();
    oldWrite.resolve({});await first;assert.equal(f.page.data.busy,true);
    f.calls.find((call:any)=>call.method&&call!==oldWrite).resolve({});await second;assert.equal(f.page.data.busy,false);
  });
  it("treats modal rejection as cancellation without an unhandled operation",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.modals[0].reject(new Error("synthetic modal cancelled"));await operation;
    assert.equal(f.calls.length,0);assert.equal(f.page.data.busy,false);
  });
  it("rechecks the write lock after two overlapping confirmation dialogs",async()=>{
    const f=fixture();f.page.data.items=[row];const first=f.page.deleteComment(event("id",row.id)),second=f.page.deleteComment(event("id",row.id));
    f.modals[0].resolve({confirm:true});await flush();f.modals[1].resolve({confirm:true});await flush();
    assert.equal(f.calls.filter(call=>call.method).length,1);await second;f.calls[0].resolve({});await first;
    assert.equal(f.page.data.busy,false);
  });
  it("never updates the unloaded page after a write settles",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.modals[0].resolve({confirm:true});await flush();f.page.onUnload();const count=f.page.updates.length;
    f.calls[0].resolve({});await operation;assert.equal(f.page.updates.length,count);
  });
  it("deduplicates identifiers both within one response and across pagination",async()=>{
    const f=fixture(),load=f.page.load();f.calls[0].resolve({items:[row,row],nextCursor:"next",matchingTotal:2});await load;
    assert.equal(f.page.data.items.length,1);const more=f.page.load(false);
    f.calls[1].resolve({items:[row,{...row,id:"second"},{...row,id:"second"}],nextCursor:null,matchingTotal:2});await more;
    assert.equal(f.page.data.items.length,2);
  });
  it("clears private rows, notices and locks when membership access is lost",()=>{
    const f=fixture();f.page.data.items=[row];f.page.data.notice="old account";f.page.data.busy=true;f.page.data.loadingMore=true;
    f.state.access=false;f.page.onShow();assert.equal(f.page.data.items.length,0);
    assert.equal(f.page.data.notice,"");assert.equal(f.page.data.busy,false);assert.equal(f.page.data.loadingMore,false);
  });
  it("keeps only the newest read after rapid A-to-B-to-A tab selection",async()=>{
    const f=fixture(),first=f.page.load();f.page.selectSection(event("section","saves"));f.page.selectSection(event("section","comments"));
    f.calls[2].resolve({items:[{...row,id:"new"}],nextCursor:null,matchingTotal:1});await flush();
    f.calls[0].resolve({items:[row],nextCursor:null,matchingTotal:1});f.calls[1].resolve(empty);await first;await flush();
    assert.equal(f.page.data.items[0].id,"new");assert.equal(f.page.data.section,"comments");
  });
  it("retains an in-flight write lock while hidden and restores it until settlement",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.modals[0].resolve({confirm:true});await flush();f.page.onHide();f.page.onShow();
    assert.equal(f.page.data.busy,true);f.calls[0].resolve({});await operation;assert.equal(f.page.data.busy,false);
  });
});
