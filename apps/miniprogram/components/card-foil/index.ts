import{shouldReduceMotion}from'../../services/layout';
Component({
 options:{virtualHost:true},
 properties:{tone:{type:String,value:'coupon'},active:{type:Boolean,value:false},x:{type:Number,value:50},y:{type:Number,value:50},intro:{type:Boolean,value:false},flash:{type:Boolean,value:false},reduced:{type:Boolean,value:false},quiet:{type:Boolean,value:false}},
 data:{visible:true,introActive:false,flashActive:false,lowMotion:false,shiftX:0,shiftY:0,angle:0},
 observers:{'x,y':function(x:number,y:number){const bounded=(v:number)=>Number.isFinite(v)?Math.max(0,Math.min(100,v)):50;this.setData({shiftX:Math.round((bounded(x)-50)*.7),shiftY:Math.round((bounded(y)-50)*.25),angle:Math.round((bounded(x)-50)*.06)});},flash:function(value:boolean){this.setData({flashActive:Boolean(value&&this.data.visible&&!this.data.lowMotion&&!this.properties.reduced),...(value?{introActive:false}:{})});}},
 lifetimes:{attached(){const lowMotion=shouldReduceMotion();this.setData({lowMotion,introActive:Boolean(this.properties.intro&&!lowMotion&&!this.properties.reduced)});}},
 methods:{finishSweep(){this.setData({introActive:false,flashActive:false});}},
 pageLifetimes:{hide(){this.setData({visible:false,introActive:false,flashActive:false});},show(){this.setData({visible:true});}}
});
