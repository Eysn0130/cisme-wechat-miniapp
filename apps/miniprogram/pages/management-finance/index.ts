import {validateRuntime,runtimeActions} from "../../services/commerce-runtime";
import { request } from "../../services/api";
import { authorityProjection,hasCapability,type AuthorityProjection } from "../../services/authority";
import { currentChromeStyle } from "../../services/layout";
import { clientOperationKey,orderRuntimeStatus } from "../../services/orders";

type Section="refund"|"fulfillment"|"settlement"|"cycles"|"issues"|"bills";
type CycleMember={memberId:string;grossCents:number;orderCount:number;requestId:string|null;
  requestState:string|null;withholdingCents:number|null;netCents:number|null;grossLabel?:string};
type Cycle={id:string;periodEnd:string;preparedByMemberId:string;state:string;payable:false;replay:boolean;
  members:CycleMember[];thresholdCents:number;withholdingPolicyVersion:null};
type Row={id:string;orderId?:string;memberId?:string;requestedByMemberId?:string;
  amountCents?:number;reason?:string;sourceReference?:string;evidenceSha256?:string;
  deliveredAt?:string;version?:number;kind?:string;relatedId?:string;code?:string;
  billDate?:string;billType?:string;rowCount?:number;matchedCount?:number;exceptionCount?:number;
  attempts?:number;canRedrive?:boolean;createdAt?:string;amountLabel?:string;dateLabel?:string;kindLabel?:string};
type PageResult={items:Row[];totalCount:number;nextCursor:string|null};
const sections:[Section,string,Parameters<typeof hasCapability>[1]][]=[
  ["refund","退款申请","commerce.refund.approve"],
  ["fulfillment","履约核验","commerce.fulfillment.manage"],
  ["settlement","结算意向","commission.settlement.approve"],
  ["cycles","周期候选","commission.settlement.approve"],
  ["issues","异常任务","commerce.money.reconcile"],
  ["bills","交易账单","commerce.money.reconcile"]
];
const paths:Record<Section,string>={refund:"/v1/management/refund-requests/pending",
  fulfillment:"/v1/management/fulfillment/pending",
  settlement:"/v1/management/commission/settlement-requests/pending",cycles:"",
  issues:"/v1/management/money/issues",bills:"/v1/management/money/trade-bills"};
const kindNames:Record<string,string>={payment_inbox:"支付事实",refund_inbox:"退款事实",
  refund_submission:"退款提交",transfer:"转账查单",transfer_callback:"转账回调",
  trade_bill:"账单差异"};
const yesterdayShanghai=()=>new Date(Date.now()+8*60*60*1000-24*60*60*1000).toISOString().slice(0,10);
const lastCycleMonth=()=>{const shanghai=new Date(Date.now()+8*60*60*1000).toISOString();
  return new Date(Date.UTC(Number(shanghai.slice(0,4)),Number(shanghai.slice(5,7))-1,0))
    .toISOString().slice(0,7);};
const cyclePeriodEnd=(month:string)=>/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  ?new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10):"";
const timeLabel=(value?:string)=>value?new Date(value).toLocaleString("zh-CN",{
  year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}):"";
const format=(row:Row):Row=>({...row,amountLabel:typeof row.amountCents==="number"
  ?(row.amountCents/100).toFixed(2):"",dateLabel:timeLabel(row.createdAt),
  kindLabel:kindNames[row.kind??""]??"待核对"});

