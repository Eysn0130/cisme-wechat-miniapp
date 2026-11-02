import { commerceContextRevision } from "../../services/commerce-command-store";
import { currentChromeStyle } from "../../services/layout";
import { editUgcLocalImage, ugcImageEditCapabilities } from "../../services/ugc-image-edit";
import { applyPhotoEffects,normalizePhotoEffectOptions,validatePhotoOverlayOptions,type UgcPhotoFilter,type UgcPhotoOverlayOptions } from "../../services/ugc-photo-effects";
import { textCardGraphemes } from "../../services/ugc-text-card-layout";

type LocalFile={path:string;size:number};
type NativeOperation={contextKey:string;generation:number;ended:boolean};
type EffectConfig={filter:UgcPhotoFilter;brightness:number;contrast:number;saturation:number;overlay:UgcPhotoOverlayOptions};
type AppliedEffect={sourcePath:string;config:EffectConfig};
type Runtime={attached:boolean;open:boolean;finished:boolean;suspended:boolean;generation:number;contextKey:string;session:string;revision:number;route:string;baseline:string;native:NativeOperation|null;resume:(()=>void)|null;effects:Map<string,AppliedEffect>;canvas:WechatMiniprogram.Canvas|null;chromeToken:object|null};
const runtimes=new WeakMap<object,Runtime>();
let chromeOwner:object|null=null;
function state(component:object):Runtime{let value=runtimes.get(component);if(!value){value={attached:false,open:false,finished:false,suspended:false,generation:0,contextKey:"",session:"",revision:0,route:"",baseline:"",native:null,resume:null,effects:new Map(),canvas:null,chromeToken:null};runtimes.set(component,value);}return value;}
function session():string{try{return getApp<IAppOption>().globalData.sessionToken||"";}catch{return "";}}
function route():string{try{const pages=getCurrentPages();return pages[pages.length-1]?.route||"";}catch{return "";}}
function localPath(value:unknown):value is string{return typeof value==="string"&&value.length>0&&value.length<=8192&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value)&&!value.startsWith("//")&&(/^(?:\/|wxfile:\/\/|file:\/\/|https?:\/\/(?:tmp|usr)\/)/i.test(value));}
function copyFiles(files:LocalFile[]):LocalFile[]{return files.map(file=>({path:file.path,size:file.size}));}
async function checkedFile(path:string):Promise<LocalFile>{
  if(!localPath(path))throw new Error("请选择有效的本地图片。");
  const fs=wx.getFileSystemManager();
  const size=await new Promise<number>((resolve,reject)=>fs.getFileInfo({filePath:path,success:result=>resolve(result.size),fail:reject}));
  if(!Number.isSafeInteger(size)||size<1||size>10*1024*1024)throw new Error("单张图片需小于10MB，请重新选择。");
  const bytes=await new Promise<Uint8Array>((resolve,reject)=>fs.readFile({filePath:path,position:0,length:12,success:result=>resolve(new Uint8Array(result.data as ArrayBuffer)),fail:reject}));
  const jpeg=bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
  const png=bytes.length>=8&&bytes.slice(0,8).every((value,index)=>value===[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a][index]);
  const webp=String.fromCharCode(...bytes.slice(0,4))==="RIFF"&&String.fromCharCode(...bytes.slice(8,12))==="WEBP";
  if(!jpeg&&!png&&!webp)throw new Error("仅支持JPG、PNG或WEBP图片。");
  return {path,size};
}
function message(error:unknown):string{return error instanceof Error?error.message:"图片暂时无法读取，请重新选择。";}
function defaultEffect():EffectConfig{return {...normalizePhotoEffectOptions(),overlay:validatePhotoOverlayOptions().options};}
function canvasSupported():boolean{try{
  if(typeof wx.canvasToTempFilePath!=="function"||wx.canIUse("canvas.type")!==true)return false;
  const sdk=typeof wx.getAppBaseInfo==="function"?wx.getAppBaseInfo().SDKVersion:"";
  if(!sdk)return true;
  const parts=sdk.split(".");if(parts.length<2||parts.some(part=>!/^\d+$/.test(part)))return false;
  return Number(parts[0])>2||(Number(parts[0])===2&&Number(parts[1])>=9);
}catch{return false;}}
function drawOverlay(context:WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D,width:number,height:number,overlay:UgcPhotoOverlayOptions):void{
  if(!overlay.text&&!overlay.sticker)return;
  const fontSize=Math.max(1,Math.round(Math.min(width,height)*.062));context.font=`600 ${fontSize}px sans-serif`;context.textAlign="center";context.textBaseline="middle";
  context.fillStyle=overlay.color;context.shadowColor="rgba(0,0,0,.25)";context.shadowBlur=fontSize*.15;
  const lines:string[]=[];let line="";for(const glyph of textCardGraphemes(overlay.text)){if(line&&context.measureText(line+glyph).width>width*.84){lines.push(line);line=glyph;}else line+=glyph;}if(line)lines.push(line);
  const lineHeight=fontSize*1.3,stickerHeight=overlay.sticker?fontSize*2.2:0,totalHeight=lines.length*lineHeight+stickerHeight;
  let y=overlay.position==="top"?height*.12+totalHeight/2:overlay.position==="bottom"?height*.88-totalHeight/2:height/2;
  y=Math.max(totalHeight/2,Math.min(height-totalHeight/2,y));let cursor=y-totalHeight/2+lineHeight/2;
  for(const text of lines){context.fillText(text,width/2,cursor);cursor+=lineHeight;}
  if(overlay.sticker){context.font=`${fontSize*1.8}px sans-serif`;context.fillText(overlay.sticker,width/2,y+totalHeight/2-stickerHeight/2);}
}

