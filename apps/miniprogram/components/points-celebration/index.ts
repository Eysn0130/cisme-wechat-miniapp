import {pageRead,cancelPageReads} from '../../services/page-requests';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {shouldReduceMotion} from '../../services/layout';
import {parsePointsSnapshot} from '../../services/points';
import {readCareUsageHistory} from '../../services/care-usage';
import {pendingCredit,consumeCredit,questionnaireCredit,careCredit,isCreditOwner} from '../../services/points-feedback';

type Runtime={alive:boolean;visible:boolean;attempt:number;promise:Promise<void>|null;timer:ReturnType<typeof setTimeout>|null;wake:(()=>void)|null;owner:string;enabled:boolean;receiptVersion:number};
const runtimes=new WeakMap<object,Runtime>();
let materialWarmed=false;
function warmMaterial(){if(materialWarmed||typeof wx.getImageInfo!=='function')return;materialWarmed=true;wx.getImageInfo({src:'/assets/cisme/onboarding-pearl-seal-v1.png',fail:()=>{materialWarmed=false;}});}
function stop(component:any){const r=runtimes.get(component);if(!r)return;r.attempt++;if(r.timer!==null)clearTimeout(r.timer);r.timer=null;r.wake?.();r.wake=null;cancelPageReads(component);if(component.data.showing)component.setData({showing:false});}
function pause(r:Runtime,ms:number){return new Promise<void>(resolve=>{r.wake=resolve;r.timer=setTimeout(()=>{r.timer=null;r.wake=null;resolve();},ms);});}
Component({
 properties:{owner:{type:String,value:''},enabled:{type:Boolean,value:true},receiptVersion:{type:Number,value:0}},
 data:{showing:false,amount:0,displayAmount:0,digits:1,phase:'spinning',reducedMotion:shouldReduceMotion(),glints:[0,1,2,3]},
 observers:{'owner,enabled,receiptVersion':function(){const r=runtimes.get(this);if(!r)return;
  const changed=r.owner!==this.properties.owner||r.enabled!==this.properties.enabled;
  if(!changed&&r.receiptVersion===this.properties.receiptVersion)return;
  r.owner=this.properties.owner;r.enabled=this.properties.enabled;r.receiptVersion=this.properties.receiptVersion;if(changed)stop(this);this.resume();}},
 lifetimes:{attached(){warmMaterial();runtimes.set(this,{alive:true,visible:true,attempt:0,promise:null,timer:null,wake:null,owner:this.properties.owner,enabled:this.properties.enabled,receiptVersion:this.properties.receiptVersion});void this.present();},detached(){const r=runtimes.get(this);if(r)r.alive=false;stop(this);runtimes.delete(this);}},
 pageLifetimes:{hide(){const r=runtimes.get(this);if(r)r.visible=false;stop(this);},show(){const r=runtimes.get(this);if(r)r.visible=true;this.resume();}},
 methods:{
  resume(){const r=runtimes.get(this);if(!r)return;if(r.promise)void r.promise.then(()=>{if(r.alive&&r.visible)void this.present();});else void this.present();},
  async present():Promise<void>{
   const r=runtimes.get(this);if(!r||!r.alive||!r.visible||!this.properties.enabled)return;if(r.promise)return r.promise;
   const owner=this.properties.owner;if(!isCreditOwner(owner)||!pendingCredit(owner))return;
   const token=getApp<IAppOption>().globalData.sessionToken;if(!token)return;
   const context=commerceContextRevision(),attempt=++r.attempt;
   const current=()=>r.alive&&r.visible&&r.attempt===attempt&&this.properties.enabled&&this.properties.owner===owner&&isCreditOwner(owner)&&token===getApp<IAppOption>().globalData.sessionToken&&context===commerceContextRevision();
   r.promise=(async()=>{
    for(let notice=0;notice<2;notice++){
     const intent=pendingCredit(owner);if(!intent||!current())return;
     let credit:{ids:string[];amount:number}|null=null;
     for(const delay of[0,250,500]){
      if(delay)await pause(r,delay);if(!current())return;
      try{
       if(intent.kind==='questionnaire'){
        const point=questionnaireCredit(parsePointsSnapshot(await pageRead(this,{path:'/v1/me/points?limit=20&source=earn',cacheTags:['points'],budgetMs:1000})));
        if(point)credit={ids:[point.id],amount:point.amount};
       }else{
        const history=await readCareUsageHistory(this,null,intent.day,1000),receipt=history.items.find(row=>row.careDay===intent.day)?.rewards;
        if(receipt){credit=careCredit(owner,intent,receipt);if(credit&&current())this.triggerEvent('carecredit',{owner,receipt});}
       }
      }catch{return;}
      if(!current())return;if(credit)break;
     }
     if(!credit||!consumeCredit(owner,intent,credit.ids))return;if(credit.amount<=0)continue;
     const reducedMotion=shouldReduceMotion();
     this.setData({amount:credit.amount,digits:String(credit.amount).length,displayAmount:reducedMotion?credit.amount:0,phase:reducedMotion?'settled':'spinning',showing:true,reducedMotion});
     if(reducedMotion){await pause(r,2000);}
     else{
      await pause(r,620);if(!current())return;this.setData({phase:'checked'});
      if(typeof wx.vibrateShort==='function')wx.vibrateShort({type:'light',fail:()=>{}});
      await pause(r,100);if(!current())return;
      const steps=Math.min(12,credit.amount),duration=420;
      for(let step=1;step<=steps;step++){
       await pause(r,duration/steps);if(!current())return;
       const value=step===steps?credit.amount:Math.round(credit.amount*(1-Math.pow(1-step/steps,3)));
       if(value!==this.data.displayAmount)this.setData({displayAmount:value});
      }
      if(!current())return;this.setData({phase:'settled',displayAmount:credit.amount});
      await pause(r,660);if(!current())return;this.setData({phase:'leaving'});await pause(r,200);
     }
     if(current())this.setData({showing:false});else return;
    }
   })().finally(()=>{r.promise=null;});return r.promise;
  }
 }
});