Page({
  data:{formalMode:false,moneyEnabled:false,chromeStyle:currentChromeStyle(),authority:null as AuthorityProjection|null,
    sections:[] as Array<{id:Section;label:string}>,section:"refund" as Section,
    items:[] as Row[],totalCount:0,nextCursor:null as string|null,loading:true,loadingMore:false,
    busy:false,error:"",moreError:"",actionError:"",actionStatus:"",
    cycleMonth:lastCycleMonth(),latestCycleMonth:lastCycleMonth(),cycle:null as Cycle|null,
    cycleDecisionKeys:{} as Record<string,string>,
    billDate:yesterdayShanghai(),latestBillDate:yesterdayShanghai(),alive:true,epoch:0,navigating:false},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.alive=true;this.setData({navigating:false,latestBillDate:yesterdayShanghai(),
    latestCycleMonth:lastCycleMonth()});void this.establish();},
  onHide(){this.data.alive=false;this.data.epoch+=1;this.setData({authority:null,sections:[],items:[],cycle:null,moneyEnabled:false,busy:false});},
  onUnload(){this.onHide();},
  async establish(){
    const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({authority:null,sections:[],items:[],totalCount:0,nextCursor:null,
      cycle:null,cycleDecisionKeys:{},busy:false,loadingMore:false,loading:true,error:"",actionError:"",actionStatus:""});
    const current=()=>this.data.alive&&this.data.epoch===epoch&&
      token===getApp<IAppOption>().globalData.sessionToken;
    try{
      const [authority,runtime]=await Promise.all([authorityProjection(),orderRuntimeStatus()]);
      const status=validateRuntime(runtime),actions=runtimeActions(status),formalMode=status.scope==="formal_commerce";
      if(!current())return;
      if(!actions.money&&!actions.recovery){this.setData({loading:false,error:"当前环境没有开放资金核对。"});return;}
      const available=sections.filter(([id,,capability])=>hasCapability(authority,capability)&&(!formalMode||id!=="fulfillment")&&
        (!["settlement","cycles"].includes(id)||status.isolatedTransferAvailable)).map(([id,label])=>({id,label}));
      if(!available.length){this.setData({loading:false,error:"当前账号没有资金核对权限。"});return;}
      const section=available.some(item=>item.id===this.data.section)?this.data.section:available[0]!.id;
      this.setData({authority,sections:available,section,formalMode,moneyEnabled:actions.money});void this.load();
    }catch(error){if(current())this.setData({loading:false,error:(error as {title?:string}).title||"资金权限暂时无法核验。"});}
  },
  selectSection(event:WechatMiniprogram.TouchEvent){
    const section=String(event.currentTarget.dataset.section) as Section;
    if(!this.data.sections.some(item=>item.id===section)||this.data.busy)return;
    // A cycle snapshot is immutable but its *approval* and source availability
    // may have changed while the reviewer worked in another section.
    this.setData({section,cycle:null,actionError:"",actionStatus:""});void this.load();
  },
  async load(){
    const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,section=this.data.section;
    this.setData({items:[],totalCount:0,nextCursor:null,loading:section!=="cycles",loadingMore:false,
      error:"",moreError:""});
    if(section==="cycles")return;
    const current=()=>this.data.alive&&this.data.epoch===epoch&&this.data.section===section&&
      token===getApp<IAppOption>().globalData.sessionToken;
    try{const result=await request<PageResult>({path:`${paths[section]}?limit=20`});
      if(current())this.setData({items:result.items.map(format),totalCount:result.totalCount,
        nextCursor:result.nextCursor,loading:false});
    }catch(error){if(current())this.setData({items:[],loading:false,
      error:(error as {title?:string}).title||"待办暂时无法加载，请重试。"});}
  },
  async loadMore(){
    if(this.data.section==="cycles")return;
    const cursor=this.data.nextCursor;if(!cursor||this.data.loading||this.data.loadingMore)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,section=this.data.section;
    this.setData({loadingMore:true,moreError:""});
    try{const result=await request<PageResult>({path:`${paths[section]}?limit=20&cursor=${encodeURIComponent(cursor)}`});
      if(!this.data.alive||this.data.epoch!==epoch||this.data.section!==section||
        token!==getApp<IAppOption>().globalData.sessionToken||this.data.nextCursor!==cursor)return;
      const seen=new Set(this.data.items.map(row=>row.id));
      this.setData({items:[...this.data.items,...result.items.filter(row=>!seen.has(row.id)).map(format)],
        totalCount:result.totalCount,nextCursor:result.nextCursor,loadingMore:false});
    }catch(error){if(this.data.alive&&this.data.epoch===epoch&&token===getApp<IAppOption>().globalData.sessionToken)
      this.setData({loadingMore:false,moreError:(error as {title?:string}).title||"更多待办暂未加载。"});}
  },
  async decide(event:WechatMiniprogram.TouchEvent){
    if(this.data.formalMode&&!this.data.moneyEnabled)return;
    if(this.data.busy||this.data.section==="issues"||this.data.section==="cycles"||
      this.data.section==="settlement"&&event.currentTarget.dataset.decision==="approve")return;
    const id=String(event.currentTarget.dataset.id),decision=String(event.currentTarget.dataset.decision),
      section=this.data.section,row=this.data.items.find(item=>item.id===id);
    if(!row||!row.version||!this.data.sections.some(item=>item.id===section))return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,version=row.version;
    const current=()=>this.data.alive&&this.data.epoch===epoch&&this.data.section===section&&
      token===getApp<IAppOption>().globalData.sessionToken&&
      this.data.items.some(item=>item.id===id&&item.version===version);
    const confirm=await wx.showModal({title:decision==="reject"?"退回这项申请？":"确认核验结果？",
      content:section==="fulfillment"?`凭据 ${row.sourceReference??""} · 摘要 ${row.evidenceSha256?.slice(0,12)??""}。请先核对原件与签收时间。`:
        `金额 ¥${row.amountLabel}，对象 ${row.orderId??row.memberId??""}。请核对原始事实。`,
      editable:true,placeholderText:"输入至少 4 字的处理依据",confirmText:"提交决定"});
    if(!confirm.confirm||!current())return;
    const reason=String(confirm.content??"").trim();if(Array.from(reason).length<4){this.setData({actionError:"请输入至少 4 字的处理依据。"});return;}
    const base=section==="refund"?`/v1/management/refund-requests/${id}/decision`:
      section==="fulfillment"?`/v1/management/fulfillment/${id}/decision`:
        `/v1/management/commission/settlement-requests/${id}/decision`;
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{if(!current())return;
      await request({path:base,method:"POST",idempotencyKey:clientOperationKey("finance-decision"),
        data:{decision,expectedVersion:version,reason}});
      if(current()){this.setData({busy:false,actionStatus:"处理已提交，正在同步最新待办。"});await this.load();}
    }catch(error){if(current())this.setData({busy:false,
      actionError:(error as {title?:string}).title||"处理未完成，请核对状态后重试。"});}
    finally{if(this.data.alive&&this.data.epoch===epoch)this.setData({busy:false});}
  },
  chooseCycleMonth(event:{detail:{value:string}}){
    if(this.data.busy)return;
    this.setData({cycleMonth:event.detail.value,cycle:null,cycleDecisionKeys:{},
      actionError:"",actionStatus:""});
  },
  async loadCycle(){
    const month=this.data.cycleMonth,periodEnd=cyclePeriodEnd(month),epoch=this.data.epoch,
      token=getApp<IAppOption>().globalData.sessionToken;
    if(this.data.section!=="cycles"||!periodEnd||month>this.data.latestCycleMonth){
      this.setData({actionError:"请选择已结束的上海自然月。"});return;}
    this.setData({busy:true,actionError:""});
    try{const cycle=await request<Cycle>({path:"/v1/management/commission/settlement-cycles/prepare",
      method:"POST",data:{periodEnd}});
      if(this.data.alive&&this.data.epoch===epoch&&this.data.section==="cycles"&&
        this.data.cycleMonth===month&&token===getApp<IAppOption>().globalData.sessionToken)
        this.setData({cycle:{...cycle,members:cycle.members.map(row=>({...row,
          grossLabel:(row.grossCents/100).toFixed(2)}))},busy:false});
    }catch(error){if(this.data.alive&&this.data.epoch===epoch)this.setData({busy:false,
      actionError:(error as {title?:string}).title||"周期候选暂不能核对。"});}
    finally{if(this.data.alive&&this.data.epoch===epoch)this.setData({busy:false});}
  },
  async prepareCycle(){
    if(this.data.busy||this.data.section!=="cycles")return;
    const periodEnd=cyclePeriodEnd(this.data.cycleMonth);
    if(!periodEnd||this.data.cycleMonth>this.data.latestCycleMonth){
      this.setData({actionError:"请选择已结束的上海自然月。"});return;}
    const answer=await wx.showModal({title:"核对周期候选？",
      content:`${periodEnd} 前释放、目前仍可结算的来源按会员汇总。未满税前 ¥100 结转；生成候选不批准、不发款。每月须到 15 日才可准备。`,confirmText:"读取候选"});
    if(answer.confirm)void this.loadCycle();
  },
  async approveCycleMember(event:WechatMiniprogram.TouchEvent){
    const cycle=this.data.cycle,memberId=String(event.currentTarget.dataset.member??""),
      row=cycle?.members.find(item=>item.memberId===memberId);
    if(this.data.busy||this.data.section!=="cycles"||!cycle||!row||row.requestId)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const answer=await wx.showModal({title:"独立复核本期候选？",
      content:`收款人 ${memberId} · 税前 ¥${row.grossLabel} · ${row.orderCount} 笔。仅本机隔离模拟渠道，零扣缴为合成测试口径，绝非真实免税或付款授权。准备人与复核人不能相同。`,
      editable:true,placeholderText:"输入至少 4 字复核依据",confirmText:"批准测试批次"});
    if(!answer.confirm||!this.data.alive||this.data.epoch!==epoch||
      token!==getApp<IAppOption>().globalData.sessionToken)return;
    const reason=String(answer.content??"").trim();
    if(Array.from(reason).length<4){this.setData({actionError:"请输入至少 4 字复核依据。"});return;}
    const keyId=`${cycle.id}:${memberId}`,decisionKey=this.data.cycleDecisionKeys[keyId]||
      clientOperationKey("cycle-approve");
    this.setData({busy:true,actionError:"",actionStatus:"",
      cycleDecisionKeys:{...this.data.cycleDecisionKeys,[keyId]:decisionKey}});
    try{await request({path:`/v1/management/commission/settlement-cycles/${cycle.id}/approve-member`,
      method:"POST",idempotencyKey:decisionKey,
      data:{memberId,reason,taxPolicyVersion:"isolated-synthetic-zero-withholding-v1"}});
      if(this.data.alive&&this.data.epoch===epoch&&this.data.section==="cycles"){
        const keys={...this.data.cycleDecisionKeys};delete keys[keyId];
        this.setData({busy:false,cycleDecisionKeys:keys,
          actionStatus:"隔离批次已复核并生成来源预占；渠道确认前不代表已付款。"});
        await this.loadCycle();}
    }catch(error){if(this.data.alive&&this.data.epoch===epoch)this.setData({busy:false,
      actionError:(error as {title?:string}).title||"批次复核未完成，请核对状态。"});}
    finally{if(this.data.alive&&this.data.epoch===epoch)this.setData({busy:false});}
  },
  async operateIssue(event:WechatMiniprogram.TouchEvent){
    if(this.data.formalMode&&!this.data.moneyEnabled&&event.currentTarget.dataset.action==="redrive")return;
    if(this.data.busy||this.data.section!=="issues")return;
    const id=String(event.currentTarget.dataset.id),action=String(event.currentTarget.dataset.action),
      item=this.data.items.find(row=>row.id===id);
    if(!item||!item.kind||!item.relatedId||item.kind==="trade_bill"||
      action==="redrive"&&!item.canRedrive)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    const current=()=>this.data.alive&&this.data.epoch===epoch&&this.data.section==="issues"&&
      token===getApp<IAppOption>().globalData.sessionToken&&this.data.items.some(row=>row.id===id);
    const answer=await wx.showModal({title:action==="redrive"?"重驱原任务？":"按原单号查渠道？",
      content:`${item.kindLabel} · ${item.code}。状态必须由渠道核验，不能手工改为成功。`,
      editable:action==="redrive",placeholderText:"输入至少 8 字的重驱依据",confirmText:action==="redrive"?"确认重驱":"确认查单"});
    if(!answer.confirm||!current())return;
    const reason=String(answer.content??"").trim();
    if(action==="redrive"&&Array.from(reason).length<8){this.setData({actionError:"请输入至少 8 字的重驱依据。"});return;}
    let path="",data:Record<string,unknown>={};
    if(action==="redrive"&&["payment_inbox","refund_inbox"].includes(item.kind)){
      path=`/v1/management/money/inboxes/${item.kind==="payment_inbox"?"payment":"refund"}/${id}/redrive`;data={reason};
    }else if(action==="redrive"&&item.kind==="transfer"){
      path=`/v1/management/commission/settlement-requests/${id}/redrive`;data={reason,expectedAttempts:item.attempts};
    }else if(action==="redrive"&&item.kind==="refund_submission"){
      path=`/v1/management/refund-submissions/${id}/redrive`;data={reason,expectedAttempts:item.attempts};
    }else if(action==="recheck"){
      const kind=item.kind==="payment_inbox"?"payment":
        ["refund_inbox","refund_submission"].includes(item.kind)?"refund":"transfer";
      path=`/v1/management/money/recheck/${kind}/${item.relatedId}`;
    }else return;
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{if(!current())return;
      await request({path,method:"POST",data});
      if(current()){this.setData({busy:false,actionStatus:"已按原单核对或安排重驱，请查看最新状态。"});await this.load();}
    }catch(error){if(current())this.setData({busy:false,
      actionError:(error as {title?:string}).title||"操作未完成，请核对后重试。"});}
    finally{if(this.data.alive&&this.data.epoch===epoch)this.setData({busy:false});}
  },
  chooseBillDate(event:{detail:{value:string}}){this.setData({billDate:event.detail.value});},
  async importBill(event:WechatMiniprogram.TouchEvent){
    if(this.data.busy||this.data.section!=="bills"||
      !this.data.sections.some(item=>item.id==="bills"))return;
    const type=String(event.currentTarget.dataset.type);
    if(type!=="SUCCESS"&&type!=="REFUND")return;
    const date=this.data.billDate,epoch=this.data.epoch,
      token=getApp<IAppOption>().globalData.sessionToken;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>=new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10)){
      this.setData({actionError:"请选择微信已生成的历史账单日期。"});return;}
    const current=()=>this.data.alive&&this.data.epoch===epoch&&this.data.section==="bills"&&
      token===getApp<IAppOption>().globalData.sessionToken&&this.data.billDate===date;
    const answer=await wx.showModal({title:this.data.formalMode?"核对微信交易账单？":"导入隔离交易账单？",
      content:`${date} ${type==="SUCCESS"?"支付":"退款受理"}账单。系统会校验渠道文件摘要并记录差异；不会据此修改资金终态。`,
      confirmText:"核对账单"});
    if(!answer.confirm||!current())return;
    this.setData({busy:true,actionError:"",actionStatus:""});
    try{const result=await request<{rowCount:number;matchedCount:number;exceptionCount:number;replayed:boolean}>({
      path:"/v1/management/money/trade-bills/import",method:"POST",data:{billDate:date,billType:type}});
      if(current()){this.setData({busy:false,actionStatus:`${result.replayed?"已核对过的账单":"账单已记录"}：${result.rowCount} 条，匹配 ${result.matchedCount} 条，差异 ${result.exceptionCount} 条。`});
        await this.load();}}
    catch(error){if(current())this.setData({busy:false,
      actionError:(error as {title?:string}).title||"账单暂时无法核对，请稍后重试。"});}
    finally{if(this.data.alive&&this.data.epoch===epoch)this.setData({busy:false});}
  },
  retry(){void this.establish();},
  back(){if(this.data.navigating)return;this.setData({navigating:true});
    wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
