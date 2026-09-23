from pathlib import Path
import shutil
r=Path.cwd()
materials=r/'.github/cisme-review-materials'
for source,target in [('runtime.txt','apps/miniprogram/services/commerce-runtime.ts'),('runtime-test.txt','tests/unit/native-runtime-projection-contract.test.ts'),('sheet-test.txt','tests/unit/native-order-support-sheet.test.ts')]:
 shutil.copyfile(materials/source,r/target)
p=r/'apps/miniprogram/pages/order-detail/index.ts';s=p.read_text()
def replace(old,new):
 global s
 assert old in s, old[:100]
 s=s.replace(old,new,1)
replace('sheetTimer:null as ReturnType<typeof setTimeout>|null,sheetFailures:0,sheetCursor:0,','sheetTimer:null as ReturnType<typeof setTimeout>|null,sheetFailures:0,sheetCursor:0,sheetReadEpoch:0,sheetPollInFlight:false,')
replace('supportSheetOpen:false,sheetLoading:false,sheetError:"",sheetCase:null as SheetCase|null,sheetMessages:[] as SheetShown[],','supportSheetOpen:false,sheetLoading:false,sheetCasesReady:false,sheetConsulting:false,sheetPreviousCase:null as SheetCase|null,sheetCaseLabel:"",sheetRequestedLabel:"",sheetError:"",sheetCase:null as SheetCase|null,sheetMessages:[] as SheetShown[],')
replace('if(changed){this.stopSheetPoll();this.setData({supportSheetOpen:false,sheetCase:null,','if(changed){this.stopSheetPoll();this.sheetReadEpoch+=1;this.setData({supportSheetOpen:false,sheetCasesReady:false,sheetConsulting:false,sheetPreviousCase:null,sheetCaseLabel:"",sheetRequestedLabel:"",sheetLoading:false,sheetSubmitting:false,sheetSending:false,sheetCase:null,')
replace('this.stopSheetPoll();this.data.refreshOnShow=true;','this.stopSheetPoll();this.sheetReadEpoch+=1;this.data.refreshOnShow=true;')
start=s.index('  async pollSupportSheet()');end=s.index('  openAftersale()',start)
s=s[:start]+'''  sheetReadCurrent(epoch:number,token:string,generation:number){return this.sheetCurrent(epoch,token)&&generation===this.sheetReadEpoch;},
  applySheetCases(items:SheetCase[]){
    const selected=items.find(item=>!['cancelled','rejected'].includes(item.state))??null;
    const stateLabels:Record<string,string>={requested:'申请已收到',need_info:'请补充信息',awaiting_instruction:'客服正在准备退货信息',
      awaiting_return:'请按指引寄回',return_in_transit:'退货运输中',return_received:'退货已收到',quality_checked:'正在处理退款',
      refund_exception_approved:'无需寄回，正在处理退款',refund_pending:'退款处理中'};
    const label=!selected?'':selected.resolved?'已退款':selected.refund?.reviewState==='rejected'?'退款申请未通过':
      ['closed','abnormal'].includes(selected.refund?.channelState)?'退款需客服协助':stateLabels[selected.state]??'进度暂未更新';
    const at=selected?Date.parse(selected.requestedAt):NaN;
    this.setData({sheetCase:selected,sheetPreviousCase:selected?null:items[0]??null,sheetCasesReady:true,sheetCaseLabel:label,
      sheetRequestedLabel:Number.isFinite(at)?new Date(at).toLocaleString('zh-CN',{hour12:false}):'',
      ...(selected&&this.data.sheetAttempt?{sheetAttempt:null}:{})});
  },
  async pollSupportSheet(){if(!this.data.supportSheetOpen||!this.canAct()||this.data.sheetLoading||this.data.sheetSending||this.sheetPollInFlight){this.scheduleSheetPoll();return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,cursor=this.sheetCursor,generation=this.sheetReadEpoch;
    this.sheetPollInFlight=true;
    try{
      // Progress is a case fact, not inferred from the latest chat message.
      const [messages,cases]=await Promise.allSettled([
        pageRead<{messages:SheetMessage[];latestCursor:number;conversation:{id:string;teamReadSequence?:number}|null}>(this,
          {path:`/v1/me/support/messages?after=${cursor}&limit=50`,cacheTags:['support']}),
        pageRead<{items:SheetCase[]}>(this,{path:`/v1/me/aftersales?orderId=${this.data.id}&limit=20`})]);
      if(!this.sheetReadCurrent(epoch,token,generation))return;
      if(cases.status==='fulfilled')this.applySheetCases(cases.value.items??[]);
      if(messages.status==='fulfilled'){
        const page=messages.value;
        const state=mergeSyncPage<SheetShown>({messages:this.data.sheetMessages,syncCursor:this.sheetCursor,maxSeenSequence:this.sheetCursor,readCursor:0},
          presentSupportMessages(page.messages??[],{ownSenderType:'user',counterpartyReadSequence:page.conversation?.teamReadSequence??0}),page.latestCursor??cursor);
        this.sheetCursor=state.syncCursor;this.setData({sheetMessages:presentSupportMessages(state.messages,{ownSenderType:'user',counterpartyReadSequence:page.conversation?.teamReadSequence??0}).slice(-30),sheetConversation:page.conversation});
      }
      this.sheetFailures=messages.status==='rejected'||cases.status==='rejected'?Math.min(this.sheetFailures+1,5):0;
      this.setData({sheetError:cases.status==='rejected'?'售后进度暂未更新，请重试。':messages.status==='rejected'?'消息暂未更新，请重试。':''});
    }finally{
      this.sheetPollInFlight=false;
      if(this.sheetReadCurrent(epoch,token,generation))this.scheduleSheetPoll();
    }
  },
  async loadSupportSheet(){if(!this.data.supportSheetOpen||!this.canAct())return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken,generation=++this.sheetReadEpoch;
    this.stopSheetPoll();this.setData({sheetLoading:true,sheetCasesReady:false,sheetError:''});
    const [cases,messages]=await Promise.allSettled([
      pageRead<{items:SheetCase[]}>(this,{path:`/v1/me/aftersales?orderId=${this.data.id}&limit=20`}),
      pageRead<{messages:SheetMessage[];latestCursor:number;conversation:{id:string;teamReadSequence?:number}|null}>(this,{path:'/v1/me/support/messages?limit=30',cacheTags:['support']})]);
    if(!this.sheetReadCurrent(epoch,token,generation))return;
    if(cases.status==='fulfilled')this.applySheetCases(cases.value.items??[]);
    if(messages.status==='fulfilled'){
      const page=messages.value;this.sheetCursor=page.latestCursor??0;
      this.setData({sheetConversation:page.conversation,sheetMessages:presentSupportMessages(page.messages??[],{ownSenderType:'user',counterpartyReadSequence:page.conversation?.teamReadSequence??0})});
    }
    this.setData({sheetLoading:false,sheetError:cases.status==='rejected'?'售后记录暂未加载，请重试。':messages.status==='rejected'?'消息暂未更新，仍可提交售后申请。':''});
    this.scheduleSheetPoll();
  },
''' + s[end:]
replace("  closeSupportSheet(){if(this.data.sheetSubmitting||this.data.sheetSending)return;this.stopSheetPoll();this.setData({supportSheetOpen:false,sheetKeyboardHeight:0});},", """  closeSupportSheet(){this.stopSheetPoll();this.sheetReadEpoch+=1;this.setData({supportSheetOpen:false,sheetCasesReady:false,sheetKeyboardHeight:0});},
  onSupportSheetLeave(){if(this.data.supportSheetOpen)this.closeSupportSheet();},
  copySheetReturnInstruction(){
    if(!this.sheetCurrent(this.data.epoch,getApp<IAppOption>().globalData.sessionToken)||!this.data.sheetCasesReady)return;
    const row=this.data.sheetCase,d=row?.returnDestination;
    if(!row||row.state!=='awaiting_return'||!d)return;
    wx.setClipboardData({data:`${d.recipientName} ${d.phone}\\n${d.region??''} ${d.address}\\n退货指引第 ${d.version} 版`});
  },
  toggleSheetConsulting(){if(this.data.sheetSubmitting||this.data.sheetSending||this.data.sheetAttempt||this.data.sheetSendAttempt)return;
    this.setData({sheetConsulting:!this.data.sheetConsulting});},""")
