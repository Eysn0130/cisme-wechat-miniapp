import {requireMemberAccess} from './api';

const destinations = {
  orders:{label:'查看订单',url:'/pages/orders/index'},
  'care-records':{label:'打开护理记录',url:'/pages/records/index'},
  points:{label:'查看积分',url:'/pages/points/index'},
  invite:{label:'邀请好友',url:'/pages/invite/index'},
  'my-community':{label:'打开我的社区',url:'/pages/community-author/index?mine=1'},
  settings:{label:'打开设置',url:'/pages/settings/index'},
  'sharing-officer':{label:'打开分享官',url:'/pages/sharing-officer/index'},
  shop:{label:'进入商城',url:'/pages/shop/index'},
  privacy:{label:'查看数据与账号权利',url:'/pages/privacy-rights/index'}
} as const;

export function supportHelpLabel(value:unknown):string {
  return typeof value==='string'&&Object.prototype.hasOwnProperty.call(destinations,value)
    ?destinations[value as keyof typeof destinations].label:'';
}

export function openSupportHelp(value:unknown,completed:()=>void):void {
  if(!supportHelpLabel(value)){completed();return;}
  const key=value as keyof typeof destinations,destination=destinations[key];
  if(!requireMemberAccess(destination.url)){completed();return;}
  const options={url:destination.url,complete:completed,fail:(error:WechatMiniprogram.GeneralCallbackResult)=>{
    if(!error.errMsg?.includes('cancel'))wx.showToast({title:'页面暂时无法打开',icon:'none'});
  }};
  if(key==='shop')wx.switchTab(options);
  else wx.navigateTo(options);
}
