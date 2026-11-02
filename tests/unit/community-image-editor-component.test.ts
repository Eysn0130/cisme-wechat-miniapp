import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"--cisme-safe-bottom:34px"}));
let revision=0;
vi.mock("../../apps/miniprogram/services/commerce-command-store",()=>({commerceContextRevision:()=>revision}));
let definition:any,component:any,wxMock:any,token:string,currentRoute:string,files:Map<string,{size:number;bytes:number[]}>,canvas:any,context:any,loadedPaths:string[];
const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
const jpeg=[0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0];
const events=(name:string)=>component.triggerEvent.mock.calls.filter(([event]:any[])=>event===name);
function makeComponent(initialFiles=[{path:"/synthetic/one.jpg",size:99},{path:"/synthetic/two.jpg",size:100}]){
  component={data:{...structuredClone(definition.data),visible:true,initialFiles,contextKey:"owner-image-1"},...definition.methods,
    setData:vi.fn(function(this:any,patch:any){Object.assign(this.data,patch);}),triggerEvent:vi.fn(),
    createSelectorQuery:()=>{const query:any={select:()=>query,fields:()=>query,exec:(callback:(result:any)=>void)=>callback([{node:canvas}])};return query;}};
  definition.lifetimes.attached.call(component);return component;
}
beforeEach(async()=>{
  vi.resetModules();revision=0;token="synthetic-image-owner";currentRoute="pages/community-compose/index";
  files=new Map([["/synthetic/one.jpg",{size:200,bytes:jpeg}],["/synthetic/two.jpg",{size:300,bytes:jpeg}],["/synthetic/edited.jpg",{size:400,bytes:jpeg}],["/synthetic/effect.jpg",{size:450,bytes:jpeg}],["/synthetic/effect-2.jpg",{size:460,bytes:jpeg}]]);
  loadedPaths=[];context={clearRect:vi.fn(),fillRect:vi.fn(),drawImage:vi.fn(),getImageData:vi.fn(()=>({data:new Uint8ClampedArray([10,100,200,255])})),putImageData:vi.fn(),measureText:(text:string)=>({width:Array.from(text).length*50}),fillText:vi.fn()};
  canvas={width:0,height:0,getContext:()=>context,requestAnimationFrame:(callback:()=>void)=>callback(),createImage:()=>{const image:any={onload:null,onerror:null};Object.defineProperty(image,"src",{set:(path:string)=>{loadedPaths.push(path);image.onload();}});return image;}};
  wxMock={getAppBaseInfo:()=>({SDKVersion:"3.10.0"}),canIUse:()=>true,setNavigationBarColor:vi.fn(),editImage:vi.fn(),cropImage:vi.fn(),showModal:vi.fn((options:any)=>options.success({confirm:true,cancel:false})),
    getImageInfo:vi.fn((options:any)=>options.success({width:2400,height:1800})),canvasToTempFilePath:vi.fn((options:any)=>options.success({tempFilePath:"/synthetic/effect.jpg"})),
    getFileSystemManager:()=>({getFileInfo:vi.fn((options:any)=>{const file=files.get(options.filePath);if(file)options.success({size:file.size});else options.fail({errMsg:"missing file"});}),
      readFile:vi.fn((options:any)=>{const file=files.get(options.filePath);if(file)options.success({data:new Uint8Array(file.bytes).buffer});else options.fail({errMsg:"missing file"});})})};
  Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{sessionToken:token}}),getCurrentPages:()=>[{route:currentRoute}],Component:(value:any)=>{definition=value;}});
  await import("../../apps/miniprogram/components/community-image-editor/index");makeComponent();
});
afterEach(()=>{definition.lifetimes.detached.call(component);vi.unstubAllGlobals();});

