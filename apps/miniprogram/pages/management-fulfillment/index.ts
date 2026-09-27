import { authorityProjection, hasCapability } from "../../services/authority";
import { downloadPrivateMedia, request } from "../../services/api";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { clientOperationKey } from "../../services/orders";
import { cancelPageReads, pageRead } from "../../services/page-requests";
import { currentChromeStyle } from "../../services/layout";
const states=["awaiting_dispatch","shipped","delivered","exception","all"];
const labels:Record<string,string>={awaiting_dispatch:"待发货",shipped:"已发货",delivered:"快递已签收",exception:"物流异常"};
type Row={id:string;orderNumber:string;items:string;logisticsState:string;carrierName:string|null;receiptConfirmedAt:string|null;stateLabel?:string};
type BatchResult={orderId:string;status:"accepted"|"rejected";code?:string};
Page({
 visible:false,epoch:0,lastToken:"",lastRevision:-1,timer:null as ReturnType<typeof setInterval>|null,
 download:null as ReturnType<typeof downloadPrivateMedia>|null,batchKey:"",frozenRows:"",
 data:{chromeStyle:currentChromeStyle(),states:["待发货","已发货","快递已签收","物流异常","全部已支付"],stateIndex:0,orderNumber:"",items:[] as Row[],nextCursor:null as string|null,loadedFilter:"",rows:"",confirmed:false,results:[] as BatchResult[],loading:true,busy:false,coreReady:false,error:"",notice:"",batchLocked:false,batchPending:false},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 onShow(){this.visible=true;return this.load();},
 onHide(){this.visible=false;this.epoch++;cancelPageReads(this);this.stopPolling();this.releaseDownload();this.batchKey="";this.frozenRows="";this.setData({items:[],rows:"",orderNumber:"",confirmed:false,results:[],nextCursor:null,coreReady:false,busy:false,batchLocked:false});},
 onUnload(){this.onHide();},
 current(epoch?:number,token?:string){epoch ??= this.epoch;token ??= this.lastToken;return this.visible&&epoch===this.epoch&&token===this.lastToken&&token===getApp<IAppOption>().globalData.sessionToken&&this.lastRevision===commerceContextRevision();},
 canAct(){return this.current()&&this.data.coreReady&&!this.data.busy&&!this.data.loading;},
 releaseDownload(){this.download?.abort();this.download=null;},
 stopPolling(){if(this.timer!==null)clearInterval(this.timer);this.timer=null;},
 poll(){this.stopPolling();if(this.visible&&this.data.coreReady)this.timer=setInterval(()=>void this.recheck(),6000);},
 invalidate(message="权限或身份已变化，请重新核验。"){this.stopPolling();this.releaseDownload();this.batchKey="";this.frozenRows="";this.setData({items:[],rows:"",results:[],orderNumber:"",nextCursor:null,confirmed:false,batchLocked:false,coreReady:false,error:message});},
 async recheck(){if(!this.visible||this.data.busy||this.data.loading)return;if(!this.current()){this.invalidate();return;}if(!this.data.coreReady)return;const epoch=this.epoch,token=this.lastToken;try{const a=await authorityProjection(this);if(!this.current(epoch,token)||a.version!==1||!a.managementAvailable||!hasCapability(a,"commerce.fulfillment.manage")){if(this.visible&&epoch===this.epoch)this.invalidate();}}catch{if(this.visible&&epoch===this.epoch)this.invalidate();}},
 filter(){return `state=${states[this.data.stateIndex]||states[0]}&orderNumber=${encodeURIComponent(this.data.orderNumber.trim())}`;},
 async load(next=false){if(!this.visible||this.data.busy)return;const cursor=next?this.data.nextCursor:null;if(next&&(!this.canAct()||!cursor||this.data.loadedFilter!==this.filter()))return;
  cancelPageReads(this);this.stopPolling();const epoch=++this.epoch,token=getApp<IAppOption>().globalData.sessionToken;this.lastToken=token;this.lastRevision=commerceContextRevision();
  const filter=this.filter();this.setData({loading:true,coreReady:false,error:"",items:[],nextCursor:null});
  try{const a=await authorityProjection(this);if(!this.current(epoch,token))return;if(a.version!==1||!a.managementAvailable||!hasCapability(a,"commerce.fulfillment.manage"))throw {status:403};
   const result=await pageRead<{items:Row[];nextCursor:string|null}>(this,{path:`/v1/management/shipments?${filter}&limit=50${cursor?`&before=${encodeURIComponent(cursor)}`:""}`});if(!this.current(epoch,token))return;
   this.setData({items:result.items.map(r=>({...r,stateLabel:labels[r.logisticsState]||"待核验"})),nextCursor:result.nextCursor,loadedFilter:filter,coreReady:true});
  }catch(e){if(this.visible&&epoch===this.epoch)this.invalidate([401,403].includes((e as {status?:number})?.status??0)?"当前身份没有履约权限，请重新核验。":"订单暂时无法同步，请检查网络或当前环境是否开放履约后重试。");}finally{if(this.visible&&epoch===this.epoch){this.setData({loading:false});if(!this.current(epoch,token))this.invalidate();else this.poll();}}
 },
 onState(e:WechatMiniprogram.PickerChange){if(this.canAct()){this.setData({stateIndex:Number(e.detail.value),nextCursor:null});void this.load();}},
 onNumber(e:WechatMiniprogram.Input){if(this.canAct())this.setData({orderNumber:e.detail.value,nextCursor:null});},
 onRows(e:WechatMiniprogram.Input){if(this.canAct()&&!this.batchKey)this.setData({rows:e.detail.value,confirmed:false});},
 onConfirm(e:WechatMiniprogram.CheckboxGroupChange){if(this.canAct())this.setData({confirmed:e.detail.value.includes("confirmed")});},
 async exportExcel(){if(!this.canAct())return;const epoch=this.epoch,token=this.lastToken,filter=this.filter();this.setData({busy:true,notice:""});this.releaseDownload();
  try{const approved=await new Promise<boolean>(resolve=>wx.showModal({title:"导出履约信息",content:"文件包含收件人、手机号和地址，仅用于本次履约。导出人、筛选和数量将被审计；另存的文件请按保留规则妥善清理。最多导出当前筛选的 500 单。",confirmText:"确认导出",success:r=>resolve(r.confirm),fail:()=>resolve(false)}));if(!approved||!this.current(epoch,token))return;
   this.download=downloadPrivateMedia(`/v1/management/shipments/export?${filter}&limit=500`);const filePath=await this.download.promise;
   const a=await authorityProjection(this);if(!this.current(epoch,token)||a.version!==1||!a.managementAvailable||!hasCapability(a,"commerce.fulfillment.manage")){this.invalidate();return;}
   await new Promise<void>((resolve,reject)=>wx.openDocument({filePath,fileType:"xlsx",showMenu:true,success:()=>resolve(),fail:reject}));
   if(this.current(epoch,token))this.setData({notice:"已生成经审计的履约表。Excel 不会改变订单发货状态。"});
  }catch{if(this.current(epoch,token))this.setData({notice:"导出未完成，请核验权限及网络后重试。"});this.releaseDownload();}finally{if(this.visible&&epoch===this.epoch){this.setData({busy:false});if(!this.current(epoch,token))this.invalidate();}}
 },
 async submit(){if(!this.canAct()||!this.data.confirmed)return;if(this.data.batchPending&&!this.batchKey){this.setData({notice:"上批在离开页面时中断，请先查询订单核对结果，再结束上批。"});return;}const raw=this.data.rows.trim();const lines=raw.split(/\r?\n/);
  if(!raw||raw.length>16000||lines.length>25||lines.some(line=>line.split("\t").length!==5)){this.setData({notice:"请粘贴不含表头的 5 列物流信息，每批 1–25 行。"});return;}
  if(this.batchKey&&raw!==this.frozenRows){this.setData({notice:"重试必须保持原批次内容，请先核对订单结果。"});return;}
  this.batchKey ||= clientOperationKey("shipment");this.frozenRows=raw;const epoch=this.epoch,token=this.lastToken;this.setData({busy:true,batchLocked:true,batchPending:true,notice:"正在登记；离开页面不会撤回已发送的发货操作。",results:[]});
  try{const r=await request<{results:BatchResult[]}>({path:"/v1/management/shipments/import",method:"POST",idempotencyKey:this.batchKey,data:{rows:this.frozenRows}});if(!this.current(epoch,token))return;
   this.setData({results:r.results,batchPending:false,notice:"请逐行核对结果。已登记表示 CISME 已保存发货事实，微信同步由独立任务处理。"});
  }catch(e){if(this.current(epoch,token)){if([401,403].includes((e as {status?:number})?.status??0))this.invalidate();else this.setData({notice:"结果尚未确认。可用原内容、原批次重试；也可先查询订单核对。"});}}
  finally{if(this.visible&&epoch===this.epoch){this.setData({busy:false});if(!this.current(epoch,token))this.invalidate();}}
 },
 async reconcileBatch(){if(!this.canAct()||!this.data.batchPending||this.data.loadedFilter!==this.filter())return;const epoch=this.epoch,token=this.lastToken;this.setData({busy:true});try{const approved=await new Promise<boolean>(resolve=>wx.showModal({title:"结束未确认批次",content:"请先逐单查询 CISME 当前发货记录。此操作只清除本页重试上下文，不撤销服务端已保存的发货事实，也不代表微信同步成功。确认已核对后，才开始另一批。",confirmText:"已核对",success:r=>resolve(r.confirm),fail:()=>resolve(false)}));if(approved&&this.current(epoch,token)){this.batchKey="";this.frozenRows="";this.setData({rows:"",confirmed:false,results:[],batchPending:false,batchLocked:false,notice:"上批本地上下文已结束，服务端订单事实保持不变。"});}}finally{if(this.current(epoch,token))this.setData({busy:false});}},
 newBatch(){if(!this.canAct())return;if(this.data.batchPending){this.setData({notice:"上批结果未确认，请先用原内容重试并核对逐行结果。"});return;}this.batchKey="";this.frozenRows="";this.setData({rows:"",confirmed:false,results:[],notice:"",batchLocked:false,batchPending:false});},
 retry(){void this.load();},next(){void this.load(true);},back(){wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
