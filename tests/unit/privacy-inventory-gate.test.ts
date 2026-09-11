import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Inventory {
  schemaVersion: number;
  wechatApis: string[];
  wxmlInterfaces: string[];
  requiredPrivateInfos: string[];
  privacyBoundaries: Array<{surface:string}>;
  migrationSetSha256: string;
  egressSignatureSha256: string;
}

const root=resolve(import.meta.dirname,'../..');

async function files(dir:string,extensions:string[]):Promise<string[]> {
  const entries=await readdir(dir,{withFileTypes:true});
  const nested=await Promise.all(entries.map(async entry=>{
    const path=join(dir,entry.name);
    if(entry.isDirectory())return files(path,extensions);
    return extensions.some(extension=>path.endsWith(extension))?[path]:[];
  }));
  return nested.flat().sort();
}

async function inventory():Promise<Inventory> {
  return JSON.parse(await readFile(join(root,'docs/privacy/miniprogram-personal-data-inventory.json'),'utf8')) as Inventory;
}

describe('personal-data inventory gate',()=>{
  it('requires every WeChat API and fixed WXML data interface to be inventoried',async()=>{
    const manifest=await inventory();
    expect(manifest.schemaVersion).toBe(1);
    const apiSet=new Set<string>();
    for(const path of await files(join(root,'apps/miniprogram'),['.ts'])) {
      const source=await readFile(path,'utf8');
      for(const match of source.matchAll(/\bwx\.([A-Za-z][A-Za-z0-9_]*)/g))apiSet.add(`wx.${match[1]}`);
    }
    expect([...apiSet].sort()).toEqual([...manifest.wechatApis].sort());

    const interfaceSet=new Set<string>();
    for(const path of await files(join(root,'apps/miniprogram'),['.wxml'])) {
      const source=await readFile(path,'utf8');
      for(const match of source.matchAll(/open-type="([^"]+)"/g))if(!match[1]!.includes('{{'))interfaceSet.add(`open-type:${match[1]}`);
      if(/type="nickname"/.test(source))interfaceSet.add('input-type:nickname');
    }
    expect([...interfaceSet].sort()).toEqual([...manifest.wxmlInterfaces].sort());
    const app=JSON.parse(await readFile(join(root,'apps/miniprogram/app.json'),'utf8')) as {requiredPrivateInfos?:string[]};
    expect([...(app.requiredPrivateInfos??[])].sort()).toEqual([...manifest.requiredPrivateInfos].sort());

    const boundaries=new Set(manifest.privacyBoundaries.map(entry=>entry.surface));
    for(const surface of ['wx.login','open-type:chooseAvatar','input-type:nickname','open-type:getPhoneNumber','wx.chooseAddress','wx.getClipboardData','wx.chooseMedia','wx.compressImage','wx.downloadFile','wx.getDeviceInfo','wx.request','wx.uploadFile'])expect(boundaries.has(surface),surface).toBe(true);
    for(const surface of ['support_conversation','support_presence','support_message.body','support_message.attachments','support_message.order_snapshot','support_member_context','support_audit'])expect(boundaries.has(surface),surface).toBe(true);
    for(const surface of ['catalog_management_audit','support_ai_suggested_reply'])expect(boundaries.has(surface),surface).toBe(true);
  });

  it('requires an inventory review whenever migrations change',async()=>{
    const manifest=await inventory();
    const hash=createHash('sha256');
    for(const path of await files(join(root,'db/migrations'),['.sql']))hash.update(`${relative(root,path)}\0${await readFile(path,'utf8')}\0`);
    expect(hash.digest('hex')).toBe(manifest.migrationSetSha256);
  });

  it('requires an inventory review whenever a known runtime egress call site changes',async()=>{
    const manifest=await inventory();
    const directories=['apps/admin/src','apps/miniprogram','services/api/src','services/worker/src','services/cloudbase','infra/tencent'];
    const sourceFiles=(await Promise.all(directories.map(directory=>files(join(root,directory),['.ts','.js','.mjs','.py'])))).flat();
    const signatures:string[]=[];
    for(const path of sourceFiles) {
      const source=await readFile(path,'utf8');
      for(const line of source.split(/\r?\n/)) {
        if(/(?:\bfetch\s*\(|\bfetcher\s*\(|\.fetcher\s*\(|wx\.(?:request|uploadFile)\s*\(|cloud\.callFunction\s*\(|CosS3Client\s*\()/.test(line))signatures.push(`${relative(root,path)}\0${line.trim()}`);
      }
    }
    const hash=createHash('sha256');
    for(const signature of signatures.sort())hash.update(`${signature}\0`);
    expect(hash.digest('hex')).toBe(manifest.egressSignatureSha256);
  });

  it('keeps the staging support notice explicit about purpose, AI limits, and pending retention',async()=>{
    const documents=JSON.parse(await readFile(join(root,'docs/legal/publication-staging-2026-09-11.json'),'utf8')) as Array<{type:string;version:string;body:string}>;
    const privacy=documents.find(document=>document.type==='privacy');
    expect(privacy?.version).toBe('2026-09-11-v7-staging-support');
    for(const phrase of ['客服答疑、售后处理、投诉处理、安全及服务质量管理','部分低风险咨询可能由 AI 辅助回答','AI 不会自动决定退款','POLICY PENDING','没有有效法律保全'])expect(privacy?.body).toContain(phrase);
  });
});
