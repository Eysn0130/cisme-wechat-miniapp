import{sectionTabs,type SectionTab}from'../../services/section-tabs';
import{shouldReduceMotion}from'../../services/layout';
Component({
 options:{virtualHost:true},
 properties:{items:{type:Array,value:[] as unknown[]},value:{type:String,value:''},itemKey:{type:String,value:'id'},label:{type:String,value:'页面分类'},disabled:{type:Boolean,value:false},reselect:{type:Boolean,value:false}},
 data:{tabs:[] as SectionTab[],scrollTarget:'',reducedMotion:false},
 observers:{'items,value,itemKey':function(){this.refreshTabs();}},
 lifetimes:{attached(){this.setData({reducedMotion:shouldReduceMotion()});this.refreshTabs();}},
 methods:{
  refreshTabs(){const tabs=sectionTabs(this.properties.items,this.properties.value,this.properties.itemKey),active=tabs.find(t=>t.selected);this.setData({tabs,scrollTarget:active?.domId??''});},
  select(event:WechatMiniprogram.TouchEvent){const tab=this.data.tabs[Number(event.currentTarget.dataset.index)];if(this.properties.disabled||!tab||tab.disabled||tab.selected&&!this.properties.reselect)return;this.triggerEvent('change',{value:tab.id});}
 }
});
