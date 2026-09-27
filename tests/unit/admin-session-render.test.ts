// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const later=()=>{let resolve!:(value:any)=>void;return {promise:new Promise<any>(yes=>{resolve=yes;}),resolve};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const token=()=>document.querySelector<HTMLInputElement>('#token')!;
const edit=(value:string)=>{token().value=value;token().dispatchEvent(new Event('input'));};
beforeEach(()=>{vi.resetModules();localStorage.clear();sessionStorage.clear();document.body.innerHTML='<div id="app"></div>';});
afterEach(()=>vi.unstubAllGlobals());
it('does not combine earlier fulfilled queue data with a newly entered operator while remaining reads finish',async()=>{
 const reads=Array.from({length:4},()=>later()),network=vi.fn();let index=0;
 network.mockImplementation(()=>reads[index++]!.promise);vi.stubGlobal('fetch',network);
 await import('../../apps/admin/src/main');edit('synthetic-a');document.querySelector<HTMLButtonElement>('#load')!.click();
 reads[0]!.resolve({ok:true,json:async()=>[{id:'old-record',platform_account:'OLD_OPERATOR_RECORD',status:'pending',version:1}]});await flush();
 edit('synthetic-b');for(const item of reads.slice(1))item.resolve({ok:true,json:async()=>[]});await flush();
 expect(document.body.textContent).not.toContain('OLD_OPERATOR_RECORD');expect(token().value).toBe('synthetic-b');
 expect(document.querySelector('[data-export]')).toBeNull();
});
it('clearing the credential does not restore or send the old operator on the next load',async()=>{
 const network=vi.fn(async()=>({ok:true,json:async()=>[]}));vi.stubGlobal('fetch',network);
 await import('../../apps/admin/src/main');edit('synthetic-a');document.querySelector<HTMLButtonElement>('#load')!.click();await flush();
 network.mockClear();edit('');document.querySelector<HTMLButtonElement>('#load')!.click();await flush();
 expect(network).not.toHaveBeenCalled();expect(token().value).toBe('');expect(document.body.textContent).toContain('请先填写');
});
