import { currentChromeStyle } from "../../services/layout";
import { hasTextCardContent, layoutTextCard, normalizeTextCardText, textCardFontSize, textCardGraphemes, textCardHeight, textCardWidth, type TextCardTemplate } from "../../services/ugc-text-card-layout";

type Runtime = { attached:boolean; open:boolean; finished:boolean; suspended:boolean; generation:number; renderRevision:number; contextKey:string; session:string; timer:ReturnType<typeof setTimeout>|null; canvas:WechatMiniprogram.Canvas|null };
const states = new WeakMap<object,Runtime>();
function state(component:object):Runtime {
  let value=states.get(component);
  if(!value){value={attached:false,open:false,finished:false,suspended:false,generation:0,renderRevision:0,contextKey:"",session:"",timer:null,canvas:null};states.set(component,value);}
  return value;
}
function session():string {try{return getApp<IAppOption>().globalData.sessionToken||"";}catch{return "";}}
const isTemplate=(value:string):value is TextCardTemplate=>["plain","lilac","memo"].includes(value);

Component({
  properties:{visible:{type:Boolean,value:false},initialText:{type:String,value:""},initialTemplate:{type:String,value:"plain"},contextKey:{type:String,value:""}},
  data:{text:"",template:"plain" as TextCardTemplate,count:0,busy:false,error:"",renderFailed:false,canExport:false,keyboardVisible:false,previewPath:"",previewPending:false,previewRevision:0,
    chromeStyle:"",previewWidth:280,previewHeight:373,templates:[{value:"plain",label:"简洁白"},{value:"lilac",label:"柔紫"},{value:"memo",label:"备忘"}]},
  observers:{"visible, contextKey"(){if(state(this).attached)this.syncVisibility();}},
  lifetimes:{attached(){state(this).attached=true;this.syncVisibility();},detached(){this.invalidate();state(this).attached=false;states.delete(this);}},
  pageLifetimes:{show(){const runtime=state(this);runtime.suspended=false;if(runtime.attached){this.syncVisibility();if(runtime.open)this.schedulePreview();}},
    hide(){const runtime=state(this);runtime.suspended=true;runtime.generation+=1;runtime.renderRevision+=1;if(runtime.timer)clearTimeout(runtime.timer);runtime.timer=null;this.setData({busy:false,keyboardVisible:false,previewPath:"",previewPending:false,canExport:false});},
    resize(){if(state(this).open)this.resizePreview();}},
  methods:{
    holdOverlay(){},
    invalidate(){const runtime=state(this);runtime.generation+=1;runtime.renderRevision+=1;runtime.open=false;if(runtime.timer)clearTimeout(runtime.timer);runtime.timer=null;
      if(runtime.canvas){try{runtime.canvas.getContext("2d").clearRect(0,0,textCardWidth,textCardHeight);}catch{/* A detached canvas needs no further drawing. */}}runtime.canvas=null;},
    current(generation:number){const runtime=state(this);return runtime.attached&&runtime.open&&!runtime.suspended&&this.data.visible&&runtime.generation===generation&&runtime.contextKey===this.data.contextKey&&runtime.session===session();},
    currentRender(generation:number,revision:number){return this.current(generation)&&state(this).renderRevision===revision;},
    resizePreview(){let width=390;try{width=wx.getWindowInfo().windowWidth;}catch{/* Retain the compact fallback. */}
      const previewWidth=Math.max(180,Math.min(300,width-44));this.setData({previewWidth,previewHeight:Math.round(previewWidth*4/3),chromeStyle:currentChromeStyle()});},
    syncVisibility(){const runtime=state(this);
      if(!this.data.visible){this.invalidate();this.setData({busy:false,keyboardVisible:false,previewPath:"",previewPending:false,canExport:false});return;}
      if(runtime.finished&&runtime.contextKey===this.data.contextKey)return;
      if(runtime.open&&runtime.contextKey===this.data.contextKey){if(runtime.session!==session()){this.invalidate();runtime.finished=true;this.setData({text:"",count:0,busy:false,previewPath:"",previewPending:false,canExport:false});}return;}
      // Parent visibility changes can coalesce into one frame. A fresh opaque
      // key starts a new opening, using only the parent's current initial data.
      this.invalidate();runtime.finished=false;runtime.open=true;runtime.contextKey=this.data.contextKey;runtime.session=session();
      const text=this.data.initialText,template=isTemplate(this.data.initialTemplate)?this.data.initialTemplate:"plain";
      this.setData({text,template,count:textCardGraphemes(normalizeTextCardText(text)).length,busy:false,error:"",renderFailed:false,canExport:false,keyboardVisible:false,previewPath:"",previewPending:false});
      this.resizePreview();this.schedulePreview();
    },
    notifyChange(){const runtime=state(this);if(!this.current(runtime.generation))return;
      this.triggerEvent("change",{text:this.data.text,template:this.data.template,contextKey:runtime.contextKey});},
    editText(event:WechatMiniprogram.Input){if(this.data.busy||!this.current(state(this).generation))return;
      const text=event.detail.value;this.setData({text,count:textCardGraphemes(normalizeTextCardText(text)).length,canExport:false});this.notifyChange();this.schedulePreview();},
    selectTemplate(event:WechatMiniprogram.TouchEvent){const template=String(event.currentTarget.dataset.template||"");
      if(this.data.busy||!isTemplate(template)||template===this.data.template||!this.current(state(this).generation))return;
      this.setData({template,canExport:false});this.notifyChange();this.schedulePreview();},
    keyboardChange(event:{detail:{height:number}}){this.setData({keyboardVisible:event.detail.height>0});},
    schedulePreview(){const runtime=state(this);if(!this.current(runtime.generation))return;if(runtime.timer)clearTimeout(runtime.timer);const generation=runtime.generation,revision=++runtime.renderRevision;
      this.setData({previewPath:"",previewPending:true,previewRevision:revision,renderFailed:false,canExport:false});
      runtime.timer=setTimeout(()=>{runtime.timer=null;if(this.currentRender(generation,revision))void this.refreshPreview(generation,revision);},100);},
    retryPreview(){if(!this.data.busy)this.schedulePreview();},
    async refreshPreview(generation:number,revision:number){
      try{const canvas=await this.renderCard(generation,revision);if(!canvas||!this.currentRender(generation,revision))return;
        const file=await this.exportCard(canvas,generation,revision);if(!file||!this.currentRender(generation,revision))return;
        this.setData({previewPath:file.tempFilePath,previewPending:false,renderFailed:false,canExport:true,error:""});
      }catch{if(this.currentRender(generation,revision))this.setData({previewPath:"",previewPending:false,renderFailed:true,canExport:false,error:"文字卡片预览暂未生成，请重试。"});}
    },
    previewImageFailed(event:{currentTarget:{dataset:{path?:string;revision?:number}}}){const {path,revision}=event.currentTarget.dataset;
      if(path&&path===this.data.previewPath&&this.currentRender(state(this).generation,Number(revision)))this.setData({previewPath:"",previewPending:false,renderFailed:true,canExport:false,error:"文字卡片预览暂未显示，请重新生成。"});},
    async renderCard(generation:number,revision:number):Promise<WechatMiniprogram.Canvas|null>{
      if(!this.currentRender(generation,revision))return null;
        const canvas=await new Promise<WechatMiniprogram.Canvas>((resolve,reject)=>{this.createSelectorQuery().select("#communityTextCardCanvas").fields({node:true,size:true}).exec(result=>{
          const node=result[0]?.node as WechatMiniprogram.Canvas|undefined;if(node)resolve(node);else reject(new Error("CANVAS_NOT_READY"));});});
        if(!this.currentRender(generation,revision))return null;
        let pixelRatio=2;try{pixelRatio=Math.max(1,Math.min(2,wx.getWindowInfo().pixelRatio));}catch{/* A 2x backing store keeps the local image legible. */}
        canvas.width=Math.round(textCardWidth*pixelRatio);canvas.height=Math.round(textCardHeight*pixelRatio);state(this).canvas=canvas;
        const context=canvas.getContext("2d");
        context.scale(pixelRatio,pixelRatio);
        const template=this.data.template,background=template==="lilac"?"#eee4f2":template==="memo"?"#fbfaf6":"#ffffff";
        context.fillStyle=background;context.fillRect(0,0,textCardWidth,textCardHeight);
        context.textBaseline="top";context.fillStyle="#75697a";context.font="22px sans-serif";context.fillText(template==="memo"?"CISME · 护理备忘":"CISME · 真实记录",64,62);
        const fontSize=textCardFontSize(this.data.text);context.font=`${fontSize}px sans-serif`;
        const layout=layoutTextCard(this.data.text,text=>context.measureText(text).width,{fontSize});
        if(template==="memo"){
          context.strokeStyle="rgba(78,47,91,.13)";context.lineWidth=1;
          for(let y=148+layout.lineHeight;y<textCardHeight-96;y+=layout.lineHeight){context.beginPath();context.moveTo(64,y);context.lineTo(textCardWidth-64,y);context.stroke();}
        }
        if(layout.overflow||layout.count>300){context.fillStyle="#75697a";context.font="30px sans-serif";context.fillText("文字超出一张卡片",64,164);context.fillText("请减少换行或精简内容",64,216);}
        else {context.fillStyle=hasTextCardContent(layout.text)?"#352a3a":"#75697a";
          const lines=hasTextCardContent(layout.text)?layout.lines:["先写下想分享的文字"];
          lines.forEach((line,index)=>context.fillText(line,64,148+index*layout.lineHeight));}
        context.fillStyle="#75697a";context.font="18px sans-serif";context.fillText("CISME",64,textCardHeight-58);
        if(this.currentRender(generation,revision)&&!layout.valid)this.setData({previewPath:"",previewPending:false,error:hasTextCardContent(this.data.text)?layout.error:"",renderFailed:false,canExport:false});
        return layout.valid?canvas:null;
    },
    async exportCard(canvas:WechatMiniprogram.Canvas,generation:number,revision:number):Promise<{tempFilePath:string;size:number}|null>{
      await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("CANVAS_FRAME_TIMEOUT")),800);
        canvas.requestAnimationFrame(()=>{clearTimeout(timeout);resolve();});});
      if(!this.currentRender(generation,revision))return null;
      const tempFilePath=await new Promise<string>((resolve,reject)=>wx.canvasToTempFilePath({canvas,destWidth:canvas.width,destHeight:canvas.height,fileType:"png",success:result=>resolve(result.tempFilePath),fail:reject},this));
      if(!this.currentRender(generation,revision))return null;
      const size=await new Promise<number>((resolve,reject)=>wx.getFileSystemManager().getFileInfo({filePath:tempFilePath,success:result=>resolve(result.size),fail:reject}));
      if(!this.currentRender(generation,revision))return null;
      if(!tempFilePath||!Number.isSafeInteger(size)||size<1||size>10*1024*1024)throw new Error("TEXT_CARD_FILE_INVALID");
      return {tempFilePath,size};
    },
    async confirm(){const runtime=state(this),generation=runtime.generation,contextKey=runtime.contextKey;if(this.data.busy||!this.data.canExport||!this.current(generation))return;
      if(runtime.timer)clearTimeout(runtime.timer);runtime.timer=null;
      this.setData({busy:true,error:""});
      try{
        const revision=runtime.renderRevision;const canvas=await this.renderCard(generation,revision);if(!canvas||!this.currentRender(generation,revision))return;
        const text=normalizeTextCardText(this.data.text),template=this.data.template;
        const file=await this.exportCard(canvas,generation,revision);if(!file||!this.currentRender(generation,revision))return;
        this.setData({busy:false,canExport:false});runtime.open=false;runtime.finished=true;
        this.triggerEvent("confirm",{...file,text,template,contextKey});
      }catch{if(this.current(generation))this.setData({busy:false,error:"文字卡片未生成成功，请重试。"});}
      finally{if(this.current(generation))this.setData({busy:false});}
    },
    cancel(){const runtime=state(this);if(!this.current(runtime.generation))return;const contextKey=runtime.contextKey;
      this.invalidate();runtime.finished=true;this.setData({busy:false,canExport:false,keyboardVisible:false,previewPath:"",previewPending:false});this.triggerEvent("cancel",{contextKey});},
    writeBody(){const runtime=state(this);if(!this.current(runtime.generation))return;const contextKey=runtime.contextKey;
      this.invalidate();runtime.finished=true;this.setData({busy:false,canExport:false,keyboardVisible:false,previewPath:"",previewPending:false});this.triggerEvent("cancel",{contextKey,mode:"body"});}
  }
});
