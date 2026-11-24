import { authorityProjection, hasCapability } from "../../services/authority";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { cancelPageReads, pageRead } from "../../services/page-requests";
import { currentChromeStyle } from "../../services/layout";
import { request, requireMemberAccess } from "../../services/api";
import { SupportIdentityCache, type SupportSender } from "../../services/support-identity";
import {identityLabel} from '../../services/display-identity';

const labels:Record<string,string>={waiting_human:"待接待",human_active:"人工接待中",ai_active:"AI 处理中",resolved:"已结束"};
type QueuePage={items:any[];nextCursor:string|null};
function preview(value:unknown):string{const text=Array.from(String(value||"").replace(/\s+/g," ").trim());return text.slice(0,48).join("")+(text.length>48?"…":"");}
Page({
  timer:null as ReturnType<typeof setTimeout>|null,
  identityCache:null as SupportIdentityCache|null,
  viewEpoch:0,readGeneration:0,readPending:false,lastToken:"",lastRevision:-1,
  authorityChecked:false,accessBlocked:false,failures:0,visibleLimit:30,
  gesture:null as {id:string;x:number;y:number}|null,
  suppressTapUntil:0,
  data:{chromeStyle:currentChromeStyle(),items:[] as any[],nextCursor:null as string|null,loading:true,loadingMore:false,error:"",navigating:false,pageAlive:true,visible:false,coreReady:false,swipedId:"",removingId:""},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){
    this.stopPolling();
    this.viewEpoch++;
    const token=getApp<IAppOption>().globalData.sessionToken, revision=commerceContextRevision();
    const sameOwner=token===this.lastToken&&revision===this.lastRevision;
    if(!sameOwner){this.identityCache?.reset();this.visibleLimit=30;}
    this.lastToken=token;this.lastRevision=revision;
    this.authorityChecked=false;this.accessBlocked=false;this.failures=0;
    this.data.pageAlive=true;this.data.visible=true;
    this.setData({navigating:false,coreReady:false,swipedId:"",removingId:"",loading:!sameOwner||!this.data.items.length,
      ...(!sameOwner?{items:[],nextCursor:null}:{}),error:""});
    return this.load();
  },
  onHide(){
    this.data.visible=false;this.data.coreReady=false;this.viewEpoch++;this.readPending=false;
    this.gesture=null;this.suppressTapUntil=0;
    this.setData({loadingMore:false,swipedId:"",removingId:""});
    cancelPageReads(this);this.stopPolling();
  },
  onUnload(){this.onHide();this.data.pageAlive=false;},
  current(epoch:number,token:string){return this.data.pageAlive&&this.data.visible&&epoch===this.viewEpoch&&token===this.lastToken&&
    token===getApp<IAppOption>().globalData.sessionToken&&this.lastRevision===commerceContextRevision();},
  canOpen(){return this.data.coreReady&&this.current(this.viewEpoch,this.lastToken)&&!this.data.navigating&&!this.data.removingId;},
  schedulePoll(retryMore=false){
    this.stopPolling();
    if(!this.accessBlocked&&this.current(this.viewEpoch,this.lastToken))
      this.timer=setTimeout(()=>void (retryMore?this.loadMore():this.load()),this.failures?12000:6000);
  },
  stopPolling(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;},
  normalize(items:any[]){
    if(!this.identityCache)this.identityCache=new SupportIdentityCache();
    const cache=this.identityCache,epoch=this.viewEpoch,token=this.lastToken;
    const changed=()=>{if(this.current(epoch,token)&&this.identityCache===cache)this.refreshAvatars();};
    return items.map(item=>{
      const {member,...safe}=item as {member?:SupportSender;[key:string]:any};
      cache.accept(member,changed,true);
      const identityKey=member?.key||"";
      const statusLabel=item.status==="human_active"?(item.assignedToMe?"我在接待":item.handlerDisplayName?`${item.handlerDisplayName} 接待中`:"其他客服接待中"):(labels[item.status]||item.status);
      return {...safe,identityKey,memberAvatar:cache.avatar(identityKey),memberBadge:cache.badge(identityKey),memberBadgeLabel:identityLabel(cache.badge(identityKey)),
        memberDisplayName:member?.displayName||item.memberDisplayName||"CISME 会员",lastMessagePreview:preview(item.lastMessage),statusLabel,
        unreadLabel:item.teamUnreadCount>99?"99+":String(item.teamUnreadCount||""),timeLabel:new Date(item.updatedAt).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})};
    });
  },
  refreshAvatars(){const cache=this.identityCache;if(!cache)return;
    this.setData({items:this.data.items.map(item=>({...item,memberAvatar:cache.avatar(item.identityKey),memberBadge:cache.badge(item.identityKey),memberBadgeLabel:identityLabel(cache.badge(item.identityKey))}))});},
  onAvatarError(event:WechatMiniprogram.TouchEvent){const key=String(event.currentTarget.dataset.key||"");if(!key)return;this.identityCache?.fail(key);this.refreshAvatars();},
  failRead(error:unknown){
    if([401,403,404].includes((error as {status?:number})?.status??0)){
      this.accessBlocked=true;
      this.identityCache?.reset();
      this.setData({items:[],nextCursor:null,swipedId:"",coreReady:false,error:"客服访问权限已变化，请返回管理中心。"});
      return;
    }
    this.failures++;
    this.setData({coreReady:false,swipedId:"",error:"会话暂时无法更新，恢复连接后会自动重试。"});
  },
  async load(){
    const epoch=this.viewEpoch,token=this.lastToken,generation=this.readGeneration;
    const current=()=>this.current(epoch,token)&&generation===this.readGeneration;
    if(this.accessBlocked||!this.data.visible)return;
    if(!this.current(epoch,token)){this.failRead({status:401});this.stopPolling();return;}
    if(this.readPending||this.data.loadingMore||this.data.removingId){this.schedulePoll();return;}
    this.readPending=true;
    try{
      if(!token){requireMemberAccess();throw {status:401};}
      if(!this.authorityChecked){
        const authority=await authorityProjection(this);
        if(!current())return;
        if(authority.version!==1||!authority.managementAvailable||!hasCapability(authority,"support.read"))throw {status:403};
        this.authorityChecked=true;
      }
      const items:any[]=[];
      const seen=new Set<string>();
      let remaining=this.visibleLimit;
      let cursor:string|null=null;
      do {
        const limit=Math.min(100,remaining);
        const page:QueuePage=await pageRead<QueuePage>(this,{
          path:`/v1/management/support/conversations?limit=${limit}${cursor?'&cursor='+encodeURIComponent(cursor):''}`,cacheTags:["support"]});
        if(!current())return;
        for(const item of page.items||[])if(!seen.has(item.id)){seen.add(item.id);items.push(item);}
        remaining-=limit;
        if(!page.nextCursor||cursor===page.nextCursor){cursor=null;break;}
        cursor=page.nextCursor;
      }while(remaining>0);
      this.failures=0;
      this.setData({items:this.normalize(items),nextCursor:cursor,coreReady:true,error:"",
        swipedId:seen.has(this.data.swipedId)?this.data.swipedId:""});
    }catch(error){if(current())this.failRead(error);}
    finally{if(this.data.visible&&epoch===this.viewEpoch&&generation===this.readGeneration){
      if(!current())this.failRead({status:401});
      this.readPending=false;this.setData({loading:false});this.schedulePoll();
    }}
  },
  async loadMore(){
    const cursor=this.data.nextCursor;
    if(!this.canOpen()||this.readPending||this.data.loadingMore||cursor===null)return;
    const epoch=this.viewEpoch,token=this.lastToken,generation=this.readGeneration;
    const current=()=>this.current(epoch,token)&&generation===this.readGeneration;
    let retryMore=false;
    this.setData({loadingMore:true});
    try{
      const result=await pageRead<QueuePage>(this,{path:`/v1/management/support/conversations?limit=30&cursor=${encodeURIComponent(cursor)}`,cacheTags:["support"]});
      if(!current()||cursor!==this.data.nextCursor)return;
      const seen=new Set(this.data.items.map(item=>item.id));
      const added=this.normalize(result.items||[]).filter((item:{id:string})=>{if(seen.has(item.id))return false;seen.add(item.id);return true;});
      const items=[...this.data.items,...added];
      this.visibleLimit=Math.max(this.visibleLimit,items.length);
      this.failures=0;
      this.setData({items,nextCursor:result.nextCursor??null,error:""});
    }catch(error){if(current()){
      if([401,403,404].includes((error as {status?:number})?.status??0))this.failRead(error);
      else{this.failures++;retryMore=true;this.setData({error:"更多会话暂时无法加载，会自动重试。"});}
    }}finally{if(this.data.visible&&epoch===this.viewEpoch&&generation===this.readGeneration){
      if(!current())this.failRead({status:401});
      this.setData({loadingMore:false});this.schedulePoll(retryMore);
    }}
  },
  swipeStart(event:WechatMiniprogram.TouchEvent){
    const point=event.touches[0],id=String(event.currentTarget.dataset.id||"");
    this.gesture=this.canOpen()&&event.touches.length===1&&point?{id,x:point.clientX,y:point.clientY}:null;
  },
  swipeEnd(event:WechatMiniprogram.TouchEvent){
    const start=this.gesture,point=event.changedTouches[0];
    this.gesture=null;
    if(!this.canOpen()||!start||!point||start.id!==event.currentTarget.dataset.id)return;
    const x=point.clientX-start.x,y=point.clientY-start.y;
    if(Math.abs(x)<38||Math.abs(x)<Math.abs(y)*1.45)return;
    this.suppressTapUntil=Date.now()+350;
    this.setData({swipedId:x<0?start.id:""});
  },
  swipeCancel(){this.gesture=null;},
  revealActions(event:WechatMiniprogram.TouchEvent){
    if(!this.canOpen())return;
    this.suppressTapUntil=Date.now()+350;
    this.setData({swipedId:String(event.currentTarget.dataset.id||"")});
  },
  async dismiss(event:WechatMiniprogram.TouchEvent){
    if(!this.canOpen())return;
    const epoch=this.viewEpoch,token=this.lastToken,id=String(event.currentTarget.dataset.id||"");
    const row=this.data.items.find(item=>item.id===id);
    if(!row||this.data.swipedId!==id)return;
    this.setData({removingId:id});
    try{
      const choice=await wx.showModal({title:"从工作台删除此会话？",content:"只从你的工作台移除。会员的聊天记录会保留，有新消息时会话会重新出现。",
        cancelText:"取消",confirmText:"删除",confirmColor:"#8d3150"});
      if(!choice.confirm||!this.current(epoch,token))return;
      if(this.data.items.find(item=>item.id===id)?.version!==row.version){
        wx.showToast({title:"会话已更新，请重新确认",icon:"none"});return;
      }
      this.readGeneration++;
      this.readPending=false;
      cancelPageReads(this);
      this.setData({loadingMore:false});
      const receipt=await request<{conversationId:string;dismissed:boolean}>({path:`/v1/management/support/conversations/${encodeURIComponent(id)}/dismiss`,
        method:"POST",data:{expectedVersion:row.version},cacheTags:["support"]});
      if(!this.current(epoch,token))return;
      if(receipt.dismissed!==true||receipt.conversationId!==id)throw Error("Invalid dismissal receipt");
      this.setData({items:this.data.items.filter(item=>item.id!==id),swipedId:""});
    }catch(error){
      if(this.current(epoch,token)){
        const status=(error as {status?:number})?.status;
        if(status===401||status===403)this.failRead(error);
        else wx.showToast({title:status===409?"会话已更新，请重新确认":"移除结果待核对，会自动更新",icon:"none"});
      }
    }finally{
      if(this.current(epoch,token)){this.setData({removingId:"",swipedId:""});void this.load();}
    }
  },
  open(event:WechatMiniprogram.TouchEvent){
    if(!this.canOpen()||Date.now()<this.suppressTapUntil)return;
    if(this.data.swipedId){this.setData({swipedId:""});return;}
    const id=String(event.currentTarget.dataset.id||"");if(!this.data.items.some(item=>item.id===id))return;
    const epoch=this.viewEpoch,token=this.lastToken;this.setData({navigating:true});
    wx.navigateTo({url:`/pages/management-support-chat/index?id=${encodeURIComponent(id)}`,fail:()=>{if(this.current(epoch,token))this.setData({navigating:false});}});
  },
  back(){if(this.data.visible)wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
