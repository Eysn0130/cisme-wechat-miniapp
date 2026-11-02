import { currentChromeStyle } from "../../services/layout";
import { hasTextCardContent, isTextCardTemplate, layoutTextCard, normalizeTextCardTemplate, normalizeTextCardText, TEXT_CARD_TEMPLATES, textCardFontSize, textCardGraphemes, textCardHeight, textCardParagraphFontSize, textCardWidth, type TextCardTemplate } from "../../services/ugc-text-card-layout";

type Stage="input"|"generating"|"templates";
type Png={tempFilePath:string;size:number;text:string;template:TextCardTemplate;revision:number};
type Runtime={attached:boolean;open:boolean;finished:boolean;suspended:boolean;generation:number;renderRevision:number;contextKey:string;session:string;png:Png|null;pngs:Map<TextCardTemplate,Png>;canvases:Set<WechatMiniprogram.Canvas>};
const states=new WeakMap<object,Runtime>();
function state(component:object):Runtime {let value=states.get(component);if(!value){value={attached:false,open:false,finished:false,suspended:false,generation:0,renderRevision:0,contextKey:"",session:"",png:null,pngs:new Map(),canvases:new Set()};states.set(component,value);}return value;}
function session():string {try{return getApp<IAppOption>().globalData.sessionToken||"";}catch{return "";}}
function inputFacts(text:string){const normalized=normalizeTextCardText(text),count=textCardGraphemes(normalized).length;return {count,canProceed:hasTextCardContent(normalized)&&count<=300,error:count>300?"文字卡片最多300字，请精简后重试。":""};}
const emptyTemplates=()=>TEXT_CARD_TEMPLATES.map(template=>({...template,previewPath:""}));