replace("fail:()=>this.setData({navigating:false})});},\n  chooseSheetKind", "fail:()=>{this.setData({navigating:false});this.scheduleSheetPoll();}});},\n  chooseSheetKind")
replace("this.setData({navigating:false,...(draft?{sheetInput:draft}:{})});", "this.setData({navigating:false,...(draft?{sheetInput:draft}:{})});this.scheduleSheetPoll();")
replace("onSheetKeyboardHeightChange(event:WechatMiniprogram.TextareaKeyboardHeightChange){this.setData({sheetKeyboardHeight:Math.max(0,Number(event.detail.height)||0)});},", "onSheetKeyboardHeightChange(event:WechatMiniprogram.TextareaKeyboardHeightChange){const height=Number(event.detail.height);this.setData({sheetKeyboardHeight:this.data.supportSheetOpen&&Number.isFinite(height)?Math.max(0,height):0});},")
replace("||this.data.sheetSubmitting||this.data.sheetCase)return;", "||this.data.sheetSubmitting||!this.data.sheetCasesReady||this.data.sheetCase)return;")
for old,new in {
 'requested:"待复核",rejected:"未通过",approved:"已核准，待渠道处理",prepared:"待提交渠道",succeeded:"渠道已退款",closed:"渠道已关闭",abnormal:"渠道异常"':
 'requested:"申请已收到",rejected:"申请未通过",approved:"退款处理中",prepared:"退款处理中",succeeded:"已退款",closed:"退款已关闭",abnormal:"退款需客服协助"',
 'refundLabels[row.refundState??""]??refundLabels[row.state]??row.state':'refundLabels[row.refundState??""]??refundLabels[row.state]??"进度暂未更新"',
 '正在核验资金操作状态，订单事实可先查看。':'正在连接支付服务…',
 '资金操作状态暂时无法核验，付款及退款申请保持关闭；可单独重试。':'支付服务暂未连接，订单与售后仍可查看。',
 '订单已取消，相关预留已由服务端处理。':'订单已取消。',
}.items(): replace(old,new)
p.write_text(s)
p=r/'apps/miniprogram/pages/order-detail/index.wxml';s=p.read_text()
replace('<view wx:if="{{supportSheetOpen && order}}" class="support-sheet-mask" catchtap="closeSupportSheet">\n  <view class="support-sheet" style="bottom:{{sheetKeyboardHeight}}px" catchtap="stopPropagation">',
'''<page-container wx:if="{{order}}" show="{{supportSheetOpen}}" position="bottom" duration="220" z-index="90" overlay="{{true}}" round="{{true}}" close-on-slide-down="{{false}}" bindclickoverlay="closeSupportSheet" bindbeforeleave="onSupportSheetLeave" overlay-style="background:rgba(30,20,36,.48)" custom-style="height:78vh;max-height:calc(100vh - {{sheetKeyboardHeight}}px - 100rpx);bottom:{{sheetKeyboardHeight}}px;background:#fbf8fc;overflow:hidden;">
  <view class="support-sheet" catchtap="stopPropagation">''')
