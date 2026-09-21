import { authorityProjection, hasCapability } from "../../services/authority";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { cancelPageReads, pageRead } from "../../services/page-requests";
import { currentChromeStyle } from "../../services/layout";

const labels:Record<string,string>={waiting_human:"待人工",human_active:"人工处理中",ai_active:"AI 处理中",resolved:"已解决"};
function preview(value:unknown):string{const text=Array.from(String(value||"").replace(/\s+/g," ").trim());return text.slice(0,48).join("")+(text.length>48?"…":"");}
Page({
  timer:null as ReturnType<typeof setInterval>|null,
  viewEpoch:0,listRequestSeq:0,expandedHistory:false,readPending:false,lastToken:"",lastRevision:-1,
  data:{chromeStyle:currentChromeStyle(),items:[] as any[],nextCursor:null as string|null,loading:true,refreshing:false,loadingMore:false,error:"",navigating:false,pageAlive:true,visible:false,coreReady:false},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  onShow(){this.data.pageAlive=true;this.data.visible=true;this.setData({navigating:false});return this.load();},
  onHide(){this.data.visible=false;this.data.coreReady=false;this.viewEpoch++;this.listRequestSeq++;this.readPending=false;cancelPageReads(this);this.stopPolling();},
  onUnload(){this.onHide();this.data.pageAlive=false;},
  current(epoch:number,token:string){return this.data.pageAlive&&this.data.visible&&epoch===this.viewEpoch&&token===this.lastToken&&
    token===getApp<IAppOption>().globalData.sessionToken&&this.lastRevision===commerceContextRevision();},
  canOpen(){return this.data.coreReady&&this.current(this.viewEpoch,this.lastToken)&&!this.data.navigating;},
  startPolling(){this.stopPolling();if(!this.data.visible||!this.data.coreReady||this.expandedHistory)return;
    this.timer=setInterval(()=>void this.load(true),6000);},
  stopPolling(){if(this.timer!==null)clearInterval(this.timer);this.timer=null;},
  normalize(items:any[]){return items.map(item=>({...item,initial:Array.from(String(item.memberDisplayName||"C"))[0]||"C",lastMessagePreview:preview(item.lastMessage),statusLabel:labels[item.status]||item.status,unreadLabel:item.teamUnreadCount>99?"99+":String(item.teamUnreadCount||""),timeLabel:new Date(item.updatedAt).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}));},
  failRead(error:unknown,pagination=false){
    if([401,403,404].includes((error as {status?:number})?.status??0)){
      this.stopPolling();this.setData({items:[],nextCursor:null,coreReady:false,error:"客服访问权限需重新核验，请重试。"});
    }else if(pagination)wx.showToast({title:"更多会话暂时无法加载，请重试",icon:"none"});
    else{this.stopPolling();this.setData({coreReady:false,error:"客服队列暂时无法同步，已显示内容仅供参考，请重试。"});}
  },
  async load(silent=false){
    if(!this.data.pageAlive||!this.data.visible)return;
    if(silent&&(!this.current(this.viewEpoch,this.lastToken)||!this.data.coreReady)){
      this.stopPolling();this.setData({items:[],nextCursor:null,coreReady:false,error:"身份已变化，请重新核验客服访问权限。"});return;
    }
    if(silent&&(this.readPending||this.data.loadingMore||this.expandedHistory))return;
    if(!silent){
      this.stopPolling();cancelPageReads(this);this.viewEpoch++;this.expandedHistory=false;
      const token=getApp<IAppOption>().globalData.sessionToken,revision=commerceContextRevision();
      if(token!==this.lastToken||revision!==this.lastRevision)this.setData({items:[],nextCursor:null});
      this.lastToken=token;this.lastRevision=revision;
      this.setData({coreReady:false,loading:this.data.items.length===0,refreshing:this.data.items.length>0,loadingMore:false,error:""});
    }
    const epoch=this.viewEpoch,token=this.lastToken,seq=++this.listRequestSeq;
    this.readPending=true;
    try{
      if(!token)throw {status:401};
      if(!silent){
        const authority=await authorityProjection(this);
        if(!this.current(epoch,token)||seq!==this.listRequestSeq)return;
        if(authority.version!==1||!authority.managementAvailable||!hasCapability(authority,"support.read"))throw {status:403};
      }
      const result=await pageRead<any>(this,{path:"/v1/management/support/conversations?limit=30",cacheTags:["support"]});
      if(!this.current(epoch,token)||seq!==this.listRequestSeq)return;
      this.setData({items:this.normalize(result.items||[]),nextCursor:result.nextCursor??null,coreReady:true,error:""});
    }catch(error){if(this.current(epoch,token)&&seq===this.listRequestSeq)this.failRead(error);}
    finally{if(this.data.pageAlive&&this.data.visible&&epoch===this.viewEpoch&&seq===this.listRequestSeq){
      if(!this.current(epoch,token))this.failRead({status:401});
      this.readPending=false;this.setData({loading:false,refreshing:false});if(!silent&&this.data.coreReady)this.startPolling();
    }}
  },
  async loadMore(){
    const cursor=this.data.nextCursor;
    if(!this.canOpen()||this.readPending||this.data.loadingMore||cursor===null)return;
    const epoch=this.viewEpoch,token=this.lastToken,seq=++this.listRequestSeq;
    this.setData({loadingMore:true});
    try{
      const result=await pageRead<any>(this,{path:`/v1/management/support/conversations?limit=30&cursor=${encodeURIComponent(cursor)}`,cacheTags:["support"]});
      if(!this.current(epoch,token)||seq!==this.listRequestSeq||cursor!==this.data.nextCursor)return;
      this.expandedHistory=true;this.stopPolling();
      const seen=new Set(this.data.items.map(item=>item.id));
      const added=this.normalize(result.items||[]).filter((item:{id:string})=>{if(seen.has(item.id))return false;seen.add(item.id);return true;});
      this.setData({items:[...this.data.items,...added],nextCursor:result.nextCursor??null});
    }catch(error){if(this.current(epoch,token)&&seq===this.listRequestSeq)this.failRead(error,true);}
    finally{if(this.data.pageAlive&&this.data.visible&&epoch===this.viewEpoch&&seq===this.listRequestSeq){
      if(!this.current(epoch,token))this.failRead({status:401});
      this.setData({loadingMore:false});
    }}
  },
  open(event:WechatMiniprogram.TouchEvent){
    if(!this.canOpen())return;const id=String(event.currentTarget.dataset.id||"");if(!this.data.items.some(item=>item.id===id))return;
    const epoch=this.viewEpoch,token=this.lastToken;this.setData({navigating:true});
    wx.navigateTo({url:`/pages/management-support-chat/index?id=${encodeURIComponent(id)}`,fail:()=>{if(this.current(epoch,token))this.setData({navigating:false});}});
  },
  retry(){void this.load();},
  back(){if(this.data.visible)wx.navigateBack({fail:()=>wx.redirectTo({url:"/pages/management/index"})});}
});