Component({
  properties:{visible:{type:Boolean,value:false},initialFiles:{type:Array,value:[] as LocalFile[]},contextKey:{type:String,value:""},additional:{type:Boolean,value:false}},
  data:{files:[] as LocalFile[],selected:0,busy:false,error:"",canEdit:false,canCrop:false,canCanvas:false,chromeStyle:"",generation:0,
    activeTool:"",filter:"original" as UgcPhotoFilter,brightness:0,contrast:0,saturation:0,overlayText:"",overlayPosition:"top",overlayColor:"#ffffff",sticker:"",effectDirty:false,
    filters:[{value:"original",label:"原图"},{value:"warm",label:"暖调"},{value:"mono",label:"黑白"},{value:"vivid",label:"鲜明"}],positions:[{value:"top",label:"上方"},{value:"center",label:"居中"},{value:"bottom",label:"下方"}],colors:["#ffffff","#352a3a","#6b417b"],stickers:["✨","💜","🌼"]},
  observers:{"visible, contextKey"(){if(state(this).attached)this.syncVisibility();}},
  lifetimes:{attached(){state(this).attached=true;this.syncVisibility();},detached(){this.invalidate();state(this).attached=false;runtimes.delete(this);}},
  pageLifetimes:{
    hide(){const runtime=state(this);runtime.suspended=true;if(!runtime.native){this.releaseNavigationChrome();runtime.generation+=1;this.setData({busy:false,generation:runtime.generation});}},
    show(){const runtime=state(this);runtime.suspended=false;
      if(runtime.open&&(runtime.session!==session()||runtime.revision!==commerceContextRevision()||(runtime.route&&runtime.route!==route()))){this.invalidate();runtime.finished=true;this.setData({files:[],busy:false,error:""});return;}
      runtime.resume?.();runtime.resume=null;if(runtime.attached)this.syncVisibility();}
  },
  methods:{
    holdOverlay(){},
    acquireNavigationChrome(){const runtime=state(this);if(typeof wx.setNavigationBarColor!=="function"||!this.current(runtime.generation))return;const token={};runtime.chromeToken=token;chromeOwner=token;
      try{wx.setNavigationBarColor({frontColor:"#ffffff",backgroundColor:"#101010"});}catch{if(chromeOwner===token)chromeOwner=null;runtime.chromeToken=null;}},
    releaseNavigationChrome(){const runtime=state(this),token=runtime.chromeToken;runtime.chromeToken=null;if(!token||chromeOwner!==token)return;chromeOwner=null;
      if(typeof wx.setNavigationBarColor==="function"){try{wx.setNavigationBarColor({frontColor:"#000000",backgroundColor:"#ffffff"});}catch{/* Unsupported clients retain their own navigation chrome. */}}},
    endNative(operation:NativeOperation){if(operation.ended)return;operation.ended=true;const runtime=state(this);if(runtime.native===operation)runtime.native=null;this.triggerEvent("nativeend",{contextKey:operation.contextKey});},
    invalidate(){const runtime=state(this);this.releaseNavigationChrome();runtime.generation+=1;runtime.open=false;runtime.resume?.();runtime.resume=null;if(runtime.native)this.endNative(runtime.native);runtime.effects.clear();runtime.canvas=null;},
    current(generation:number,allowHidden=false):boolean{const runtime=state(this);return runtime.attached&&runtime.open&&this.data.visible&&runtime.generation===generation&&runtime.contextKey===this.data.contextKey&&runtime.session===session()&&runtime.revision===commerceContextRevision()&&(!runtime.route||runtime.route===route())&&(allowHidden||!runtime.suspended);},
    async waitForShow(generation:number):Promise<boolean>{const runtime=state(this);if(!this.current(generation,true))return false;if(runtime.suspended)await new Promise<void>(resolve=>{runtime.resume=resolve;});return this.current(generation);},
    syncVisibility(){const runtime=state(this);
      if(!this.data.visible){this.invalidate();this.setData({busy:false});return;}
      if(runtime.finished&&runtime.contextKey===this.data.contextKey)return;
      if(runtime.open&&runtime.contextKey===this.data.contextKey){const capability=ugcImageEditCapabilities();this.setData({canEdit:capability.edit,canCrop:capability.crop,canCanvas:canvasSupported()});this.acquireNavigationChrome();return;}
      this.invalidate();runtime.finished=false;runtime.open=true;runtime.contextKey=this.data.contextKey;runtime.session=session();runtime.revision=commerceContextRevision();runtime.route=route();
      const initial=this.data.initialFiles as LocalFile[];
      const valid=Array.isArray(initial)&&initial.length<=9&&initial.every(file=>file&&localPath(file.path)&&Number.isSafeInteger(file.size)&&file.size>0&&file.size<=10*1024*1024);
      const files=valid?copyFiles(initial):[];runtime.baseline=JSON.stringify(files);const capabilities=ugcImageEditCapabilities();
      this.setData({files,selected:0,busy:false,error:valid?"":"图片选择已失效，请返回重新选择。",canEdit:capabilities.edit,canCrop:capabilities.crop,canCanvas:canvasSupported(),activeTool:"",chromeStyle:currentChromeStyle(),generation:runtime.generation});this.loadEffects();this.acquireNavigationChrome();
    },
    notifyChange(){const runtime=state(this);if(this.current(runtime.generation))this.triggerEvent("change",{files:copyFiles(this.data.files),contextKey:runtime.contextKey});},
    imagePreviewFailed(event:{currentTarget:{dataset:{path?:string;generation?:number}}}){const {path,generation}=event.currentTarget.dataset;if(this.current(Number(generation))&&path===this.data.files[this.data.selected]?.path)this.setData({error:"图片暂时无法显示，请返回重新选择或重试编辑。"});},
    selectImage(event:WechatMiniprogram.TouchEvent){const index=Number(event.currentTarget.dataset.index);if(this.data.busy||this.data.effectDirty||!this.current(state(this).generation)||!Number.isInteger(index)||!this.data.files[index])return;this.setData({selected:index,error:"",activeTool:""});this.loadEffects();},
    setCover(){if(this.data.busy||this.data.effectDirty||!this.current(state(this).generation)||this.data.selected<1||!this.data.files[this.data.selected])return;const files=copyFiles(this.data.files),cover=files.splice(this.data.selected,1)[0];if(!cover)return;files.unshift(cover);this.setData({files,selected:0,error:""});this.notifyChange();},
    removeImage(){if(this.data.busy||this.data.effectDirty||!this.current(state(this).generation)||!this.data.files[this.data.selected])return;const files=copyFiles(this.data.files),removed=files.splice(this.data.selected,1)[0];if(removed)state(this).effects.delete(removed.path);this.setData({files,selected:Math.max(0,Math.min(this.data.selected,files.length-1)),error:"",activeTool:""});this.loadEffects();this.notifyChange();},
    editImage(){return this.runNativeEdit("edit");},
    cropImage(){return this.runNativeEdit("crop");},
    async runNativeEdit(mode:"edit"|"crop"){
      const runtime=state(this),generation=runtime.generation,index=this.data.selected,original=this.data.files[index];
      if(this.data.busy||this.data.effectDirty||!original||!this.current(generation))return;
      const capability=ugcImageEditCapabilities();if(!capability[mode]){this.setData({canEdit:capability.edit,canCrop:capability.crop,error:"当前微信版本暂不支持此图片编辑方式。"});return;}
      const operation:NativeOperation={contextKey:runtime.contextKey,generation,ended:false};runtime.native=operation;this.setData({busy:true,error:""});this.triggerEvent("nativebegin",{contextKey:operation.contextKey});
      try{
        const result=await editUgcLocalImage(original.path,mode==="crop"?{mode:"crop",cropScale:"1:1"}:{mode:"edit"});
        if(!await this.waitForShow(generation))return;
        if(result.status==="cancel")return;
        if(result.status!=="success"){this.setData({error:result.message});return;}
        const edited=await checkedFile(result.tempFilePath);if(!await this.waitForShow(generation)||this.data.files[index]?.path!==original.path)return;
        const files=copyFiles(this.data.files);files[index]=edited;runtime.effects.delete(original.path);this.setData({files,error:""});this.loadEffects();this.notifyChange();
      }catch(error){if(await this.waitForShow(generation))this.setData({error:message(error)});}
      finally{if(this.current(generation,true))await this.waitForShow(generation);this.endNative(operation);if(this.current(generation))this.setData({busy:false});}
    },
    effectConfig():EffectConfig{return {...normalizePhotoEffectOptions(this.data),overlay:validatePhotoOverlayOptions({text:this.data.overlayText,position:this.data.overlayPosition,color:this.data.overlayColor,sticker:this.data.sticker}).options};},
    loadEffects(){const file=this.data.files[this.data.selected],config=(file?state(this).effects.get(file.path)?.config:null)||defaultEffect();
      this.setData({filter:config.filter,brightness:config.brightness,contrast:config.contrast,saturation:config.saturation,overlayText:config.overlay.text,overlayPosition:config.overlay.position,overlayColor:config.overlay.color,sticker:config.overlay.sticker,effectDirty:false});},
    updateEffects(patch:Record<string,unknown>){if(this.data.busy||!this.data.canCanvas||!this.data.files.length||!this.current(state(this).generation))return;this.setData(patch);const file=this.data.files[this.data.selected],applied=(file?state(this).effects.get(file.path)?.config:null)||defaultEffect();
      this.setData({effectDirty:JSON.stringify(this.effectConfig())!==JSON.stringify(applied),error:""});},
    toggleTool(event:WechatMiniprogram.TouchEvent){const tool=String(event.currentTarget.dataset.tool||"");if(this.data.busy||!this.data.canCanvas||!this.data.files.length||!this.current(state(this).generation)||!["filters","adjust","text","sticker"].includes(tool))return;this.setData({activeTool:this.data.activeTool===tool?"":tool});},
    changeFilter(event:WechatMiniprogram.TouchEvent){const filter=String(event.currentTarget.dataset.value||"");if(["original","warm","mono","vivid"].includes(filter))this.updateEffects({filter});},
    changeAdjustment(event:{currentTarget:{dataset:{field?:string}};detail:{value:number}}){const field=event.currentTarget.dataset.field;if(field&&["brightness","contrast","saturation"].includes(field)&&Number.isFinite(event.detail.value))this.updateEffects({[field]:Math.max(-100,Math.min(100,event.detail.value))});},
    changeOverlayText(event:WechatMiniprogram.Input){this.updateEffects({overlayText:event.detail.value});},
    changeOverlayPosition(event:WechatMiniprogram.TouchEvent){const position=String(event.currentTarget.dataset.value||"");if(["top","center","bottom"].includes(position))this.updateEffects({overlayPosition:position});},
    changeOverlayColor(event:WechatMiniprogram.TouchEvent){const color=String(event.currentTarget.dataset.value||"");if(["#ffffff","#352a3a","#6b417b"].includes(color))this.updateEffects({overlayColor:color});},
    changeSticker(event:WechatMiniprogram.TouchEvent){const sticker=String(event.currentTarget.dataset.value||"");if(["","✨","💜","🌼"].includes(sticker))this.updateEffects({sticker});},
    async applyEffects(){
      const runtime=state(this),generation=runtime.generation,index=this.data.selected,original=this.data.files[index];
      if(this.data.busy||!this.data.effectDirty||!this.data.canCanvas||!original||!this.current(generation))return;
      const overlay=validatePhotoOverlayOptions({text:this.data.overlayText,position:this.data.overlayPosition,color:this.data.overlayColor,sticker:this.data.sticker});
      if(!overlay.valid){this.setData({error:overlay.error});return;}
      const config:EffectConfig={...normalizePhotoEffectOptions(this.data),overlay:overlay.options},sourcePath=runtime.effects.get(original.path)?.sourcePath||original.path;
      if(typeof wx.hideKeyboard==="function")wx.hideKeyboard();
      this.setData({busy:true,error:""});
      try{
        await checkedFile(sourcePath);if(!this.current(generation))return;
        const info=await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve,reject)=>wx.getImageInfo({src:sourcePath,success:resolve,fail:reject}));
        if(!this.current(generation))return;
        if(!Number.isSafeInteger(info.width)||!Number.isSafeInteger(info.height)||info.width<1||info.height<1)throw new Error("图片尺寸无法读取，请重试。");
        const ratio=Math.min(1,1440/Math.max(info.width,info.height)),width=Math.max(1,Math.round(info.width*ratio)),height=Math.max(1,Math.round(info.height*ratio));
        const canvas=await new Promise<WechatMiniprogram.Canvas>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("图片画布暂未就绪，请重试。")),1200);this.createSelectorQuery().select("#communityImageEffectCanvas").fields({node:true,size:true}).exec(result=>{clearTimeout(timeout);const node=result[0]?.node as WechatMiniprogram.Canvas|undefined;if(node)resolve(node);else reject(new Error("图片画布暂未就绪，请重试。"));});});
        if(!this.current(generation))return;canvas.width=width;canvas.height=height;runtime.canvas=canvas;
        const image=canvas.createImage();await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("图片暂时无法加载，请重试。")),5000);image.onload=()=>{clearTimeout(timeout);resolve();};image.onerror=()=>{clearTimeout(timeout);reject(new Error("图片暂时无法加载，请重试。"));};image.src=sourcePath;});
        if(!this.current(generation))return;
        const context=canvas.getContext("2d");context.clearRect(0,0,width,height);context.fillStyle="#ffffff";context.fillRect(0,0,width,height);context.drawImage(image,0,0,width,height);
        const pixels=context.getImageData(0,0,width,height);pixels.data.set(applyPhotoEffects(pixels.data,config));context.putImageData(pixels,0,0);drawOverlay(context,width,height,overlay.options);
        await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("图片渲染未完成，请重试。")),800);canvas.requestAnimationFrame(()=>{clearTimeout(timeout);resolve();});});
        if(!this.current(generation))return;
        const path=await new Promise<string>((resolve,reject)=>wx.canvasToTempFilePath({canvas,destWidth:width,destHeight:height,fileType:"jpg",quality:.9,success:result=>resolve(result.tempFilePath),fail:reject},this));
        if(!this.current(generation))return;if(path===sourcePath||path===original.path)throw new Error("未生成新的图片，原图仍保留，请重试。");
        const edited=await checkedFile(path);if(!this.current(generation)||this.data.files[index]?.path!==original.path)return;
        runtime.effects.delete(original.path);runtime.effects.set(path,{sourcePath,config});const files=copyFiles(this.data.files);files[index]=edited;
        this.setData({files,effectDirty:false,error:""});this.notifyChange();
      }catch(error){if(this.current(generation))this.setData({error:error instanceof Error&&/[\u4e00-\u9fff]/.test(error.message)?error.message:"图片效果未生成成功，原图仍保留，请重试。"});}
      finally{if(this.current(generation))this.setData({busy:false});}
    },
    async confirm(){const runtime=state(this),generation=runtime.generation,tool=this.data.activeTool,selected=this.data.selected;
      if(this.data.busy||!this.data.files.length||this.data.files.length>9||!this.current(generation))return;
      this.setData({error:""});
      if(this.data.effectDirty)await this.applyEffects();
      if(!this.current(generation)||this.data.busy||this.data.effectDirty||this.data.error||this.data.activeTool!==tool||this.data.selected!==selected)return;
      if(tool){this.setData({activeTool:""});return;}
      const snapshot=copyFiles(this.data.files);this.setData({busy:true,error:""});
      try{const files:LocalFile[]=[];for(const file of snapshot){files.push(await checkedFile(file.path));if(!this.current(generation))return;}
        this.releaseNavigationChrome();runtime.open=false;runtime.finished=true;this.setData({files,busy:false});this.triggerEvent("confirm",{files:copyFiles(files),contextKey:runtime.contextKey});
      }catch(error){if(this.current(generation))this.setData({busy:false,error:message(error)});}finally{if(this.current(generation))this.setData({busy:false});}
    },
    async cancel(){const runtime=state(this),generation=runtime.generation;if(this.data.busy||!this.current(generation))return;
      if(this.data.activeTool){this.loadEffects();this.setData({activeTool:"",error:""});if(typeof wx.hideKeyboard==="function")wx.hideKeyboard();return;}
      if(this.data.effectDirty||JSON.stringify(this.data.files)!==runtime.baseline){this.setData({busy:true});let confirmed=false;try{confirmed=await new Promise<boolean>(resolve=>wx.showModal({title:"放弃图片修改？",content:"本次调整还未用于发布，放弃后将返回上一页。",confirmText:"放弃修改",cancelText:"继续编辑",success:result=>resolve(result.confirm),fail:()=>resolve(false)}));}finally{if(this.current(generation))this.setData({busy:false});}if(!confirmed||!this.current(generation))return;}
      const contextKey=runtime.contextKey;this.invalidate();runtime.finished=true;this.setData({busy:false});this.triggerEvent("cancel",{contextKey});
    }
  }
});