replace('</view>\n<view wx:if="{{order&&!coreReady}}"', '</page-container>\n<view wx:if="{{order&&!coreReady}}"')
replace('<strong>订单售后与客服</strong>', '<strong>售后客服</strong>')
start=s.index("<strong>{{sheetCase.resolved?");end=s.index('</strong>',start)+len('</strong>')
s=s[:start]+'<strong>{{sheetCaseLabel}}</strong>'+s[end:]
replace('<text>申请时间 {{sheetCase.requestedAt}}</text>','<text wx:if="{{sheetRequestedLabel}}">申请时间 {{sheetRequestedLabel}}</text>')
replace('查看案件与下一步','查看售后进度')
replace('<text>打开面板不会提交申请。请选择售后情形后点击“提交申请”。</text>', '<text wx:if="{{sheetPreviousCase}}">{{sheetPreviousCase.state===\'cancelled\'?\'上次申请已撤回，可重新申请。\':\'上次申请未通过，可重新申请或咨询客服。\'}}</text><text wx:else>选择问题后提交，我们会为你处理。</text><button wx:if="{{sheetPreviousCase}}" bindtap="openFullAftersale">查看历史记录</button>')
replace('<text wx:if="{{sheetError}}" class="support-sheet__error" aria-live="polite">{{sheetError}}</text>', '<view wx:if="{{sheetError}}" class="support-sheet__error" aria-live="polite"><text>{{sheetError}}</text><button class="text-button" bindtap="loadSupportSheet" disabled="{{sheetLoading}}">重试</button></view>')
replace('<block wx:if="{{!sheetCase}}">','<block wx:if="{{!sheetCase && !sheetConsulting}}">')
replace('disabled="{{sheetSubmitting||sheetLoading}}" loading="{{sheetSubmitting}}"', 'disabled="{{sheetSubmitting||sheetLoading||!sheetCasesReady}}" loading="{{sheetSubmitting}}"')
replace('sheetSubmitting||sheetLoading?\'control--disabled\'', 'sheetSubmitting||sheetLoading||!sheetCasesReady?\'control--disabled\'')
replace('<view class="support-sheet__composer">','<button wx:if="{{!sheetCase}}" class="support-sheet__mode" bindtap="toggleSheetConsulting" disabled="{{sheetSubmitting||sheetSending||sheetAttempt||sheetSendAttempt}}">{{sheetConsulting?\'返回售后申请\':\'先咨询客服\'}}</button>\n      <view wx:if="{{sheetCase || sheetConsulting}}" class="support-sheet__composer">')
replace('<view class="state" aria-live="polite"><text>{{runtimeCopy}}</text>', '<view wx:if="{{runtimeState===\'error\'||runtimeMode===\'test\'||order.status===\'pending_payment\' && !isolatedPayment}}" class="state" aria-live="polite"><text>{{runtimeCopy}}</text>')
for old,new in {
 '正在同步订单事实…':'正在加载订单…',
 '重新核验操作状态':'重试连接',
 '显示上次读取的内容，正在等待最新核验；暂不可提交资金操作。':'正在更新订单，稍后可继续操作。',
 '支付事实已由服务端核验。履约和退款分别处理。':'付款成功，可在下方查看物流与售后。',
 '申请售后 / 查看处理记录':'售后服务',
 '规则版本：{{order.pricingRuleVersion}}':'',
 '终态原因：{{order.terminalReason}}':'',
 '取消并释放预留库存':'取消订单',
}.items(): replace(old,new)
s=s.replace('<text class="detail-copy"></text>','').replace('<text wx:if="{{order.terminalReason}}" class="detail-copy"></text>','')
start=s.index('  <text class="refund-copy">已有记录不因');end=s.index('</text>',start)+len('</text>')
s=s[:start]+'''  <text class="refund-copy">{{runtimeMode==='test'?'测试环境，不会发生真实退款。':'退款进度更新在这里。有问题可从售后服务联系客服。'}}</text>'''+s[end:]
replace('<view class="payment-boundary">','<view wx:if="{{runtimeMode===\'test\'}}" class="payment-boundary">')
needle='<button bindtap="openFullAftersale">查看售后进度</button>'
insert='''<view wx:if="{{sheetCase.returnDestination && sheetCase.state==='awaiting_return'}}" class="support-sheet__instruction"><strong>本单退货信息</strong><text user-select>{{sheetCase.returnDestination.recipientName}} · {{sheetCase.returnDestination.phone}}</text><text user-select>{{sheetCase.returnDestination.region}} {{sheetCase.returnDestination.address}}</text><text>{{sheetCase.returnDestination.freightPayer==='merchant'?'退货运费由商家承担':sheetCase.returnDestination.freightPayer==='member'?'退货运费由你承担':'退货运费请与客服确认'}}</text><text wx:if="{{sheetCase.returnDestination.instructions}}">{{sheetCase.returnDestination.instructions}}</text><button bindtap="copySheetReturnInstruction" disabled="{{!sheetCasesReady}}">复制退货信息</button></view>\n        '''
replace(needle,insert+needle)
replace('<view wx:if="{{item.returnInstruction}}" class="support-sheet__instruction"><strong>退货指引 · 第 {{item.returnInstruction.version}} 版</strong><text user-select>{{item.returnInstruction.recipientName}} · {{item.returnInstruction.phone}}</text><text user-select>{{item.returnInstruction.region}} {{item.returnInstruction.address}}</text></view>', '<text wx:if="{{item.returnInstruction}}">{{sheetCase && item.returnInstruction.caseId===sheetCase.id?\'退货信息请以上方本单指引为准。\':\'这是其他售后记录，展开会话可查看。\'}}</text>')
p.write_text(s)
p=r/'apps/miniprogram/pages/order-detail/index.wxss';s=p.read_text()
s=s.replace('.support-sheet-mask{position:fixed;inset:0;z-index:90;background:rgba(30,20,36,.48)}\n','')
s=s.replace('position:absolute;left:0;right:0;height:78vh;max-height:calc(100vh - 100rpx);','position:relative;height:100%;min-height:0;box-sizing:border-box;')
s+='''\n/* Local styles: do not consume the nearly-full global WXSS budget. */
.support-sheet__header,.support-sheet__order{flex-shrink:0}
.support-sheet__header>strong{min-width:0;flex:1;overflow-wrap:anywhere}
.support-sheet__header>view{flex-shrink:0}
.support-sheet__footer{min-height:0;max-height:60%;overflow-y:auto;flex-shrink:1;box-sizing:border-box}
.support-sheet__composer textarea{min-width:0;width:auto}
.support-sheet button{display:flex;align-items:center;justify-content:center;box-sizing:border-box;line-height:1.35;white-space:normal}
.support-sheet button::after{border:0}
.support-sheet__mode{min-height:44px;margin:0;background:transparent;color:#56306f;font-size:24rpx}
.support-sheet__error{display:flex;align-items:center;gap:12rpx}
.support-sheet__error>text{flex:1;min-width:0}
.support-sheet__error>button{min-width:88rpx;min-height:44px;flex-shrink:0}
'''
p.write_text(s)
