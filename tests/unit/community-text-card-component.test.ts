import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TEXT_CARD_TEMPLATES, textCardGraphemes } from "../../apps/miniprogram/services/ugc-text-card-layout";
vi.mock("../../apps/miniprogram/services/layout",()=>({currentChromeStyle:()=>"--cisme-safe-bottom:34px"}));
let definition:any,component:any,canvas:any,context:any,wxMock:any,token:string;
const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
const template=(value:string)=>({currentTarget:{dataset:{template:value}}});
const events=(name:string)=>component.triggerEvent.mock.calls.filter(([event]:any[])=>event===name);
async function generated(){const generation=component.confirm();await vi.runAllTimersAsync();await generation;expect(component.data.stage).toBe("templates");}
beforeEach(async()=>{
  vi.useFakeTimers();vi.resetModules();token="synthetic-text-card-owner";
  const gradient={addColorStop:vi.fn()};
  context={font:"28px sans-serif",scale:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),strokeRect:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),createLinearGradient:vi.fn(()=>gradient),
    measureText:(text:string)=>({width:textCardGraphemes(text).length*Number(context.font.match(/(\d+)px/)?.[1]||28)})};
  canvas={width:0,height:0,getContext:()=>context,requestAnimationFrame:(callback:()=>void)=>setTimeout(callback,0)};
  wxMock={getWindowInfo:()=>({windowWidth:390,windowHeight:844,pixelRatio:3}),hideKeyboard:vi.fn(),canvasToTempFilePath:vi.fn((options:any)=>options.success({tempFilePath:`/synthetic/text-card-${wxMock.canvasToTempFilePath.mock.calls.length}.png`})),
    getFileSystemManager:()=>({getFileInfo:vi.fn((options:any)=>options.success({size:8192}))})};
  Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{sessionToken:token}}),Component:(value:any)=>{definition=value;}});
  await import("../../apps/miniprogram/components/community-text-card/index");
  component={data:{...structuredClone(definition.data),visible:true,initialText:"今天认真记录护理感受",initialTemplate:"plain",contextKey:"owner-epoch-1"},...definition.methods,
    setData:vi.fn(function(this:any,patch:any){Object.assign(this.data,patch);}),triggerEvent:vi.fn(),
    createSelectorQuery:()=>{const query:any={select:()=>query,fields:()=>query,exec:(callback:(result:any)=>void)=>callback([{node:canvas}])};return query;}};
  definition.lifetimes.attached.call(component);
});
afterEach(()=>{definition.lifetimes.detached.call(component);vi.useRealTimers();vi.unstubAllGlobals();});

