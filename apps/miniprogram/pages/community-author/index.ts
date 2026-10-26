import { pageRead, cancelPageReads } from "../../services/page-requests";
import { commerceContextRevision } from "../../services/commerce-command-store";
import { request, resumeAuthentication, beginLegalRenewal } from "../../services/api";
import { currentChromeStyle } from "../../services/layout";
import { defaultMemberAvatar } from "../../services/member-avatar";
import { editorialIdentifier, editorialMediaSrc, publishedEditorialAuthor, followEditorialArticle, expiredEditorialRead } from "../../services/editorial";

type Author = { id:string; name:string; avatar:string; postCount:number; following:boolean; isMine:boolean };
type Story = { id:string; title:string; excerpt:string; coverId:string|null; likeCount:number; publishedAt:string;
  cover:string };
const message = (error:unknown,fallback:string)=>(error as {title?:string})?.title||fallback;

Page({
  readRevision:commerceContextRevision(),readVisible:true,
  lastSessionToken:"",
  data:{chromeStyle:currentChromeStyle(),editorialSource:false,articleContextId:"",authorId:"",author:null as Author|null,items:[] as Story[],nextCursor:null as string|null,
    loading:true,loadingMore:false,busy:false,navigating:false,error:"",invalidId:false,epoch:0},
  onLoad(query:Record<string,string|undefined>){
    this.lastSessionToken=getApp<IAppOption>().globalData.sessionToken;
    this.setData({authorId:String(query.id||""),editorialSource:query.source==="editorial"});
  },
  onShow(){
    this.readVisible=true;
    this.setData({loadingMore:false,busy:false});
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(token!==this.lastSessionToken||this.readRevision!==commerceContextRevision()){this.lastSessionToken=token;this.readRevision=commerceContextRevision();this.data.epoch+=1;
      this.setData({author:null,items:[],nextCursor:null,busy:false,navigating:false});}
    else if(this.data.author){this.setData({navigating:false});}
    void this.load();
  },
  onHide(){this.readVisible=false;this.data.epoch+=1;cancelPageReads(this);},
  onUnload(){this.onHide();},
  onResize(){this.setData({chromeStyle:currentChromeStyle()});},
  currentEditorial(epoch:number,token:string){return this.readVisible&&epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision();},
  recoverExpiredEditorialRead(epoch:number,token:string,error:unknown){
    if(!this.data.editorialSource||!this.readVisible||epoch!==this.data.epoch||!expiredEditorialRead(error,token))return false;
    this.data.epoch+=1;this.lastSessionToken="";this.readRevision=commerceContextRevision();
    this.setData({author:null,items:[],articleContextId:"",nextCursor:null,loading:false,loadingMore:false,busy:false,navigating:false,
      error:"登录状态已失效，请重新加载公开作者资料。"});return true;
  },
  async load(){
    if(!this.readVisible)return;
    const id=this.data.authorId;
    if(!/^[0-9a-f-]{36}$/i.test(id)||(this.data.editorialSource&&!editorialIdentifier(id))){this.setData({loading:false,invalidId:true,error:"作者主页链接无效，请返回社区。"});return;}
    const epoch=++this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.readRevision=commerceContextRevision();this.lastSessionToken=token;
    this.setData({loading:true,invalidId:false,error:"",items:[],nextCursor:null});
    try{
      if(this.data.editorialSource){
        this.setData({author:null,articleContextId:""});
        const result=await publishedEditorialAuthor(id,this);
        if(!this.currentEditorial(epoch,token))return;
        this.setData({author:{...result.author,avatar:defaultMemberAvatar},articleContextId:result.items[0]?.id||"",
          items:result.items.map(item=>({...item,coverId:null,cover:editorialMediaSrc(item.coverUrl)})),nextCursor:result.nextCursor,loading:false});return;
      }
      const [author,page]=await Promise.all([
        pageRead<Author>(this,{path:`/v1/ugc/authors/${id}`,authMode:"optional"}),
        pageRead<{items:Story[];nextCursor:string|null}>(this,{path:`/v1/ugc/posts?authorId=${id}&limit=20`,authMode:"optional"})
      ]);
      if(epoch!==this.data.epoch||(token!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision()))return;
      const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,"");
      this.setData({author,items:page.items.map(item=>({...item,
        cover:item.coverId&&origin?`${origin}/v1/ugc/media/${item.coverId}?variant=thumbnail`:""})),
        nextCursor:page.nextCursor,loading:false});
    }catch(error){if(this.recoverExpiredEditorialRead(epoch,token,error))return;if(epoch===this.data.epoch&&(!this.data.editorialSource||this.currentEditorial(epoch,token)))this.setData({loading:false,error:message(error,"作者资料暂时无法加载，请重试。")});}
  },
  async refreshAuthor(){
    if(this.data.editorialSource){await this.load();return;}
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    try{const author=await pageRead<Author>(this,{path:`/v1/ugc/authors/${this.data.authorId}`,authMode:"optional"});
      if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision())this.setData({author});
    }catch(error){if(this.recoverExpiredEditorialRead(epoch,token,error))return;if(epoch===this.data.epoch&&(!this.data.editorialSource||this.currentEditorial(epoch,token)))this.setData({author:null,items:[],nextCursor:null,
      error:message(error,"作者资料暂时无法加载，请重试。")});}
  },
  async onReachBottom(){
    const cursor=this.data.nextCursor,id=this.data.authorId;
    if(!cursor||this.data.loading||this.data.loadingMore)return;
    const epoch=this.data.epoch,token=getApp<IAppOption>().globalData.sessionToken;
    this.setData({loadingMore:true});
    try{
      if(this.data.editorialSource){const result=await publishedEditorialAuthor(id,this,cursor);
        if(!this.currentEditorial(epoch,token)||cursor!==this.data.nextCursor)return;
        const seen=new Set(this.data.items.map(item=>item.id));
        this.setData({items:[...this.data.items,...result.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;}).map(item=>({...item,coverId:null,cover:editorialMediaSrc(item.coverUrl)}))],nextCursor:result.nextCursor});return;}
      const page=await pageRead<{items:Story[];nextCursor:string|null}>(this,{path:`/v1/ugc/posts?authorId=${id}&limit=20&cursor=${encodeURIComponent(cursor)}`,authMode:"optional"});
      if(epoch!==this.data.epoch||(token!==getApp<IAppOption>().globalData.sessionToken||this.readRevision!==commerceContextRevision()))return;
      const origin=getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/$/,"");
      this.setData({items:[...this.data.items,...page.items.map(item=>({...item,
        cover:item.coverId&&origin?`${origin}/v1/ugc/media/${item.coverId}?variant=thumbnail`:""}))],nextCursor:page.nextCursor});
    }catch(error){if(this.recoverExpiredEditorialRead(epoch,token,error))return;if(epoch===this.data.epoch&&(!this.data.editorialSource||this.currentEditorial(epoch,token)))this.setData({error:message(error,"更多故事暂时无法加载，请重试。")});}
    finally{if(epoch===this.data.epoch&&(!this.data.editorialSource||this.currentEditorial(epoch,token)))this.setData({loadingMore:false});}
  },
  async toggleFollow(){
    const author=this.data.author;if(!author||author.isMine||this.data.busy)return;
    const token=getApp<IAppOption>().globalData.sessionToken;
    if(!token){resumeAuthentication(`/pages/community-author/index?id=${author.id}${this.data.editorialSource?"&source=editorial":""}`);return;}
    const epoch=this.data.epoch,next=!author.following;
    this.setData({busy:true,error:""});
    try{
      if(this.data.editorialSource){if(!this.data.articleContextId)return;
        const result=await followEditorialArticle(this.data.articleContextId,next);
        if(result.authorId!==author.id)throw new Error("EDITORIAL_AUTHOR_MISMATCH");
        if(this.currentEditorial(epoch,token))this.setData({author:{...author,following:result.following}});return;}
      await request({path:`/v1/me/ugc/follows/${author.id}`,method:"PUT",data:{active:next}});
      if(epoch===this.data.epoch&&token===getApp<IAppOption>().globalData.sessionToken&&this.readRevision===commerceContextRevision())
        this.setData({author:{...author,following:next}});
    }catch(error){if(epoch===this.data.epoch&&(!this.data.editorialSource||this.currentEditorial(epoch,token))){
      if(this.data.editorialSource&&(error as {status?:number;code?:string}).status===409&&(error as {code?:string}).code==="CURRENT_LEGAL_CONSENT_REQUIRED")beginLegalRenewal(`/pages/community-author/index?id=${encodeURIComponent(author.id)}&source=editorial`);
      this.setData({error:message(error,"关注操作未完成，请重试。")});}}
    finally{if(epoch===this.data.epoch&&(!this.data.editorialSource||this.currentEditorial(epoch,token)))this.setData({busy:false});}
  },
  openPost(event:WechatMiniprogram.TouchEvent){
    if(this.data.navigating)return;
    const id=String(event.currentTarget.dataset.id||"");if(!/^[0-9a-f-]{36}$/i.test(id))return;
    this.setData({navigating:true});
    wx.navigateTo({url:this.data.editorialSource?`/pages/post/index?id=${id}&source=editorial`:`/pages/community-post/index?id=${id}`,fail:()=>this.setData({navigating:false})});
  },
  back(){wx.navigateBack({fail:()=>wx.switchTab({url:"/pages/community/index"})});}
});