describe("local community image-editor component",()=>{
  it("keeps effect and final actions outside vertically scrolling tools while allowing the preview to shrink on short screens",async()=>{
    const [markup,styles]=await Promise.all([readFile(resolve("apps/miniprogram/components/community-image-editor/index.wxml"),"utf8"),readFile(resolve("apps/miniprogram/components/community-image-editor/index.wxss"),"utf8")]);
    const ancestors:string[]=[];let footerParents:string[]|null=null,effectParents:string[]|null=null;
    for(const match of markup.matchAll(/<(\/?)(view|scroll-view)\b[^>]*>/g)){const tag=match[0];if(match[1])ancestors.pop();else{if(/class="image-editor-footer"/.test(tag))footerParents=[...ancestors];if(/class="image-editor-fixed-actions"/.test(tag))effectParents=[...ancestors];if(!tag.endsWith("/>"))ancestors.push(match[2]!);}}
    expect(footerParents).toEqual(["view"]);
    expect(effectParents).toEqual(["view"]);
    expect(markup).toMatch(/<scroll-view\b[^>]*class="image-editor-lower\b[^>]*scroll-y="\{\{true\}\}"/);
    expect(styles).toMatch(/\.image-editor-preview\{[^}]*min-height:0;[^}]*height:0/);
    expect(styles).toMatch(/\.image-editor-lower--expanded\{height:40vh\}/);
    expect(styles).toMatch(/\.image-editor-footer\{[^}]*z-index:2;flex:none/);
    expect(styles).toMatch(/\.image-editor-fixed-actions\{[^}]*z-index:2;flex:none/);
    expect(styles).toMatch(/\.image-editor-tool\{[^}]*min-height:44px/);
  });
  it("checks actual file size and MIME before a single confirmation without uploading",async()=>{
    await component.confirm();await component.confirm();
    expect(events("confirm")).toEqual([["confirm",{files:[{path:"/synthetic/one.jpg",size:200},{path:"/synthetic/two.jpg",size:300}],contextKey:"owner-image-1"}]]);
    expect(wxMock.editImage).not.toHaveBeenCalled();expect(wxMock.cropImage).not.toHaveBeenCalled();
  });
  it.each(["missing","large","mime"])("retains images and reports %s validation failure without confirming",async mode=>{
    if(mode==="missing")files.delete("/synthetic/one.jpg");
    else if(mode==="large")files.set("/synthetic/one.jpg",{size:10*1024*1024+1,bytes:jpeg});
    else files.set("/synthetic/one.jpg",{size:20,bytes:[71,73,70,56]});
    await component.confirm();expect(events("confirm")).toHaveLength(0);expect(component.data.files[0].path).toBe("/synthetic/one.jpg");expect(component.data.error).not.toBe("");expect(component.data.busy).toBe(false);
  });
  it("does not initialize remote, oversized, or more than nine selected files",()=>{
    for(const input of [[{path:"https://example.test/private.jpg",size:20}],Array.from({length:10},()=>({path:"/synthetic/one.jpg",size:20})),[{path:"/synthetic/one.jpg",size:10*1024*1024+1}]]){
      Object.assign(component.data,{contextKey:component.data.contextKey+"x",initialFiles:input});definition.observers["visible, contextKey"].call(component);expect(component.data.files).toEqual([]);expect(component.data.error).toContain("重新选择");
    }
  });
  it("updates cover and removal locally and cannot confirm zero images",async()=>{
    component.selectImage({currentTarget:{dataset:{index:1}}});component.setCover();
    expect(events("change")[0]).toEqual(["change",{files:[{path:"/synthetic/two.jpg",size:100},{path:"/synthetic/one.jpg",size:99}],contextKey:"owner-image-1"}]);
    component.removeImage();component.removeImage();await component.confirm();expect(component.data.files).toEqual([]);expect(events("confirm")).toHaveLength(0);
  });
  it("retains current edits when parent echoes changed initial files",()=>{
    component.removeImage();component.data.initialFiles=[{path:"/synthetic/one.jpg",size:200}];definition.observers["visible, contextKey"].call(component);
    expect(component.data.files).toEqual([{path:"/synthetic/two.jpg",size:100}]);
  });
  it("asks before discarding changed images and permits continuing",async()=>{
    component.removeImage();wxMock.showModal.mockImplementationOnce((options:any)=>options.success({confirm:false}));await component.cancel();expect(events("cancel")).toHaveLength(0);
    await component.cancel();await component.cancel();expect(events("cancel")).toEqual([["cancel",{contextKey:"owner-image-1"}]]);expect(wxMock.showModal).toHaveBeenCalledTimes(2);
  });
  it("cancels unchanged files directly without a discard prompt",async()=>{
    await component.cancel();expect(wxMock.showModal).not.toHaveBeenCalled();expect(events("cancel")).toEqual([["cancel",{contextKey:"owner-image-1"}]]);
  });
  it.each(["edit","crop"])("uses the available native %s API and validates its new local result",async mode=>{
    wxMock[mode==="edit"?"editImage":"cropImage"].mockImplementation((options:any)=>options.success({tempFilePath:"/synthetic/edited.jpg"}));
    await component.runNativeEdit(mode);expect(component.data.files[0]).toEqual({path:"/synthetic/edited.jpg",size:400});expect(events("change")).toHaveLength(1);
    expect(events("nativebegin")).toEqual([["nativebegin",{contextKey:"owner-image-1"}]]);expect(events("nativeend")).toEqual([["nativeend",{contextKey:"owner-image-1"}]]);
    expect(wxMock[mode==="edit"?"editImage":"cropImage"]).toHaveBeenCalledWith(expect.objectContaining(mode==="crop"?{src:"/synthetic/one.jpg",cropScale:"1:1"}:{src:"/synthetic/one.jpg"}));
  });
  it("waits for native return before replacing the original path",async()=>{
    let callback:any;wxMock.editImage.mockImplementation((options:any)=>{callback=options;});const editing=component.editImage();definition.pageLifetimes.hide.call(component);
    callback.success({tempFilePath:"/synthetic/edited.jpg"});await flush();expect(component.data.files[0].path).toBe("/synthetic/one.jpg");expect(events("change")).toHaveLength(0);
    definition.pageLifetimes.show.call(component);await editing;expect(component.data.files[0].path).toBe("/synthetic/edited.jpg");expect(component.data.busy).toBe(false);expect(events("nativeend")).toHaveLength(1);
  });
  it("also waits for show when a native output's validation completes during a second hide",async()=>{
    let infoCallback:any;wxMock.editImage.mockImplementation((options:any)=>options.success({tempFilePath:"/synthetic/edited.jpg"}));
    wxMock.getFileSystemManager=()=>({getFileInfo:(options:any)=>{infoCallback=options;},readFile:(options:any)=>options.success({data:new Uint8Array(jpeg).buffer})});
    const editing=component.editImage();await flush();expect(infoCallback).toBeDefined();definition.pageLifetimes.hide.call(component);infoCallback.success({size:400});await flush();
    expect(component.data.files[0].path).toBe("/synthetic/one.jpg");expect(events("nativeend")).toHaveLength(0);
    definition.pageLifetimes.show.call(component);await editing;expect(component.data.files[0].path).toBe("/synthetic/edited.jpg");expect(component.data.busy).toBe(false);expect(events("nativeend")).toHaveLength(1);
  });
  it.each(["cancel","error","same","invalid"])("preserves the original for a native %s result",async outcome=>{
    wxMock.editImage.mockImplementation((options:any)=>outcome==="cancel"?options.fail({errMsg:"editImage:fail cancel"}):outcome==="error"?options.fail({errMsg:"editImage:fail"}):options.success({tempFilePath:outcome==="same"?"/synthetic/one.jpg":"/synthetic/missing.jpg"}));
    await component.editImage();expect(component.data.files[0].path).toBe("/synthetic/one.jpg");expect(events("change")).toHaveLength(0);expect(component.data.busy).toBe(false);if(outcome!=="cancel")expect(component.data.error).not.toBe("");
  });
  it.each(["account","revision","context","route","detach"])("drops a late native output after %s changes",async condition=>{
    let callback:any;wxMock.editImage.mockImplementation((options:any)=>{callback=options;});const editing=component.editImage();definition.pageLifetimes.hide.call(component);
    if(condition==="account")token="different-owner";
    if(condition==="revision")revision++;
    if(condition==="route")currentRoute="pages/community/index";
    if(condition==="detach")definition.lifetimes.detached.call(component);
    if(condition==="context"){Object.assign(component.data,{contextKey:"owner-image-2",initialFiles:[{path:"/synthetic/two.jpg",size:300}]});definition.observers["visible, contextKey"].call(component);}
    callback.success({tempFilePath:"/synthetic/edited.jpg"});definition.pageLifetimes.show.call(component);await editing;
    expect(events("change")).toHaveLength(0);expect(events("confirm")).toHaveLength(0);expect(component.data.files.some((file:any)=>file.path==="/synthetic/edited.jpg")).toBe(false);
  });
  it("hides unavailable native controls and never calls unsupported APIs",async()=>{
    wxMock.canIUse=()=>false;component.data.contextKey="owner-image-2";definition.observers["visible, contextKey"].call(component);
    expect(component.data).toMatchObject({canEdit:false,canCrop:false});await component.editImage();await component.cropImage();expect(wxMock.editImage).not.toHaveBeenCalled();expect(wxMock.cropImage).not.toHaveBeenCalled();
  });
  it("uses the actual canvas.type capability and export API even when the unsupported enum probe returns false",()=>{
    wxMock.canIUse=(schema:string)=>schema==="canvas.type";component.data.contextKey="owner-image-2";definition.observers["visible, contextKey"].call(component);expect(component.data.canCanvas).toBe(true);
    delete wxMock.canvasToTempFilePath;component.data.contextKey="owner-image-3";definition.observers["visible, contextKey"].call(component);expect(component.data.canCanvas).toBe(false);
  });
  it.each([["2.8.9",false],["2.9.0",true],["3.15.2",true],["invalid",false],["",true]])("checks Canvas2D minimum SDK %s",(sdk,expected)=>{
    wxMock.getAppBaseInfo=()=>({SDKVersion:sdk});component.data.contextKey="owner-image-2";definition.observers["visible, contextKey"].call(component);expect(component.data.canCanvas).toBe(expected);
  });
  it.each(["confirm","cancel","hide","detach"])("uses readable white navigation text while editing and restores the page on %s",async ending=>{
    expect(wxMock.setNavigationBarColor).toHaveBeenLastCalledWith({frontColor:"#ffffff",backgroundColor:"#101010"});
    if(ending==="confirm")await component.confirm();if(ending==="cancel")await component.cancel();if(ending==="hide")definition.pageLifetimes.hide.call(component);if(ending==="detach")definition.lifetimes.detached.call(component);
    expect(wxMock.setNavigationBarColor).toHaveBeenLastCalledWith({frontColor:"#000000",backgroundColor:"#ffffff"});
    if(ending==="hide"){definition.pageLifetimes.show.call(component);expect(wxMock.setNavigationBarColor).toHaveBeenLastCalledWith({frontColor:"#ffffff",backgroundColor:"#101010"});}
  });
  it("does not let an older component closing reset the current editor's navigation colors",()=>{
    const previous=component;makeComponent();const callCount=wxMock.setNavigationBarColor.mock.calls.length;definition.lifetimes.detached.call(previous);
    expect(wxMock.setNavigationBarColor).toHaveBeenCalledTimes(callCount);expect(wxMock.setNavigationBarColor).toHaveBeenLastCalledWith({frontColor:"#ffffff",backgroundColor:"#101010"});
  });
  it("preserves editing chrome during a native editor hide and tolerates an unavailable color API",async()=>{
    let callback:any;wxMock.editImage.mockImplementation((options:any)=>{callback=options;});const editing=component.editImage();const calls=wxMock.setNavigationBarColor.mock.calls.length;definition.pageLifetimes.hide.call(component);
    expect(wxMock.setNavigationBarColor).toHaveBeenCalledTimes(calls);callback.fail({errMsg:"editImage:fail cancel"});definition.pageLifetimes.show.call(component);await editing;
    delete wxMock.setNavigationBarColor;component.data.contextKey="owner-image-2";expect(()=>definition.observers["visible, contextKey"].call(component)).not.toThrow();
  });
  it("retains chosen order across an ordinary background return",()=>{
    component.removeImage();definition.pageLifetimes.hide.call(component);definition.pageLifetimes.show.call(component);expect(component.data.files).toEqual([{path:"/synthetic/two.jpg",size:100}]);
  });
  it("renders real filtered pixels and text into a bounded new JPEG only on explicit apply",async()=>{
    component.changeFilter({currentTarget:{dataset:{value:"mono"}}});component.changeAdjustment({currentTarget:{dataset:{field:"brightness"}},detail:{value:10}});
    component.changeOverlayText({detail:{value:"真实图片文字"}});component.changeSticker({currentTarget:{dataset:{value:"✨"}}});
    expect(component.data.effectDirty).toBe(true);expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();expect(context.drawImage).not.toHaveBeenCalled();
    await component.confirm();expect(events("confirm")).toHaveLength(0);await component.applyEffects();
    expect(canvas).toMatchObject({width:1440,height:1080});expect(context.drawImage).toHaveBeenCalledWith(expect.anything(),0,0,1440,1080);
    const pixels=context.putImageData.mock.calls[0][0].data;expect(pixels[0]).toBe(pixels[1]);expect(pixels[1]).toBe(pixels[2]);expect(pixels[0]).not.toBe(10);expect(pixels[3]).toBe(255);
    expect(context.fillText).toHaveBeenCalledWith("真实图片文字",720,expect.any(Number));expect(context.fillText).toHaveBeenCalledWith("✨",720,expect.any(Number));
    expect(wxMock.canvasToTempFilePath).toHaveBeenCalledWith(expect.objectContaining({canvas,fileType:"jpg",quality:.9,destWidth:1440,destHeight:1080}),component);
    expect(component.data).toMatchObject({busy:false,effectDirty:false});expect(component.data.files[0]).toEqual({path:"/synthetic/effect.jpg",size:450});expect(events("change")).toHaveLength(1);
    await component.confirm();expect(events("confirm")[0][1].files[0]).toEqual({path:"/synthetic/effect.jpg",size:450});
  });
  it("restores original pixels from the pre-effect file instead of stacking an original preset onto the filtered output",async()=>{
    component.changeFilter({currentTarget:{dataset:{value:"warm"}}});await component.applyEffects();
    component.selectImage({currentTarget:{dataset:{index:1}}});component.selectImage({currentTarget:{dataset:{index:0}}});expect(component.data.filter).toBe("warm");
    component.changeFilter({currentTarget:{dataset:{value:"original"}}});wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>options.success({tempFilePath:"/synthetic/effect-2.jpg"}));await component.applyEffects();
    expect(loadedPaths).toEqual(["/synthetic/one.jpg","/synthetic/one.jpg"]);expect(Array.from(context.putImageData.mock.calls[1][0].data)).toEqual([10,100,200,255]);
  });
  it("draws complex emoji and combining marks as whole glyphs when wrapping overlay text",async()=>{
    const family="👩🏽‍👩🏾‍👧🏻‍👦🏿",accent="e\u0301";context.measureText=(text:string)=>({width:Array.from(text).length*600});
    component.changeOverlayText({detail:{value:`A${family}${accent}B`}});await component.applyEffects();
    expect(context.fillText.mock.calls.map((call:any[])=>call[0])).toEqual(["A",family,accent,"B"]);
    expect(component.data.files[0].path).toBe("/synthetic/effect.jpg");
  });
  it.each(["export","mime","same","canvas"])("keeps the original and pending settings after %s rendering failure, then permits retry",async condition=>{
    component.changeFilter({currentTarget:{dataset:{value:"warm"}}});
    if(condition==="export")wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>options.fail({errMsg:"synthetic export failure"}));
    if(condition==="mime"){files.set("/synthetic/effect.jpg",{size:450,bytes:[71,73,70]});}
    if(condition==="same")wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>options.success({tempFilePath:"/synthetic/one.jpg"}));
    if(condition==="canvas")context.getImageData.mockImplementationOnce(()=>{throw new Error("synthetic canvas error");});
    await component.applyEffects();expect(component.data.files[0].path).toBe("/synthetic/one.jpg");expect(component.data).toMatchObject({busy:false,effectDirty:true});expect(component.data.error).not.toBe("");expect(events("change")).toHaveLength(0);
    files.set("/synthetic/effect.jpg",{size:450,bytes:jpeg});await component.applyEffects();expect(component.data.files[0].path).toBe("/synthetic/effect.jpg");expect(events("change")).toHaveLength(1);
  });
  it("rejects overlong overlay text without truncating or exporting it",async()=>{
    component.changeOverlayText({detail:{value:"字".repeat(31)}});await component.applyEffects();expect(component.data.overlayText).toHaveLength(31);expect(component.data.error).toContain("最多30字");expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();
    component.discardEffects();expect(component.data).toMatchObject({effectDirty:false,overlayText:""});
  });
  it.each(["account","revision","context","background"])("does not replace any image when a Canvas callback arrives after %s",async condition=>{
    let exportCallback:any;wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>{exportCallback=options;});component.changeFilter({currentTarget:{dataset:{value:"vivid"}}});const applying=component.applyEffects();await flush();expect(exportCallback).toBeDefined();
    if(condition==="account")token="another-owner";
    if(condition==="revision")revision++;
    if(condition==="background")definition.pageLifetimes.hide.call(component);
    if(condition==="context"){Object.assign(component.data,{contextKey:"owner-image-2",initialFiles:[{path:"/synthetic/two.jpg",size:300}]});definition.observers["visible, contextKey"].call(component);}
    exportCallback.success({tempFilePath:"/synthetic/effect.jpg"});await applying;expect(events("change")).toHaveLength(0);expect(component.data.files.some((file:any)=>file.path==="/synthetic/effect.jpg")).toBe(false);
    if(condition==="background"){definition.pageLifetimes.show.call(component);expect(component.data).toMatchObject({busy:false,effectDirty:true});}
  });
  it("requires applying or undoing pending effects before changing the selected batch",async()=>{
    component.changeFilter({currentTarget:{dataset:{value:"warm"}}});component.selectImage({currentTarget:{dataset:{index:1}}});component.removeImage();component.setCover();await component.editImage();
    expect(component.data.selected).toBe(0);expect(component.data.files).toHaveLength(2);expect(wxMock.editImage).not.toHaveBeenCalled();
    component.discardEffects();component.selectImage({currentTarget:{dataset:{index:1}}});expect(component.data.selected).toBe(1);
  });
  it("asks before discarding unapplied effects without exporting a replacement",async()=>{
    component.changeFilter({currentTarget:{dataset:{value:"warm"}}});await component.cancel();expect(wxMock.showModal).toHaveBeenCalledWith(expect.objectContaining({title:"放弃图片修改？"}));expect(events("cancel")).toHaveLength(1);expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();
  });
  it("ignores image load errors from stale paths or generations",()=>{
    component.imagePreviewFailed({currentTarget:{dataset:{path:"/synthetic/two.jpg",generation:component.data.generation}}});expect(component.data.error).toBe("");
    component.imagePreviewFailed({currentTarget:{dataset:{path:"/synthetic/one.jpg",generation:component.data.generation-1}}});expect(component.data.error).toBe("");
    component.imagePreviewFailed({currentTarget:{dataset:{path:"/synthetic/one.jpg",generation:component.data.generation}}});expect(component.data.error).toContain("无法显示");
  });
});