describe("local staged community text card",()=>{
  it("starts with text input only and produces six actual PNGs before offering templates, without confirming",async()=>{
    expect(component.data).toMatchObject({stage:"input",canProceed:true,canExport:false,previewPath:""});expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();
    const generating=component.confirm();expect(component.data).toMatchObject({stage:"generating",busy:true,previewPending:true});
    await vi.runAllTimersAsync();await generating;
    expect(component.data).toMatchObject({stage:"templates",busy:false,canExport:true,previewPath:"/synthetic/text-card-1.png"});
    expect(component.data.templates.map((item:any)=>item.value)).toEqual(TEXT_CARD_TEMPLATES.map(item=>item.value));
    expect(new Set(component.data.templates.map((item:any)=>item.previewPath)).size).toBe(6);expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(6);
    expect(canvas).toMatchObject({width:1440,height:1920});expect(wxMock.canvasToTempFilePath).toHaveBeenCalledWith(expect.objectContaining({canvas,fileType:"png",destWidth:1440,destHeight:1920}),component);
    expect(context.createLinearGradient).toHaveBeenCalledOnce();expect(context.strokeRect).toHaveBeenCalledTimes(2);expect(events("confirm")).toHaveLength(0);
  });
  it("switches among current verified PNGs without redrawing and confirms only the selected file once",async()=>{
    await generated();const chosen=component.data.templates.find((item:any)=>item.value==="care").previewPath;
    for(const value of ["border","memo","minimal","care"])component.selectTemplate(template(value));
    expect(component.data).toMatchObject({template:"care",previewPath:chosen,canExport:true});expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(6);
    expect(events("change").at(-1)).toEqual(["change",{text:"今天认真记录护理感受",template:"care",contextKey:"owner-epoch-1"}]);
    await component.confirm();await component.confirm();definition.pageLifetimes.show.call(component);
    expect(events("confirm")).toEqual([["confirm",{tempFilePath:chosen,size:8192,text:"今天认真记录护理感受",template:"care",contextKey:"owner-epoch-1"}]]);
    expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(6);
  });
  it("returns from templates to input with its text and selection, then regenerates all PNGs after editing",async()=>{
    await generated();component.selectTemplate(template("memo"));component.back();
    expect(component.data).toMatchObject({stage:"input",text:"今天认真记录护理感受",template:"memo",previewPath:"",canExport:false});expect(events("cancel")).toHaveLength(0);
    component.editText({detail:{value:"我新的护理记录🙂"}});expect(events("change").at(-1)?.[1]).toMatchObject({text:"我新的护理记录🙂",template:"memo"});
    await generated();expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(12);await component.confirm();
    expect(events("confirm")[0][1]).toMatchObject({tempFilePath:"/synthetic/text-card-7.png",text:"我新的护理记录🙂",template:"memo"});
  });
  it("cancels real generation back to input and ignores its late callback without cancelling the whole flow",async()=>{
    let pending:any;wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>{pending=options;});
    const generating=component.confirm();await vi.advanceTimersByTimeAsync(1);expect(pending).toBeDefined();component.cancelGeneration();
    expect(component.data).toMatchObject({stage:"input",text:"今天认真记录护理感受",busy:false,canExport:false});expect(events("cancel")).toHaveLength(0);
    pending.success({tempFilePath:"/synthetic/cancelled.png"});await generating;expect(component.data.stage).toBe("input");expect(component.data.previewPath).toBe("");
    await generated();expect(component.data.previewPath).not.toBe("/synthetic/cancelled.png");
  });
  it("does not expose a partial batch after an export failure and allows an explicit complete retry",async()=>{
    wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>options.success({tempFilePath:"/synthetic/partial.png"})).mockImplementationOnce((options:any)=>options.fail({errMsg:"synthetic failure"}));
    let generating=component.confirm();await vi.runAllTimersAsync();await generating;
    expect(component.data).toMatchObject({stage:"input",text:"今天认真记录护理感受",busy:false,canExport:false,renderFailed:true,previewPath:""});expect(component.data.error).toContain("未生成成功");
    component.retryPreview();await vi.runAllTimersAsync();await flush();expect(component.data.stage).toBe("templates");
    expect(component.data.templates.every((item:any)=>item.previewPath&&item.previewPath!=="/synthetic/partial.png")).toBe(true);expect(events("confirm")).toHaveLength(0);
  });
  it.each(["cancel","detach","account","context","hide"])("ignores a pending generation after %s",async condition=>{
    let pending:any;wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>{pending=options;});const generating=component.confirm();await vi.advanceTimersByTimeAsync(1);expect(pending).toBeDefined();
    if(condition==="cancel"){component.cancel();expect(events("cancel")).toHaveLength(1);}
    else if(condition==="detach")definition.lifetimes.detached.call(component);
    else if(condition==="account"){token="another-synthetic-owner";definition.pageLifetimes.show.call(component);}
    else if(condition==="context"){Object.assign(component.data,{contextKey:"owner-epoch-2",initialText:"新卡文字"});definition.observers["visible, contextKey"].call(component);}
    else definition.pageLifetimes.hide.call(component);
    pending.success({tempFilePath:"/synthetic/stale.png"});await generating;
    expect(component.data.previewPath).not.toBe("/synthetic/stale.png");expect(events("confirm")).toHaveLength(0);expect(wxMock.canvasToTempFilePath).toHaveBeenCalledOnce();
    if(condition==="account")expect(component.data.text).toBe("");if(condition==="context")expect(component.data.text).toBe("新卡文字");
  });
  it("never lets an old cancelled batch reset or replace a newer completed batch",async()=>{
    let old:any;wxMock.canvasToTempFilePath.mockImplementationOnce((options:any)=>{old=options;});const firstBatch=component.confirm();await vi.advanceTimersByTimeAsync(1);component.cancelGeneration();
    component.editText({detail:{value:"新的当前文字"}});await generated();const current=component.data.previewPath;
    old.success({tempFilePath:"/synthetic/old.png"});await firstBatch;expect(component.data).toMatchObject({stage:"templates",text:"新的当前文字",previewPath:current,canExport:true,busy:false});
  });
  it("keeps input across hide/show and resumes a template page by generating fresh verified files without confirming",async()=>{
    component.editText({detail:{value:"中断后仍保留文字"}});definition.pageLifetimes.hide.call(component);definition.pageLifetimes.show.call(component);
    expect(component.data).toMatchObject({stage:"input",text:"中断后仍保留文字"});expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();
    await generated();component.selectTemplate(template("border"));definition.pageLifetimes.hide.call(component);definition.pageLifetimes.show.call(component);await vi.runAllTimersAsync();
    expect(component.data).toMatchObject({stage:"templates",text:"中断后仍保留文字",template:"border",canExport:true,busy:false});expect(wxMock.canvasToTempFilePath).toHaveBeenCalledTimes(12);expect(events("confirm")).toHaveLength(0);
  });
  it("initializes a fresh coalesced context only from current parent data and emits overall cancel once",async()=>{
    component.cancel();component.cancel();expect(events("cancel")).toHaveLength(1);
    Object.assign(component.data,{contextKey:"owner-epoch-2",initialText:"新卡初始文字",initialTemplate:"care"});definition.observers["visible, contextKey"].call(component);
    expect(component.data).toMatchObject({stage:"input",text:"新卡初始文字",template:"care",canProceed:true,canExport:false});
    component.back();expect(events("cancel").at(-1)).toEqual(["cancel",{contextKey:"owner-epoch-2"}]);expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();
  });
  it.each(["", " \n\u200b", "护".repeat(301)])("does not generate empty or over-limit content",async text=>{
    component.editText({detail:{value:text}});await component.confirm();expect(component.data.canProceed).toBe(false);expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();expect(events("confirm")).toHaveLength(0);
  });
  it("allows 299 graphemes of narrow Latin text and uses actual Canvas widths before accepting the card",async()=>{
    const text=Array(10).fill("i".repeat(29)).join("\n");context.measureText=(value:string)=>({width:value.length*7});
    component.editText({detail:{value:text}});expect(component.data).toMatchObject({count:299,canProceed:true});
    await generated();await component.confirm();expect(events("confirm")[0][1].text).toBe(text);
  });
  it("rejects actual multi-card overflow during Canvas layout without truncating input",async()=>{
    const text="记录\n".repeat(40);component.editText({detail:{value:text}});expect(component.data.canProceed).toBe(true);
    const generating=component.confirm();await vi.runAllTimersAsync();await generating;
    expect(component.data).toMatchObject({stage:"input",text,canExport:false,renderFailed:true});expect(component.data.error).toContain("超出一张卡片");expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();expect(events("confirm")).toHaveLength(0);
  });
  it("uses actual Canvas widths to retain two intentional short lines without a dangling final fragment",async()=>{
    const text="护理慢慢来，\n感受每天的小变化。",drawn:Array<{text:string;font:string}>=[];
    context.fillText.mockImplementation((line:string)=>drawn.push({text:line,font:context.font}));component.editText({detail:{value:text}});await generated();
    const body=drawn.filter(item=>item.text!=="“"&&!item.text.startsWith("CISME"));
    expect(body).toHaveLength(12);expect(body.map(item=>item.text)).toEqual(Array(6).fill(text.split("\n")).flat());
    expect(body.every(item=>item.font==="65px sans-serif")).toBe(true);
  });
  it("keeps the baseline Canvas font and strict layout for a single short phrase and 300-character text",async()=>{
    component.editText({detail:{value:"测试"}});const drawn:Array<{text:string;font:string}>=[];context.fillText.mockImplementation((line:string)=>drawn.push({text:line,font:context.font}));await generated();
    expect(drawn.filter(item=>item.text==="测试").every(item=>item.font==="112px sans-serif")).toBe(true);
    component.back();component.editText({detail:{value:"护".repeat(300)}});drawn.length=0;await generated();
    const body=drawn.filter(item=>/^护+$/.test(item.text));expect(body.length).toBeGreaterThan(6);expect(body.every(item=>item.font==="28px sans-serif")).toBe(true);
    expect(body.reduce((total,item)=>total+item.text.length,0)).toBe(300*6);
  });
  it("preserves all 300 visible graphemes and rejects mutation attempts while a batch is generating",async()=>{
    const text="护".repeat(295)+"👨‍👩‍👧‍👦👍🏽🇨🇳e\u03011️⃣";component.editText({detail:{value:text}});expect(component.data).toMatchObject({count:300,canProceed:true});
    const generating=component.confirm();component.editText({detail:{value:"迟到输入"}});component.selectTemplate(template("memo"));await vi.runAllTimersAsync();await generating;
    expect(component.data.text).toBe(text);expect(component.data.template).toBe("plain");await component.confirm();expect(events("confirm")[0][1].text).toBe(text);
  });
  it("reports a real native frame timeout without entering templates",async()=>{
    canvas.requestAnimationFrame=()=>0;const generating=component.confirm();await vi.runAllTimersAsync();await generating;
    expect(component.data).toMatchObject({stage:"input",busy:false,renderFailed:true,canExport:false});expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();
  });
  it.each([0,10*1024*1024+1])("rejects an exported PNG whose actual file size is %s",async size=>{
    wxMock.getFileSystemManager=()=>({getFileInfo:(options:any)=>options.success({size})});const generating=component.confirm();await vi.runAllTimersAsync();await generating;
    expect(component.data).toMatchObject({stage:"input",canExport:false,renderFailed:true,previewPath:""});expect(events("confirm")).toHaveLength(0);
  });
  it("rechecks the current PNG at final Next and permits regeneration when it disappeared",async()=>{
    await generated();wxMock.getFileSystemManager=()=>({getFileInfo:(options:any)=>options.fail({errMsg:"file unavailable"})});await component.confirm();
    expect(component.data).toMatchObject({stage:"templates",canExport:false,renderFailed:true,previewPath:""});expect(events("confirm")).toHaveLength(0);
    wxMock.getFileSystemManager=()=>({getFileInfo:(options:any)=>options.success({size:8192})});component.retryPreview();await vi.runAllTimersAsync();await flush();expect(component.data.canExport).toBe(true);
  });
  it("ignores a late final file check after returning to input",async()=>{
    await generated();let pending:any;wxMock.getFileSystemManager=()=>({getFileInfo:(options:any)=>{pending=options;}});const final=component.confirm();component.back();pending.success({size:8192});await final;
    expect(component.data).toMatchObject({stage:"input",busy:false,canExport:false});expect(events("confirm")).toHaveLength(0);
  });
  it("offers existing direct-body mode only in input and never emits it from a stale identity",async()=>{
    component.editText({detail:{value:"直接写护理正文"}});component.writeBody();component.writeBody();expect(events("cancel")).toEqual([["cancel",{contextKey:"owner-epoch-1",mode:"body"}]]);expect(wxMock.canvasToTempFilePath).not.toHaveBeenCalled();
    Object.assign(component.data,{contextKey:"owner-epoch-2",initialText:"另一张卡"});definition.observers["visible, contextKey"].call(component);token="different-owner";component.writeBody();expect(events("cancel")).toHaveLength(1);
  });
  it("shows only actual PNGs as ordinary images and keeps the one drawing canvas offscreen",async()=>{
    const [markup,styles]=await Promise.all([readFile(resolve("apps/miniprogram/components/community-text-card/index.wxml"),"utf8"),readFile(resolve("apps/miniprogram/components/community-text-card/index.wxss"),"utf8")]);
    expect(markup).toMatch(/<image\b[^>]*src="\{\{previewPath\}\}"[^>]*binderror="previewImageFailed"/);expect(markup).not.toMatch(/<canvas\b[^>]*previewWidth/);expect(markup.match(/<canvas\b/g)).toHaveLength(1);
    expect(styles).toMatch(/\.text-card-canvas\{[^}]*left:-2000px;[^}]*width:1px;height:1px/);
    expect(markup).toContain("bindtap=\"cancelGeneration\"");expect(markup).not.toContain("%");
    expect(markup).toContain("/assets/icons/close-plum.svg");expect(markup).toContain("/assets/icons/arrow-left-ink.svg");
    expect(styles).toContain(".text-card-confirm{width:112px;min-height:48px;");expect(styles).toContain(".text-card-footer{display:flex;justify-content:flex-end;");
    expect(styles).toContain(".text-card-placeholder{color:#75697a}");expect(styles).toContain(".text-card-writing-copy{display:flex;flex:1;flex-direction:column;justify-content:center;");
  });
  it("rejects stale preview errors while a current image error disables final Next",async()=>{
    await generated();const old=component.data.previewPath,revision=component.data.previewRevision;component.selectTemplate(template("memo"));
    component.previewImageFailed({currentTarget:{dataset:{path:old,revision}}});expect(component.data.canExport).toBe(true);
    component.previewImageFailed({currentTarget:{dataset:{path:component.data.previewPath,revision}}});expect(component.data).toMatchObject({previewPath:"",canExport:false,renderFailed:true});
    await component.confirm();expect(events("confirm")).toHaveLength(0);
  });
});
