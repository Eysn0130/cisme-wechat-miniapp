import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"--cisme-safe-bottom:34px"}));
let definition:any, component:any, canvas:any, wxMock:any, token:string;
const flush=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};
beforeEach(async()=>{
  vi.useFakeTimers();vi.resetModules();token="synthetic-text-card-owner";
  const context={scale:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),measureText:(text:string)=>({width:Array.from(text).length*28})};
  canvas={width:0,height:0,getContext:()=>context,requestAnimationFrame:(callback:()=>void)=>setTimeout(callback,0)};
  wxMock={getWindowInfo:()=>({windowWidth:390,pixelRatio:3}),canvasToTempFilePath:vi.fn((options:any)=>options.success({tempFilePath:"/synthetic/text-card.png"})),
    getFileSystemManager:()=>({getFileInfo:vi.fn((options:any)=>options.success({size:8192}))})};
  Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{sessionToken:token}}),Component:(value:any)=>{definition=value;}});
  await import("../../apps/miniprogram/components/community-text-card/index");
  component={data:{...structuredClone(definition.data),visible:true,initialText:"今天认真记录护理感受",initialTemplate:"plain",contextKey:"owner-epoch-1"},...definition.methods,
    setData:vi.fn(function(this:any,patch:any){Object.assign(this.data,patch);}),triggerEvent:vi.fn(),
    createSelectorQuery:()=>{const query:any={select:()=>query,fields:()=>query,exec:(callback:(result:any)=>void)=>callback([{node:canvas}])};return query;}};
  definition.lifetimes.attached.call(component);await vi.advanceTimersByTimeAsync(101);
});
afterEach(()=>{definition.lifetimes.detached.call(component);vi.useRealTimers();vi.unstubAllGlobals();});

