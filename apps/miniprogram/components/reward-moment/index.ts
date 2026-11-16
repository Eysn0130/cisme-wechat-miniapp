import {shouldReduceMotion} from '../../services/layout';
import {commerceContextRevision} from '../../services/commerce-command-store';
type Runtime={visible:boolean;alive:boolean;timers:Array<ReturnType<typeof setTimeout>>;token:string;context:number;owner:string;reference:string;mode:string;done:boolean};
const runtime=new WeakMap<object,Runtime>();
let materialWarmed=false;
function warm(){if(materialWarmed||typeof wx.getImageInfo!=='function')return;materialWarmed=true;for(const src of ['/assets/cisme/travel-ticket-surface-v1.webp','/assets/cisme/travel-ticket-products-v1.webp'])wx.getImageInfo({src,fail:()=>{materialWarmed=false;}});}
function stop(c:any){const r=runtime.get(c);if(!r)return;for(const timer of r.timers)clearTimeout(timer);r.timers=[];if(c.data.showing)c.setData({showing:false});}
function active(c:any,r:Runtime|undefined):r is Runtime{return Boolean(r&&r.alive&&r.visible&&!r.done&&c.properties.open&&r.owner===c.properties.owner&&r.reference===c.properties.reference&&r.mode===c.properties.mode&&r.token===getApp<IAppOption>().globalData.sessionToken&&r.context===commerceContextRevision());}
Component({
 properties:{open:{type:Boolean,value:false},owner:{type:String,value:''},reference:{type:String,value:''},mode:{type:String,value:'offer'},image:{type:String,value:''},name:{type:String,value:''},bundle:{type:String,value:''}},
 data:{showing:false,phase:'revealing',reducedMotion:shouldReduceMotion()},
 observers:{'open,owner,reference,mode':function(){this.begin();}},
 lifetimes:{attached(){runtime.set(this,{visible:true,alive:true,timers:[],token:'',context:0,owner:'',reference:'',mode:'',done:false});this.begin();},detached(){const r=runtime.get(this);if(r)r.alive=false;stop(this);runtime.delete(this);}},
 pageLifetimes:{hide(){const r=runtime.get(this);if(r)r.visible=false;stop(this);},show(){const r=runtime.get(this);if(r)r.visible=true;this.begin();}},
 methods:{
  warm,
  begin(){const r=runtime.get(this);if(!r)return;stop(this);if(!this.properties.open){r.done=false;return;}
   if(!r.alive||!r.visible||!this.properties.open||!/^[a-f0-9-]{36}$/i.test(this.properties.owner)||!/^[a-f0-9-]{36}$/i.test(this.properties.reference))return;
   const token=getApp<IAppOption>().globalData.sessionToken;if(!token)return;
   if(r.reference!==this.properties.reference||r.owner!==this.properties.owner||r.mode!==this.properties.mode||r.token!==token||r.context!==commerceContextRevision())r.done=false;
   r.owner=this.properties.owner;r.reference=this.properties.reference;r.mode=this.properties.mode;r.token=token;r.context=commerceContextRevision();if(r.done)return;warm();
   const reducedMotion=shouldReduceMotion();this.setData({showing:true,phase:reducedMotion?'settled':'revealing',reducedMotion});
   const later=(ms:number,fn:()=>void)=>r.timers.push(setTimeout(()=>{if(active(this,r))fn();},ms));
   if(!reducedMotion)later(720,()=>{this.setData({phase:'settled'});if(typeof wx.vibrateShort==='function')wx.vibrateShort({type:'light',fail:()=>{}});});
   if(this.properties.mode==='redeemed')later(2000,()=>this.finish());
  },
  stop(){},
  choose(){const r=runtime.get(this);if(!active(this,r)||r.mode!=='offer')return;r.done=true;stop(this);this.triggerEvent('choose',{owner:r.owner,reference:r.reference});},
  defer(){const r=runtime.get(this);if(!active(this,r)||r.mode!=='offer')return;r.done=true;stop(this);this.triggerEvent('defer',{owner:r.owner,reference:r.reference});},
  finish(){const r=runtime.get(this);if(!active(this,r)||r.mode!=='redeemed')return;r.done=true;stop(this);this.triggerEvent('finished',{owner:r.owner,reference:r.reference});}
 }
});