Component({
  properties:{visible:{type:Boolean,value:false},initialText:{type:String,value:""},initialTemplate:{type:String,value:"plain"},contextKey:{type:String,value:""}},
  data:{stage:"input" as Stage,text:"",template:"plain" as TextCardTemplate,count:0,busy:false,error:"",renderFailed:false,canProceed:false,canExport:false,keyboardVisible:false,previewPath:"",previewPending:false,previewRevision:0,
    chromeStyle:"",previewWidth:280,previewHeight:373,templates:emptyTemplates()},
  observers:{"visible, contextKey"(){if(state(this).attached)this.syncVisibility();}},
  lifetimes:{attached(){state(this).attached=true;this.syncVisibility();},detached(){this.invalidate();state(this).attached=false;states.delete(this);}},
  pageLifetimes:{show(){const runtime=state(this);runtime.suspended=false;if(runtime.attached){this.syncVisibility();if(runtime.open&&this.data.stage==="templates")void this.generate();}},
    hide(){const runtime=state(this);runtime.suspended=true;this.stopRendering();this.setData({stage:this.data.stage==="generating"?"input":this.data.stage,busy:false,keyboardVisible:false,previewPath:"",previewPending:false,canExport:false,templates:emptyTemplates()});},
    resize(){if(state(this).open)this.resizePreview();}},
  methods:{
    holdOverlay(){},
    stopRendering(){const runtime=state(this);runtime.generation+=1;runtime.renderRevision+=1;runtime.png=null;runtime.pngs.clear();},
    invalidate(){const runtime=state(this);this.stopRendering();runtime.open=false;runtime.pngs.clear();for(const canvas of runtime.canvases){try{canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height);}catch{/* Detached native canvases need no further drawing. */}}runtime.canvases.clear();},
    current(generation:number){const runtime=state(this);return runtime.attached&&runtime.open&&!runtime.suspended&&this.data.visible&&runtime.generation===generation&&runtime.contextKey===this.data.contextKey&&runtime.session===session();},
    currentRender(generation:number,revision:number){return this.current(generation)&&state(this).renderRevision===revision&&this.data.stage!=="input";},
    resizePreview(){let width=390,height=844;try{const windowInfo=wx.getWindowInfo();width=windowInfo.windowWidth;height=windowInfo.windowHeight||height;}catch{/* Keep a compact native fallback. */}
      const previewWidth=Math.max(150,Math.min(width-44,(height-300)*3/4,390));this.setData({previewWidth,previewHeight:Math.round(previewWidth*4/3),chromeStyle:currentChromeStyle()});},
    syncVisibility(){const runtime=state(this);
      if(!this.data.visible){this.invalidate();this.setData({busy:false,keyboardVisible:false,previewPath:"",previewPending:false,canExport:false});return;}
      if(runtime.finished&&runtime.contextKey===this.data.contextKey)return;
      if(runtime.open&&runtime.contextKey===this.data.contextKey){if(runtime.session!==session()){this.invalidate();runtime.finished=true;this.setData({stage:"input",text:"",count:0,busy:false,previewPath:"",previewPending:false,canExport:false,canProceed:false,templates:emptyTemplates()});}return;}
      this.invalidate();runtime.finished=false;runtime.open=true;runtime.contextKey=this.data.contextKey;runtime.session=session();
      const text=this.data.initialText,template=normalizeTextCardTemplate(this.data.initialTemplate);
      this.setData({stage:"input",text,template,...inputFacts(text),busy:false,renderFailed:false,canExport:false,keyboardVisible:false,previewPath:"",previewPending:false,templates:emptyTemplates()});this.resizePreview();
    },
    notifyChange(){const runtime=state(this);if(this.current(runtime.generation))this.triggerEvent("change",{text:this.data.text,template:this.data.template,contextKey:runtime.contextKey});},
    editText(event:WechatMiniprogram.Input){if(this.data.stage!=="input"||this.data.busy||!this.current(state(this).generation))return;
      const text=event.detail.value;state(this).pngs.clear();this.setData({text,...inputFacts(text),canExport:false,renderFailed:false,previewPath:""});this.notifyChange();},
    selectTemplate(event:WechatMiniprogram.TouchEvent){const template=String(event.currentTarget.dataset.template||"");
      const runtime=state(this);if(this.data.stage!=="templates"||this.data.busy||!isTextCardTemplate(template)||template===this.data.template||!this.current(runtime.generation))return;
      const png=runtime.pngs.get(template);if(!png||png.text!==normalizeTextCardText(this.data.text)||png.revision!==runtime.renderRevision)return;
      runtime.png=png;this.setData({template,previewPath:png.tempFilePath,previewRevision:png.revision,canExport:true,error:"",renderFailed:false});this.notifyChange();},
    keyboardChange(event:{detail:{height:number}}){this.setData({keyboardVisible:event.detail.height>0});},
    async generate(){const runtime=state(this),generation=runtime.generation;if(this.data.stage==="generating"||this.data.busy||!this.data.canProceed||!this.current(generation))return;
      if(typeof wx.hideKeyboard==="function")wx.hideKeyboard();const revision=++runtime.renderRevision,text=normalizeTextCardText(this.data.text),selected=this.data.template;runtime.png=null;runtime.pngs.clear();
      this.setData({stage:"generating",busy:true,error:"",renderFailed:false,keyboardVisible:false,previewPath:"",previewPending:true,previewRevision:revision,canExport:false,templates:emptyTemplates()});
      const current=()=>this.currentRender(generation,revision)&&normalizeTextCardText(this.data.text)===text;
      try{const ordered=[selected,...TEXT_CARD_TEMPLATES.map(item=>item.value).filter(value=>value!==selected)];
        for(const template of ordered){const canvas=await this.renderCard(text,template,current);if(!canvas||!current())return;
          const file=await this.exportCard(canvas,current);if(!file||!current())return;runtime.pngs.set(template,{...file,text,template,revision});}
        if(!current())return;const png=runtime.pngs.get(selected)!;runtime.png=png;
        this.setData({stage:"templates",busy:false,previewPath:png.tempFilePath,previewPending:false,renderFailed:false,canExport:true,error:"",templates:TEXT_CARD_TEMPLATES.map(item=>({...item,previewPath:runtime.pngs.get(item.value)!.tempFilePath}))});
      }catch(error){if(current()){runtime.pngs.clear();this.setData({stage:"input",busy:false,previewPath:"",previewPending:false,renderFailed:true,canExport:false,error:(error as Error).message==="TEXT_CARD_LAYOUT_INVALID"?"这些文字超出一张卡片，请减少换行或精简内容。":"文字卡片未生成成功，请重试。"});}}
    },
    retryPreview(){if(!this.data.busy)void this.generate();},
    previewImageFailed(event:{currentTarget:{dataset:{path?:string;revision?:number}}}){const {path,revision}=event.currentTarget.dataset;
      if(path&&path===this.data.previewPath&&this.currentRender(state(this).generation,Number(revision))){state(this).png=null;this.setData({previewPath:"",previewPending:false,renderFailed:true,canExport:false,error:"文字卡片预览暂未显示，请重新生成。"});}},
    thumbnailFailed(event:{currentTarget:{dataset:{template?:string;path?:string}}}){const {template,path}=event.currentTarget.dataset;if(!this.current(state(this).generation))return;
      this.setData({templates:this.data.templates.map(item=>item.value===template&&item.previewPath===path?{...item,previewPath:""}:item)});},
    async renderCard(text:string,template:TextCardTemplate,current:()=>boolean):Promise<WechatMiniprogram.Canvas|null>{
      if(!current())return null;const canvas=await new Promise<WechatMiniprogram.Canvas>((resolve,reject)=>{this.createSelectorQuery().select("#communityTextCardCanvas").fields({node:true,size:true}).exec(result=>{const node=result[0]?.node as WechatMiniprogram.Canvas|undefined;if(node)resolve(node);else reject(new Error("CANVAS_NOT_READY"));});});
      if(!current())return null;let ratio=2;try{ratio=Math.max(1,Math.min(2,wx.getWindowInfo().pixelRatio));}catch{/* Keep a bounded crisp backing store. */}
      canvas.width=Math.round(textCardWidth*ratio);canvas.height=Math.round(textCardHeight*ratio);state(this).canvases.add(canvas);const context=canvas.getContext("2d");context.scale(ratio,ratio);
      context.font=`${textCardFontSize(text)}px sans-serif`;const fontSize=textCardParagraphFontSize(text,value=>context.measureText(value).width);context.font=`${fontSize}px sans-serif`;
      const layout=layoutTextCard(text,value=>context.measureText(value).width,{fontSize});if(!layout.valid)throw new Error("TEXT_CARD_LAYOUT_INVALID");
      const backgrounds={plain:"#69566e",minimal:"#faf9f7",care:"#f5eee5",memo:"#fbfaf6",lilac:"#ede3f1",border:"#ffffff"};
      if(template==="lilac"){const gradient=context.createLinearGradient(0,0,textCardWidth,textCardHeight);gradient.addColorStop(0,"#f3dff1");gradient.addColorStop(1,"#dce5f1");context.fillStyle=gradient;}else context.fillStyle=backgrounds[template];context.fillRect(0,0,textCardWidth,textCardHeight);
      context.textBaseline="top";context.textAlign="left";context.lineWidth=2;
      if(template==="plain"){context.fillStyle="rgba(255,255,255,.35)";context.font="130px serif";context.fillText("“",58,60);context.fillRect(textCardWidth-116,textCardHeight-100,52,7);}
      if(template==="memo"){context.strokeStyle="rgba(78,47,91,.1)";context.lineWidth=1;for(let y=148+layout.lineHeight;y<textCardHeight-96;y+=layout.lineHeight){context.beginPath();context.moveTo(64,y);context.lineTo(textCardWidth-64,y);context.stroke();}}
      if(template==="border"){context.strokeStyle="#8f749f";context.lineWidth=4;context.strokeRect(28,28,textCardWidth-56,textCardHeight-56);context.strokeStyle="#ded3e5";context.lineWidth=1;context.strokeRect(40,40,textCardWidth-80,textCardHeight-80);}
      if(template==="care"){context.strokeStyle="#b39b8a";context.lineWidth=3;context.beginPath();context.moveTo(64,90);context.lineTo(176,90);context.moveTo(textCardWidth-176,textCardHeight-92);context.lineTo(textCardWidth-64,textCardHeight-92);context.stroke();}
      const alignedLeft=template==="memo",top=alignedLeft?148:148+Math.max(0,(textCardHeight-148-96-layout.lines.length*layout.lineHeight)/2);
      context.fillStyle=template==="plain"?"#ffffff":"#352a3a";context.textAlign=alignedLeft?"left":"center";context.font=`${fontSize}px sans-serif`;
      layout.lines.forEach((line,index)=>context.fillText(line,alignedLeft?64:textCardWidth/2,top+index*layout.lineHeight));
      context.textAlign="left";context.fillStyle=template==="plain"?"rgba(255,255,255,.7)":"#75697a";context.font="18px sans-serif";context.fillText(template==="memo"?"CISME · 护理手记":"CISME",64,textCardHeight-58);return canvas;
    },
    async checkedSize(path:string){const size=await new Promise<number>((resolve,reject)=>wx.getFileSystemManager().getFileInfo({filePath:path,success:result=>resolve(result.size),fail:reject}));if(!Number.isSafeInteger(size)||size<1||size>10*1024*1024)throw new Error("TEXT_CARD_FILE_INVALID");return size;},
    async exportCard(canvas:WechatMiniprogram.Canvas,current:()=>boolean):Promise<{tempFilePath:string;size:number}|null>{
      await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("CANVAS_FRAME_TIMEOUT")),800);canvas.requestAnimationFrame(()=>{clearTimeout(timeout);resolve();});});if(!current())return null;
      const tempFilePath=await new Promise<string>((resolve,reject)=>wx.canvasToTempFilePath({canvas,destWidth:canvas.width,destHeight:canvas.height,fileType:"png",success:result=>resolve(result.tempFilePath),fail:reject},this));if(!current())return null;
      const size=await this.checkedSize(tempFilePath);if(!current())return null;if(!tempFilePath)throw new Error("TEXT_CARD_FILE_INVALID");return {tempFilePath,size};
    },
    async confirm(){if(this.data.stage==="input"){await this.generate();return;}const runtime=state(this),generation=runtime.generation,png=runtime.png;
      if(this.data.stage!=="templates"||this.data.busy||!this.data.canExport||!png||!this.currentRender(generation,png.revision)||png.template!==this.data.template||png.text!==normalizeTextCardText(this.data.text))return;
      this.setData({busy:true,error:""});try{const size=await this.checkedSize(png.tempFilePath);if(!this.currentRender(generation,png.revision)||runtime.png!==png)return;
        runtime.open=false;runtime.finished=true;this.setData({busy:false,canExport:false});this.triggerEvent("confirm",{tempFilePath:png.tempFilePath,size,text:png.text,template:png.template,contextKey:runtime.contextKey});
      }catch{if(this.currentRender(generation,png.revision)){runtime.png=null;this.setData({busy:false,canExport:false,previewPath:"",renderFailed:true,error:"文字卡片暂不可用，请重新生成。"});}}
      finally{if(this.current(generation))this.setData({busy:false});}
    },
    back(){const runtime=state(this);if(!this.current(runtime.generation))return;if(this.data.stage==="input"){this.cancel();return;}
      this.stopRendering();this.setData({stage:"input",...inputFacts(this.data.text),busy:false,canExport:false,previewPath:"",previewPending:false,renderFailed:false,keyboardVisible:false});},
    cancelGeneration(){if(this.data.stage==="generating")this.back();},
    cancel(){const runtime=state(this);if(!this.current(runtime.generation))return;const contextKey=runtime.contextKey;this.invalidate();runtime.finished=true;this.setData({busy:false,canExport:false,keyboardVisible:false,previewPath:"",previewPending:false});this.triggerEvent("cancel",{contextKey});},
    writeBody(){const runtime=state(this);if(this.data.stage!=="input"||!this.current(runtime.generation))return;const contextKey=runtime.contextKey;this.invalidate();runtime.finished=true;this.setData({busy:false,canExport:false,keyboardVisible:false,previewPath:"",previewPending:false});this.triggerEvent("cancel",{contextKey,mode:"body"});}
  }
});