describe("local community text-card component",()=>{
  it("exports a real API result and checked file size before confirming, at a bounded crisp backing resolution",async()=>{
    expect(component.data.canExport).toBe(true);const exporting=component.confirm();await vi.runAllTimersAsync();await exporting;
    expect(canvas).toMatchObject({width:1440,height:1920});
    expect(wxMock.canvasToTempFilePath).toHaveBeenCalledWith(expect.objectContaining({canvas,fileType:"png",destWidth:1440,destHeight:1920}),component);
    expect(component.triggerEvent).toHaveBeenCalledWith("confirm",{tempFilePath:"/synthetic/text-card.png",size:8192,text:"今天认真记录护理感受",template:"plain",contextKey:"owner-epoch-1"});
    definition.pageLifetimes.show.call(component);await vi.advanceTimersByTimeAsync(101);
    await component.confirm();expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(2);
  });
  it("reports export failure and allows a later explicit retry",async()=>{
    wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>options.fail({errMsg:"synthetic export failure"}));
    let exporting=component.confirm();await vi.runAllTimersAsync();await exporting;
    expect(component.data).toMatchObject({busy:false,canExport:true,error:"文字卡片未生成成功，请重试。"});
    expect(component.triggerEvent).not.toHaveBeenCalledWith("confirm",expect.anything());
    exporting=component.confirm();await vi.runAllTimersAsync();await exporting;
    expect(component.triggerEvent).toHaveBeenCalledWith("confirm",expect.objectContaining({size:8192}));
  });
  it.each(["cancel","detach","account"])("ignores a late PNG callback after %s",async condition=>{
    let exportOptions:any;wxMock.canvasToTempFilePath.mockImplementation((options:any)=>{exportOptions=options;});
    const exporting=component.confirm();await vi.advanceTimersByTimeAsync(1);await flush();expect(exportOptions).toBeDefined();
    if(condition==="cancel"){component.cancel();expect(component.triggerEvent).toHaveBeenCalledWith("cancel",{contextKey:"owner-epoch-1"});}
    else if(condition==="detach")definition.lifetimes.detached.call(component);
    else token="another-synthetic-owner";
    exportOptions.success({tempFilePath:"/synthetic/late.png"});await exporting;
    expect(component.triggerEvent).not.toHaveBeenCalledWith("confirm",expect.anything());
  });
  it("emits changes for parent backup without uploading or confirming",async()=>{
    component.editText({detail:{value:"我的新记录🙂"}});
    component.selectTemplate({currentTarget:{dataset:{template:"memo"}}});await vi.advanceTimersByTimeAsync(101);
    expect(component.triggerEvent).toHaveBeenCalledWith("change",{text:"我的新记录🙂",template:"memo",contextKey:"owner-epoch-1"});
    expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(2);expect(component.data.canExport).toBe(true);
    expect(component.triggerEvent).not.toHaveBeenCalledWith("confirm",expect.anything());
  });
  it("does not silently export text that needs more than one card",async()=>{
    component.editText({detail:{value:"记录\n".repeat(40)}});await vi.advanceTimersByTimeAsync(101);
    expect(component.data.canExport).toBe(false);expect(component.data.error).toContain("超出一张卡片");
    await component.confirm();expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(1);
  });
  it("initializes a fresh opaque context only from the parent's current initial data",async()=>{
    component.editText({detail:{value:"旧卡正在编辑的内容"}});
    Object.assign(component.data,{contextKey:"owner-epoch-2",initialText:"新卡初始内容",initialTemplate:"lilac"});
    definition.observers["visible, contextKey"].call(component);
    expect(component.data).toMatchObject({text:"新卡初始内容",template:"lilac",busy:false,canExport:false,error:""});
    await vi.advanceTimersByTimeAsync(101);expect(component.data.canExport).toBe(true);
    component.cancel();expect(component.triggerEvent).toHaveBeenCalledWith("cancel",{contextKey:"owner-epoch-2"});
  });
  it("recovers from a canvas frame that never becomes ready",async()=>{
    canvas.requestAnimationFrame=()=>0;
    const exporting=component.confirm();await vi.runAllTimersAsync();await exporting;
    expect(component.data).toMatchObject({busy:false,error:"文字卡片未生成成功，请重试。"});
    expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(1);
  });
  it("retains current text across backgrounding without requiring the parent to echo initialText",async()=>{
    component.editText({detail:{value:"临时切走也保留这段文字"}});component.selectTemplate({currentTarget:{dataset:{template:"memo"}}});
    definition.pageLifetimes.hide.call(component);definition.pageLifetimes.show.call(component);await vi.advanceTimersByTimeAsync(101);
    expect(component.data).toMatchObject({text:"临时切走也保留这段文字",template:"memo",canExport:true,busy:false});
  });
  it("reopens a cancelled card under a new key when false/true visibility updates coalesce",async()=>{
    component.cancel();component.cancel();definition.pageLifetimes.show.call(component);await vi.advanceTimersByTimeAsync(101);
    expect(component.data.canExport).toBe(false);expect(component.triggerEvent.mock.calls.filter(([name]:any[])=>name==="cancel")).toHaveLength(1);
    Object.assign(component.data,{visible:true,contextKey:"owner-epoch-2",initialText:"重新打开的新文字",initialTemplate:"memo"});
    definition.observers["visible, contextKey"].call(component);await vi.advanceTimersByTimeAsync(101);
    expect(component.data).toMatchObject({text:"重新打开的新文字",template:"memo",canExport:true,busy:false});
    const exporting=component.confirm();await vi.runAllTimersAsync();await exporting;
    expect(component.triggerEvent).toHaveBeenCalledWith("confirm",expect.objectContaining({text:"重新打开的新文字",contextKey:"owner-epoch-2"}));
  });
  it("does not let a late old PNG callback confirm or reset a newly opened card",async()=>{
    let oldExport:any;wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>{oldExport=options;});
    const exporting=component.confirm();await vi.advanceTimersByTimeAsync(1);await flush();expect(oldExport).toBeDefined();
    token="new-synthetic-owner";Object.assign(component.data,{contextKey:"owner-epoch-2",initialText:"新账号当前卡片",initialTemplate:"plain"});
    definition.observers["visible, contextKey"].call(component);await vi.advanceTimersByTimeAsync(101);
    oldExport.success({tempFilePath:"/synthetic/stale.png"});await exporting;
    expect(component.triggerEvent).not.toHaveBeenCalledWith("confirm",expect.anything());
    expect(component.data).toMatchObject({text:"新账号当前卡片",canExport:true,busy:false});
  });
  it("offers direct body writing with the current scope and retains the text already emitted for backup",()=>{
    component.editText({detail:{value:"不用制卡，继续写完整正文"}});component.writeBody();component.writeBody();
    expect(component.triggerEvent).toHaveBeenCalledWith("change",{text:"不用制卡，继续写完整正文",template:"plain",contextKey:"owner-epoch-1"});
    expect(component.triggerEvent).toHaveBeenCalledWith("cancel",{contextKey:"owner-epoch-1",mode:"body"});
    expect(component.triggerEvent.mock.calls.filter(([name]:any[])=>name==="cancel")).toHaveLength(1);
    expect(component.data).toMatchObject({text:"不用制卡，继续写完整正文",busy:false,canExport:false});
    expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(1);
  });
  it("does not emit direct body mode from an old identity scope",()=>{
    token="another-synthetic-owner";component.writeBody();
    expect(component.triggerEvent).not.toHaveBeenCalledWith("cancel",expect.anything());
    expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(1);
  });
  it("uses the actual generated PNG as an ordinary image and keeps the drawing canvas outside the viewport",async()=>{
    expect(component.data).toMatchObject({previewPath:"/synthetic/text-card.png",previewPending:false,canExport:true});
    const [markup,styles]=await Promise.all([readFile(resolve("apps/miniprogram/components/community-text-card/index.wxml"),"utf8"),readFile(resolve("apps/miniprogram/components/community-text-card/index.wxss"),"utf8")]);
    expect(markup).toMatch(/<image\b[^>]*src="\{\{previewPath\}\}"[^>]*binderror="previewImageFailed"/);
    expect(markup).not.toMatch(/<canvas\b[^>]*previewWidth/);
    expect(styles).toMatch(/\.text-card-canvas\{[^}]*left:-2000px;[^}]*width:1px;height:1px/);
  });
  it("clears an old preview immediately and shows no previous PNG when the new export fails, then retries",async()=>{
    wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>options.fail({errMsg:"synthetic preview export failure"}));
    component.editText({detail:{value:"这是新的预览内容"}});expect(component.data).toMatchObject({previewPath:"",previewPending:true,canExport:false});
    await vi.advanceTimersByTimeAsync(101);expect(component.data).toMatchObject({previewPath:"",previewPending:false,canExport:false,renderFailed:true});expect(component.data.error).toContain("预览暂未生成");
    wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>options.success({tempFilePath:"/synthetic/retried-preview.png"}));component.retryPreview();await vi.advanceTimersByTimeAsync(101);
    expect(component.data).toMatchObject({previewPath:"/synthetic/retried-preview.png",previewPending:false,canExport:true,renderFailed:false,error:""});
  });
  it("does not let an older text preview replace a newer text/template preview in the same scope",async()=>{
    let oldPreview:any;wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>{oldPreview=options;});component.editText({detail:{value:"旧的预览内容"}});await vi.advanceTimersByTimeAsync(101);expect(oldPreview).toBeDefined();
    wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>options.success({tempFilePath:"/synthetic/current-preview.png"}));component.editText({detail:{value:"现在的新内容"}});component.selectTemplate({currentTarget:{dataset:{template:"lilac"}}});await vi.advanceTimersByTimeAsync(101);
    expect(component.data.previewPath).toBe("/synthetic/current-preview.png");oldPreview.success({tempFilePath:"/synthetic/outdated-preview.png"});await flush();
    expect(component.data).toMatchObject({previewPath:"/synthetic/current-preview.png",text:"现在的新内容",template:"lilac",canExport:true});
  });
  it.each(["account","context","hide","cancel"])("ignores a pending preview PNG after %s",async condition=>{
    let oldPreview:any;wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>{oldPreview=options;});component.editText({detail:{value:"等待导出的预览"}});await vi.advanceTimersByTimeAsync(101);expect(oldPreview).toBeDefined();
    if(condition==="account"){token="different-owner";definition.pageLifetimes.show.call(component);}
    if(condition==="context"){Object.assign(component.data,{contextKey:"owner-epoch-2",initialText:"新上下文"});definition.observers["visible, contextKey"].call(component);}
    if(condition==="hide")definition.pageLifetimes.hide.call(component);
    if(condition==="cancel")component.cancel();
    oldPreview.success({tempFilePath:"/synthetic/stale-preview.png"});await flush();expect(component.data.previewPath).not.toBe("/synthetic/stale-preview.png");expect(component.triggerEvent).not.toHaveBeenCalledWith("confirm",expect.anything());
    if(condition==="account")expect(component.data.text).toBe("");
  });
  it("checks the generated preview file size and rejects stale image errors",async()=>{
    const originalPath=component.data.previewPath,originalRevision=component.data.previewRevision;
    component.editText({detail:{value:"新的图片预览"}});component.previewImageFailed({currentTarget:{dataset:{path:originalPath,revision:originalRevision}}});expect(component.data.renderFailed).toBe(false);
    wxMock.getFileSystemManager=()=>({getFileInfo:(options:any)=>options.success({size:10*1024*1024+1})});await vi.advanceTimersByTimeAsync(101);
    expect(component.data).toMatchObject({previewPath:"",canExport:false,renderFailed:true});
    wxMock.getFileSystemManager=()=>({getFileInfo:(options:any)=>options.success({size:8192})});component.retryPreview();await vi.advanceTimersByTimeAsync(101);
    component.previewImageFailed({currentTarget:{dataset:{path:component.data.previewPath,revision:component.data.previewRevision}}});expect(component.data).toMatchObject({previewPath:"",canExport:false,renderFailed:true});
  });
});
