// Preserve old shared links; all published stories use one detail page.
import {editorialIdentifier} from '../../services/editorial';
import {currentChromeStyle} from '../../services/layout';
Page({
  alive:true,opening:false,
  data:{id:'',chromeStyle:currentChromeStyle(),error:''},
  onLoad(query:Record<string,string|undefined>){this.alive=true;this.setData({id:query.id||''});this.open();},
  onUnload(){this.alive=false;},
  open(){
    if(!this.alive||this.opening)return;
    if(!editorialIdentifier(this.data.id)){this.setData({error:'帖子链接无效，请返回社区。'});return;}
    this.opening=true;this.setData({error:''});
    wx.redirectTo({url:`/pages/post/index?id=${encodeURIComponent(this.data.id)}&source=formal`,fail:()=>{if(this.alive)this.setData({error:'暂时无法打开帖子，请重试。'});},complete:()=>{this.opening=false;}});
  },
  back(){wx.navigateBack({fail:()=>wx.switchTab({url:'/pages/community/index'})});}
});
