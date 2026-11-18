import {beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({send:vi.fn()}));
vi.mock("../../apps/miniprogram/services/http",()=>({sendJsonRequest:m.send}));
let native:any,listener:any,upload:any,device:any,context:any;
const states=()=>{const values:any[]=[];return {values,onState:(value:any)=>values.push(value)};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
beforeEach(()=>{
  vi.resetModules();m.send.mockReset();listener=null;upload=null;
  context={sessionToken:"synthetic-session",apiBaseUrl:"https://synthetic.invalid",cloudFunction:null};
  native={onProgressUpdate:vi.fn(fn=>{listener=fn;}),offProgressUpdate:vi.fn(),abort:vi.fn(()=>upload.fail({errMsg:"abort"}))};
  device={uploadFile:vi.fn(options=>{upload=options;return native;}),request:vi.fn(),
    getFileSystemManager:()=>({readFile:(o:any)=>o.success({data:o.encoding?"AA==":new Uint8Array(600).buffer}),getFileInfo:(o:any)=>o.success({size:600*1024})})};
  Object.assign(globalThis,{wx:device,getApp:()=>({globalData:context}),getCurrentPages:()=>[]});
});
describe("native upload progress reports measured transport facts",()=>{
  it("stays indeterminate without events, follows real bytes and ignores events after HTTP completion",async()=>{
    const {uploadAuthorized}=await import("../../apps/miniprogram/services/api");const state=states();
    const pending=uploadAuthorized("/synthetic.jpg",{url:"https://synthetic.invalid/upload",fields:{}},state);
    await flush();expect(state.values).toEqual([{phase:"uploading",percent:null,sentBytes:null,totalBytes:null}]);
    listener({progress:90,totalBytesSent:420,totalBytesExpectedToSend:1000});
    expect(state.values.at(-1)).toMatchObject({phase:"uploading",percent:42,sentBytes:420,totalBytes:1000});
    listener({progress:100,totalBytesSent:1000,totalBytesExpectedToSend:1000});
    expect(state.values.at(-1).phase).toBe("uploading");
    upload.success({statusCode:201});await pending;const count=state.values.length;
    expect(state.values.at(-1)).toMatchObject({phase:"uploaded",percent:100});
    listener({progress:17});expect(state.values).toHaveLength(count);expect(native.offProgressUpdate).toHaveBeenCalledWith(listener);
  });
  it("does not generate a PUT percentage while the request is still pending",async()=>{
    const {uploadAuthorized}=await import("../../apps/miniprogram/services/api");const state=states();let request:any;
    device.request.mockImplementation((o:any)=>{request=o;return {abort:vi.fn()};});
    const pending=uploadAuthorized("/synthetic.jpg",{url:"https://synthetic.invalid/upload",method:"PUT",fields:{}},state);
    await flush();expect(state.values.map(s=>s.percent)).toEqual([null]);
    request.success({statusCode:200});await pending;
    expect(state.values).toHaveLength(2);expect(state.values[1]).toMatchObject({phase:"uploaded",percent:100,sentBytes:600,totalBytes:600});
  });
  it("weights acknowledged chunks by bytes and waits in a separate assembly stage",async()=>{
    const {uploadAuthorized}=await import("../../apps/miniprogram/services/api");const state=states();let assembly:any;
    context.cloudFunction={env:"synthetic",name:"synthetic"};
    m.send.mockImplementation(o=>{if(o.path.endsWith("/assemble"))assembly=o;else queueMicrotask(()=>o.success({statusCode:200,data:{}}));return {abort:vi.fn()};});
    const pending=uploadAuthorized("/synthetic.jpg",{url:"https://synthetic.invalid/upload",fields:{token:"synthetic-upload"},mediaId:"media-id"},state);
    await flush();
    expect(state.values.filter(s=>s.phase==="uploading").map(s=>s.percent)).toEqual([null,85,100]);
    expect(state.values.at(-1)).toEqual({phase:"assembling",percent:null,sentBytes:600*1024,totalBytes:600*1024});
    expect(state.values.some(s=>s.phase==="uploaded")).toBe(false);
    assembly.success({statusCode:200,data:{}});await pending;expect(state.values.at(-1).phase).toBe("uploaded");
  });
  it("rejects a failed HTTP upload without emitting success",async()=>{
    const {uploadAuthorized}=await import("../../apps/miniprogram/services/api");const state=states();
    const pending=uploadAuthorized("/synthetic.jpg",{url:"https://synthetic.invalid/upload",fields:{}},state);
    const rejected=expect(pending).rejects.toMatchObject({status:503,code:"UPLOAD_FAILED"});upload.success({statusCode:503});await rejected;
    listener({progress:100});expect(state.values.some(s=>s.phase==="uploaded")).toBe(false);
  });
  it("stops progress after cancellation and does not accept a late success",async()=>{
    const {uploadAuthorized}=await import("../../apps/miniprogram/services/api");const state=states();let cancel!:()=>void;
    const pending=uploadAuthorized("/synthetic.jpg",{url:"https://synthetic.invalid/upload",fields:{}},{...state,registerAbort:fn=>{cancel=fn;}});
    const rejected=expect(pending).rejects.toMatchObject({errMsg:"abort"});cancel();await rejected;const count=state.values.length;
    listener({progress:100});upload.success({statusCode:200});expect(state.values).toHaveLength(count);
  });
});
