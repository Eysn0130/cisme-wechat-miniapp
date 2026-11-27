import { dismissNativeKeyboardOnTap } from "../../services/native-keyboard";
import {currentChromeStyle} from '../../services/layout';
import {requireMemberAccess} from '../../services/api';
import {cancelPageReads} from '../../services/page-requests';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {localMemberAvatar} from '../../services/member-avatar';
import {sectionTabValue} from '../../services/section-tabs';
import {changeCommunityPost,managedCommunityPosts,type ManagedCommunityPost,type PostPlacement} from '../../services/community-management';

type Row=ManagedCommunityPost&{avatarSrc:string;coverSrc:string;dateLabel:string;displayTitle:string;excerpt:string};
const route='/pages/management-community/index';
function owner(){const g=getApp<IAppOption>().globalData;return JSON.stringify([g.sessionToken,g.apiBaseUrl,commerceContextRevision(),g.cloudFunction?.env,g.cloudFunction?.name]);}
Page({
  dismissNativeKeyboardOnTap,
  alive:true,visible:false,readEpoch:0,actionEpoch:0,readOwner:'',
  data:{chromeStyle:currentChromeStyle(),tab:'recommend' as PostPlacement,qInput:'',q:'',rows:[] as Row[],total:null as number|null,
    nextCursor:null as string|null,loading:false,loadingMore:false,ready:false,busyId:'',error:'',denied:false,detail:null as Row|null},
  onShow(){this.alive=true;this.visible=true;void this.load();},
  onHide(){this.visible=false;this.readEpoch++;this.actionEpoch++;cancelPageReads(this);this.setData({rows:[],total:null,detail:null,nextCursor:null,ready:false,busyId:'',loading:false,loadingMore:false,error:''});},
  onUnload(){this.onHide();this.alive=false;},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  current(epoch:number,identity:string){return this.alive&&this.visible&&epoch===this.readEpoch&&identity===owner();},
  discardChangedOwner(identity:string){if(!this.alive||!this.visible||identity===owner()||this.readOwner!==identity)return;
    this.readEpoch++;this.actionEpoch++;this.readOwner='';cancelPageReads(this);
    this.setData({rows:[],total:null,detail:null,nextCursor:null,ready:false,busyId:'',loading:false,loadingMore:false,error:'登录状态已变化，请重新进入'});},
  async load(append=false){
    if(!this.visible||!this.alive||this.data.busyId)return;
    if(!getApp<IAppOption>().globalData.sessionToken){this.onHide();requireMemberAccess(route);return;}
    const more=append===true;if(more&&(!this.data.nextCursor||this.data.loading||this.data.loadingMore))return;
    const identity=owner(),sameOwner=this.readOwner===identity;this.readOwner=identity;
    cancelPageReads(this);const epoch=++this.readEpoch;
    this.setData({loading:!more,loadingMore:more,error:'',denied:false,...(!sameOwner?{rows:[],total:null,nextCursor:null,detail:null,ready:false}:{})});
    try{
      const page=await managedCommunityPosts(this,this.data.tab,this.data.q,more?this.data.nextCursor:null);
      if(!this.current(epoch,identity)){this.discardChangedOwner(identity);return;}
      const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,'');
      const rows=await Promise.all(page.items.map(async row=>({...row,avatar:'',avatarSrc:await localMemberAvatar(row.avatar,row.avatarRevision),
        coverSrc:row.coverId&&row.state==='published'?`${origin}/v1/ugc/media/${row.coverId}?variant=thumbnail`:'',
        dateLabel:new Date(row.publishedAt).toLocaleDateString('zh-CN'),displayTitle:row.title||row.body.slice(0,32)||'图片帖子',excerpt:row.body.slice(0,100)})));
      if(!this.current(epoch,identity)){this.discardChangedOwner(identity);return;}
      const unique=new Map((more?this.data.rows:[]).map(row=>[row.id,row]));for(const row of rows)unique.set(row.id,row);
      this.setData({rows:[...unique.values()],total:page.matchingTotal,nextCursor:page.nextCursor,ready:true,loading:false,loadingMore:false});
    }catch(error){
      if(!this.current(epoch,identity)){this.discardChangedOwner(identity);return;}
      const denied=Number((error as {status?:number})?.status)===403;
      this.setData({loading:false,loadingMore:false,denied,error:denied?'当前账号没有社区管理权限':(error as {title?:string})?.title||'帖子暂时无法读取，请重试',
        ...(denied?{rows:[],total:null,nextCursor:null,detail:null,ready:false}:{})});
    }
  },
  selectTab(event:WechatMiniprogram.TouchEvent){
    const tab=sectionTabValue(event,'state');if(this.data.busyId||!['recommend','featured','hidden'].includes(tab)||tab===this.data.tab)return;
    this.setData({tab:tab as PostPlacement,rows:[],total:null,nextCursor:null,detail:null,ready:false});void this.load();
  },
  inputSearch(event:WechatMiniprogram.Input){this.setData({qInput:event.detail.value.slice(0,80)});},
  search(){if(this.data.busyId)return;this.setData({q:this.data.qInput.trim(),rows:[],total:null,nextCursor:null,ready:false,detail:null});void this.load();},
  refresh(){void this.load();},onReachBottom(){void this.load(true);},
  async onPullDownRefresh(){try{await this.load();}finally{wx.stopPullDownRefresh();}},
  openDetail(event:WechatMiniprogram.TouchEvent){if(this.readOwner!==owner()){this.discardChangedOwner(this.readOwner);return;}if(this.data.busyId||this.data.denied)return;const row=this.data.rows.find(r=>r.id===event.currentTarget.dataset.id);if(row)this.setData({detail:row});},
  openEditorialComments(){if(!this.visible||!this.data.ready||this.data.busyId||this.data.denied||this.readOwner!==owner())return;wx.navigateTo({url:'/pages/community-review/index?source=editorial'});},
  openGovernance(){if(!this.visible||this.data.busyId||this.data.denied||this.readOwner!==owner())return;wx.navigateTo({url:"/pages/community-review/index?source=moderation"});},
  closeDetail(){if(!this.data.busyId)this.setData({detail:null});},hold(){},
  openOriginal(){const row=this.data.detail;if(!row||row.state!=='published'||this.data.busyId||this.readOwner!==owner())return;
    wx.navigateTo({url:`/pages/post/index?id=${row.id}&source=formal`});},
  async act(event:WechatMiniprogram.TouchEvent){
    if(this.readOwner!==owner()){this.discardChangedOwner(this.readOwner);return;}
    if(this.data.busyId||this.data.loading||!this.visible||this.data.denied||this.readOwner!==owner())return;
    const row=this.data.rows.find(r=>r.id===event.currentTarget.dataset.id),action=String(event.currentTarget.dataset.action||'');
    if(!row||!['featured','recommend','hide','delete'].includes(action)||row.state==='hidden'&&action!=='delete')return;
    const identity=owner(),epoch=++this.actionEpoch,current=()=>this.alive&&this.visible&&epoch===this.actionEpoch&&identity===owner();
    this.setData({busyId:row.id,error:''});
    try{
      if(action==='hide'){
        const answer=await wx.showModal({title:'下架并撤回相关奖励？',editable:true,
          placeholderText:'填写下架原因，作者可见',confirmText:'下架',confirmColor:'#a8324a'});
        if(!answer.confirm||!current())return;
        const reason = (answer.content ?? '').trim();
        if (reason.length < 4 || reason.length > 500) {
          wx.showToast({title:'请填写 4–500 字的下架原因',icon:'none'});
          return;
        }
        await changeCommunityPost(row,'hide',reason);
      }else{
        if(action==='delete'){
          const answer=await wx.showModal({title:'删除这篇帖子？',
            content:'帖子及评论将不再展示，相关奖励按规则撤回。删除后无法恢复。',
            confirmText:'删除',confirmColor:'#a8324a'});
          if(!answer.confirm||!current())return;
        }
        await changeCommunityPost(row,action as 'featured'|'recommend'|'delete');
      }
      if(!current())return;
      this.setData({busyId:'',detail:null,rows:this.data.rows.filter(r=>r.id!==row.id),total:this.data.total===null?null:Math.max(0,this.data.total-1)});
      wx.showToast({title:action==='featured'?'已移入精选':action==='recommend'?'已移回推荐':action==='hide'?'已下架':'已删除',icon:'success'});
      await this.load();
    }catch(error){
      if(!current())return;
      const status=Number((error as {status?:number})?.status);this.setData({busyId:''});
      if(status===403){await this.load();if(current()&&!this.data.denied)this.setData({error:(error as {title?:string})?.title||'当前操作未获允许'});}
      else if(status===404||status===409){await this.load();if(current())this.setData({error:'帖子已变化，已刷新列表，请重新核对'});}
      else this.setData({error:(error as {title?:string})?.title||'结果暂未确认，请刷新核对后再操作'});
    }finally{this.discardChangedOwner(identity);if(current())this.setData({busyId:''});}
  },
  back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/profile/index'})});}
});
