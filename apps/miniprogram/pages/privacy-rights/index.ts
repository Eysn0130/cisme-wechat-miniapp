import { request, resumeAuthentication } from '../../services/api';
import { currentChromeStyle } from '../../services/layout';
const kinds=['access','correct','delete','close_account','withdraw','other'];
const labels=['查阅或复制个人信息','更正个人信息','删除个人信息','注销会员账号','撤回个人信息处理同意','其他隐私咨询'];
const statuses:Record<string,string>={received:'已受理',verifying:'身份核验中',reviewing:'处理中',approved:'已批准待执行',executing:'正在执行',completed:'已完成',partially_completed:'部分完成',rejected:'未批准',canceled:'已取消',responded:'已回复，尚不代表执行完成'};
const executionStatuses:Record<string,string>={planned:'已建立计划，尚未执行',approved:'已复核待执行',running:'正在执行',succeeded:'执行成功',partially_succeeded:'部分执行成功',failed:'执行失败待处理',expired:'导出已过期',canceled:'计划已取消'};
Page({
 data:{chromeStyle:currentChromeStyle(),authenticated:false,labels,selected:0,message:'',records:[] as any[],busy:false,loading:false,error:'',notice:'',alive:true,loadAttempt:0},
 onShow(){this.data.alive=true;this.setData({authenticated:Boolean(getApp<IAppOption>().globalData.sessionToken)});void this.load();},
 onHide(){this.data.loadAttempt+=1;},
 onUnload(){this.data.alive=false;},
 onResize(){this.setData({chromeStyle:currentChromeStyle()});},
 choose(e:WechatMiniprogram.PickerChange){this.setData({selected:Number(e.detail.value)});},
 input(e:WechatMiniprogram.TextareaInput){this.setData({message:e.detail.value});},
 login(){resumeAuthentication('/pages/privacy-rights/index');},
 async load(){
  if(!this.data.authenticated){this.setData({records:[]});return;}
  const attempt=++this.data.loadAttempt;
  const token=getApp<IAppOption>().globalData.sessionToken;
  this.setData({loading:true,error:'',records:[]});
  try{const records=await request<any[]>({path:'/v1/me/privacy-requests'});if(this.data.alive && attempt===this.data.loadAttempt && token===getApp<IAppOption>().globalData.sessionToken)this.setData({records:records.map(r=>({...r,label:labels[kinds.indexOf(r.kind)]||r.kind,statusLabel:statuses[r.status]||r.status,executionSummary:r.execution?`${r.execution.type==='export'?'数据副本':'数据处理'}：${executionStatuses[r.execution.status]||r.execution.status}`:''}))});}
  catch(e){if(this.data.alive && attempt===this.data.loadAttempt && token===getApp<IAppOption>().globalData.sessionToken)this.setData({error:(e as {title?:string}).title||'受理记录加载失败，请重试。'});}
  finally{if(this.data.alive && attempt===this.data.loadAttempt && token===getApp<IAppOption>().globalData.sessionToken)this.setData({loading:false});}
 },
 async submit(){
  if(this.data.busy)return;
  if(!this.data.message.trim()){this.setData({error:'请填写需要协助的事项。'});return;}
  const token=getApp<IAppOption>().globalData.sessionToken;
  this.setData({busy:true,error:'',notice:''});
  try{await request({path:'/v1/me/privacy-requests',method:'POST',data:{kind:kinds[this.data.selected],message:this.data.message}});if(this.data.alive && token===getApp<IAppOption>().globalData.sessionToken){this.setData({message:'',notice:'请求已受理。请在下方查看处理回复；提交申请不代表已完成数据操作。'});await this.load();}}
  catch(e){if(this.data.alive && token===getApp<IAppOption>().globalData.sessionToken)this.setData({error:(e as {title?:string}).title||'尚未确认提交结果，请刷新受理记录后再试。'});}
  finally{if(this.data.alive && token===getApp<IAppOption>().globalData.sessionToken)this.setData({busy:false});}
 },
 back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/community/index'})});}
});
