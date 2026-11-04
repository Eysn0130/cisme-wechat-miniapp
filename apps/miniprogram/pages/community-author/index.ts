import { retainReadPresentation } from "../../services/read-presentation";
import { cancelPageReads } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { request, resumeAuthentication, beginLegalRenewal, requireMemberAccess } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { editorialIdentifier, followEditorialArticle, expiredEditorialRead } from "../../services/editorial";
import { readCommunityProfile, canEditCommunityBio, type CommunityAuthor } from "../../services/community-profile";
import { projectFeedCards, feedColumnPatch, type FeedCard } from "../../services/feed-projection";

const message=(error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;
const stories=new WeakMap<object,FeedCard[]>();

Page({
  readRevision:commerceContextRevision(),readVisible:true,lastSessionToken:"",bioAttempt:0,
  data:{chromeStyle:currentChromeStyle(),mine:false,authorId:"",author:null as CommunityAuthor|null,
    feedColumns:projectFeedCards([]),nextCursor:null as string|null,
    loading:true,loadingMore:false,busy:false,navigating:false,error:"",moreError:"",invalidId:false,epoch:0,
    bioOpen:false,bioDraft:"",bioBusy:false,bioError:"",bioVersion:0,bioConflict:false},
  onLoad(query:Record<string,string|undefined>){
    this.lastSessionToken=getApp<IAppOption>().globalData.sessionToken;
    this.setData({authorId:String(query.id||""),mine:query.mine==="1"});
  },
  onShow(){
    this.readVisible=true;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(token!==this.lastSessionToken||this.readRevision!==commerceContextRevision())this.clearProfile();
    if(this.data.mine&&!requireMemberAccess("/pages/community-author/index?mine=1")){this.setData({loading:false});return;}
    this.setData({loadingMore:false,busy:false,navigating:false});
    void this.load();
  },
  onHide(){this.readVisible=false;this.data.epoch+=1;this.bioAttempt+=1;cancelPageReads(this);this.setData({bioBusy:false});},
  onUnload(){this.onHide();stories.delete(this);},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  current(epoch:number,token:string){return this.readVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision();},
  clearProfile(){stories.delete(this);this.data.epoch+=1;this.setData({author:null,feedColumns:projectFeedCards([]),nextCursor:null,bioOpen:false,bioDraft:"",bioError:"",bioVersion:0,bioConflict:false,loadingMore:false,busy:false,bioBusy:false});},
  returnUrl(){return this.data.mine?"/pages/community-author/index?mine=1":`/pages/community-author/index?id=${encodeURIComponent(this.data.authorId)}`;},
  recoverExpiredRead(epoch:number,token:string,error:unknown){
    if(!this.readVisible||epoch!==this.data.epoch||!expiredEditorialRead(error,token))return false;
    this.clearProfile();this.lastSessionToken="";this.readRevision=commerceContextRevision();
    this.setData({loading:false,loadingMore:false,busy:false,navigating:false,error:"登录状态已失效，请重新加载作者资料。"});return true;
  },
  async load(){
    if(!this.readVisible)return;
    if(this.data.mine&&!requireMemberAccess(this.returnUrl()))return;
    const id=this.data.authorId;
    if(!this.data.mine&&!editorialIdentifier(id)){this.setData({loading:false,invalidId:true,error:"作者主页链接无效，请返回社区。"});return;}
    const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.readRevision=commerceContextRevision();this.lastSessionToken=token;
    const preserve=retainReadPresentation(this,`${this.data.mine}:${id}`)&&Boolean(this.data.author);
    if(!preserve)stories.delete(this);
    this.setData({loading:true,invalidId:false,error:"",moreError:"",...(!preserve?{author:null,feedColumns:projectFeedCards([]),nextCursor:null}:{})});
    try{
      const result=await readCommunityProfile(this,id,this.data.mine);
      if(!this.current(epoch,token))return;
      stories.set(this,result.items);
      this.setData({...feedColumnPatch(this.data.feedColumns,projectFeedCards(result.items)),author:result.author,nextCursor:result.nextCursor,loading:false,
        ...(!canEditCommunityBio(result.author)&&this.data.bioOpen?{bioOpen:false,bioDraft:"",bioError:"",bioVersion:0,bioConflict:false}:{})});
    }catch(error){
      if(this.recoverExpiredRead(epoch,token,error)||!this.current(epoch,token))return;
      // Revocation clears the projection. A temporary read failure can retain
      // the same actor's presentation; actions wait for a successful refresh.
      const status=(error as {status?:number})?.status;
      if(status===401||status===403||status===404||!preserve)this.clearProfile();
      this.setData({loading:false,error:message(error,"作者资料暂时无法加载，请重试。")});
    }
  },
  async onReachBottom(){
    const cursor=this.data.nextCursor;if(!cursor||this.data.loading||this.data.loadingMore||this.data.error)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({loadingMore:true,moreError:""});
    try{
      const result=await readCommunityProfile(this,this.data.authorId,this.data.mine,cursor);
      if(!this.current(epoch,token)||cursor!==this.data.nextCursor)return;
      const items=stories.get(this)||[],seen=new Set(items.map(item=>`${item.kind}:${item.id}`));
      const next=[...items,...result.items.filter(item=>{const key=`${item.kind}:${item.id}`;if(seen.has(key))return false;seen.add(key);return true;})];
      stories.set(this,next);this.setData({...feedColumnPatch(this.data.feedColumns,projectFeedCards(next)),nextCursor:result.nextCursor});
    }catch(error){if(this.recoverExpiredRead(epoch,token,error)||!this.current(epoch,token))return;
      if([401,403,404].includes((error as {status:number}).status)){this.clearProfile();this.setData({loading:false,error:message(error,"作者暂不可见。")});}
      else this.setData({moreError:message(error,"更多故事暂时无法加载，请重试。")});
    }finally{if(this.current(epoch,token))this.setData({loadingMore:false});}
  },
  async toggleFollow(){
    const author=this.data.author;if(this.data.loading||this.data.error||!author||author.isMine||!author.canFollow||this.data.busy)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token){resumeAuthentication(this.returnUrl());return;}
    const epoch=this.data.epoch,next=!author.following;this.setData({busy:true});
    try{
      const following=author.accountType==="official"?await request<{authorId:string;following:boolean}>({path:`/v1/me/follows/${author.id}`,method:"PUT",data:{active:next}}):author.followArticleId?(await followEditorialArticle(author.followArticleId,next)):
        await request<{following:boolean}>({path:`/v1/me/ugc/follows/${author.id}`,method:"PUT",data:{active:next}});
      if((author.accountType==="official"||author.followArticleId)&&(following as {authorId?:string}).authorId!==author.id)throw new Error("COMMUNITY_AUTHOR_MISMATCH");
      if(typeof following.following!=="boolean")throw new Error("COMMUNITY_FOLLOW_INVALID");
      if(this.current(epoch,token))this.setData({author:{...this.data.author!,following:following.following}});
    }catch(error){if(this.current(epoch,token)){
      if((error as {code?:string}).code==="CURRENT_LEGAL_CONSENT_REQUIRED")beginLegalRenewal(this.returnUrl());
      else wx.showToast({title:message(error,"关注操作未完成，请重试。"),icon:"none"});
    }}finally{if(this.current(epoch,token))this.setData({busy:false});}
  },
  openBio(){
    const author=this.data.author;if(!author||!canEditCommunityBio(author)||this.data.loading||this.data.error||this.data.bioBusy)return;
    this.setData({bioOpen:true,bioDraft:author.bio,bioVersion:author.bioRevision!,bioError:"",bioConflict:false});
  },
  editBio(event:{detail:{value:string}}){if(!this.data.bioBusy)this.setData({bioDraft:event.detail.value,bioError:""});},
  closeBio(){if(!this.data.bioBusy)this.setData({bioOpen:false,bioDraft:"",bioError:""});},
  async reloadBio(){
    if(this.data.bioBusy)return;
    await this.load();
    if(this.readVisible&&this.data.bioOpen&&this.data.author&&canEditCommunityBio(this.data.author)&&!this.data.error){
      this.setData({bioDraft:this.data.author.bio,bioVersion:this.data.author.bioRevision!,bioError:"",bioConflict:false});
    }
  },
  holdBio(){},
  async saveBio(){
    const author=this.data.author;if(!author||!canEditCommunityBio(author)||!this.data.bioOpen||this.data.bioBusy||this.data.loading||this.data.error||this.data.bioConflict)return;
    const bio=this.data.bioDraft.trim();if(Array.from(bio).length>120){this.setData({bioError:"简介最多120字。"});return;}
    if(bio===author.bio){this.closeBio();return;}
    const epoch=this.data.epoch,attempt=++this.bioAttempt,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({bioBusy:true,bioError:""});
    try{
      const result=await request<{bio:string;bioRevision:number}>({path:author.accountType==="official"?"/v1/management/community/official-profile":"/v1/me/community-profile",method:"PUT",data:{bio,expectedVersion:this.data.bioVersion}});
      if(!this.current(epoch,token)||attempt!==this.bioAttempt)return;
      if(result.bio!==bio||!Number.isSafeInteger(result.bioRevision)||result.bioRevision<=this.data.bioVersion)throw new Error("COMMUNITY_BIO_INVALID");
      this.setData({author:{...this.data.author!,bio:result.bio,bioRevision:result.bioRevision},bioOpen:false,bioDraft:"",bioBusy:false});
    }catch(error){if(this.current(epoch,token)&&attempt===this.bioAttempt){
      if((error as {code?:string}).code==="CURRENT_LEGAL_CONSENT_REQUIRED")beginLegalRenewal(this.returnUrl());
      this.setData({bioError:message(error,"暂时无法确认保存结果，请重试。"),bioConflict:(error as {code?:string}).code==="COMMUNITY_BIO_CHANGED"});
    }}finally{if(this.current(epoch,token)&&attempt===this.bioAttempt)this.setData({bioBusy:false});}
  },
  openSettings(){if(this.data.author?.isMine)this.navigate("/pages/settings/index?section=profile");},
  openActivity(){if(this.data.author?.isMine)this.navigate("/pages/community-activity/index");},
  openDrafts(){if(this.data.author?.isMine)this.navigate("/pages/community-compose/index");},
  navigate(url:string){
    if(this.data.navigating||this.data.bioBusy)return;
    this.setData({navigating:true});wx.navigateTo({url,fail:()=>{if(this.readVisible)this.setData({navigating:false});wx.showToast({title:"页面暂时无法打开，请重试",icon:"none"});}});
  },
  openPost(event:WechatMiniprogram.TouchEvent){
    const id=String(event.currentTarget.dataset.id||"");
    const item=this.data.feedColumns.flat().find(card=>card.id===id);
    if(!item||!editorialIdentifier(id))return;
    this.navigate(`${item.kind==="formal"?"/pages/community-post/index":"/pages/post/index"}?id=${encodeURIComponent(id)}${item.kind==="editorial"?"&source=editorial":""}`);
  },
  back(){if(this.data.bioOpen){this.closeBio();return;}wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/community/index"})});}
});
