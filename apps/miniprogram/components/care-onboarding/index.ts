import {birthdayPicker,birthdayMonthColumn,selectedBirthday} from '../../services/member-birthday';
import {cancelPageReads} from '../../services/page-requests';
import {currentChromeStyle,shouldReduceMotion} from '../../services/layout';
import {commerceContextRevision} from '../../services/commerce-command-store';
import {clientOperationKey} from '../../services/orders';
import {readCareSurvey,saveCareSurvey,emptyCareAnswers,toggleCareOption,selectedCareOption,withoutSensitiveAnswers,nextCareQuestion,
  type CareQuestion,type CareAnswers,type CareHealthChoice,type CareSave,type CareProfile} from '../../services/care-onboarding';

type Owner={token:string;context:number;alive:boolean;visible:boolean;attempt:number};
type Pending={body:CareSave;key:string;complete:boolean;consent:boolean};
const owners=new WeakMap<object,Owner>(),pending=new WeakMap<object,Pending>();
function current(component:object,attempt?:number){const o=owners.get(component);return Boolean(o?.alive&&o.visible&&o.token===getApp<IAppOption>().globalData.sessionToken
  &&o.context===commerceContextRevision()&&(attempt===undefined||o.attempt===attempt));}
const initial={loading:true,ready:false,busy:false,unknown:false,reloadNeeded:false,error:'',questionnaireVersion:'',questions:[] as CareQuestion[],answers:{} as CareAnswers,
  ...birthdayPicker(),birthdayLocked:false,birthdaySupported:false,index:0,questionNumber:1,question:null as CareQuestion|null,questionFrames:[] as CareQuestion[],options:[] as Array<{value:string;label:string;selected:boolean}>,profileVersion:0,
  completed:false,forced:false,healthChoice:'unasked' as CareHealthChoice,consentMode:false,consentVersion:'',consentText:'',canAdvance:false,selectionLabel:'',scrollTop:0};
Component({
  properties:{required:{type:Boolean,value:false}},
  data:{...initial,chromeStyle:currentChromeStyle(),reducedMotion:shouldReduceMotion()},
  lifetimes:{
    attached(){owners.set(this,{token:getApp<IAppOption>().globalData.sessionToken,context:commerceContextRevision(),alive:true,visible:true,attempt:0});void this.load();},
    detached(){const o=owners.get(this);if(o){o.alive=false;o.attempt++;}cancelPageReads(this);pending.delete(this);owners.delete(this);}
  },
  pageLifetimes:{
    hide(){const o=owners.get(this);if(o){o.visible=false;o.attempt++;}cancelPageReads(this);if(this.data.busy)this.setData({busy:false,unknown:true});},
    show(){const o=owners.get(this);if(!o)return;
      if(o.token!==getApp<IAppOption>().globalData.sessionToken||o.context!==commerceContextRevision()){
        pending.delete(this);this.setData({...initial});o.token=getApp<IAppOption>().globalData.sessionToken;o.context=commerceContextRevision();o.attempt++;
      }
      o.visible=true;if(!this.data.ready)void this.load();}
  },
  methods:{
    stopPropagation(){},
    close(){if(this.data.forced||this.properties.required||this.data.busy||this.data.unknown)return;this.triggerEvent('close');},
    async load(){
      const o=owners.get(this);if(!o||!current(this))return;const attempt=++o.attempt;
      this.setData({loading:true,error:'',reloadNeeded:false});
      try{
        const result=await readCareSurvey(this);if(!current(this,attempt))return;
        this.setData({ready:true,loading:false,questionnaireVersion:result.questionnaireVersion,questions:result.questions,
          consentVersion:result.sensitiveConsent.version,consentText:result.sensitiveConsent.text,
          birthdaySupported:Object.prototype.hasOwnProperty.call(result,"birthdayMonthDay"),birthdayLocked:Boolean(result.birthdayMonthDay&&result.birthdayChangeAfter&&new Date(result.birthdayChangeAfter)>new Date()),...birthdayPicker(result.birthdayMonthDay)});
        const intent=pending.get(this);
        if(intent&&result.profile?.latestOperationId===intent.key){
          pending.delete(this);this.applyProfile(result.profile);this.setData({unknown:false});
          if(intent.complete)this.triggerEvent('complete');return;
        }
        if(intent){
          this.setData({unknown:true,error:'原保存结果尚未确认，请使用原操作重试，或重新核对后再填写。'});return;
        }
        this.applyProfile(result.profile,true);
      }catch{if(current(this,attempt))this.setData({loading:false,error:'护理档案暂时无法加载，请检查网络后重试。'});}
    },
    applyProfile(profile:CareProfile|null,initialLoad=false){
      this.setData({...birthdayPicker(profile?profile.birthdayMonthDay:this.data.birthday),profileVersion:profile?.version??0,answers:profile?.answers??emptyCareAnswers(this.data.questions),
        healthChoice:profile?.healthChoice??'unasked',completed:Boolean(profile?.completedAt),
        forced:this.properties.required||Boolean(profile?.required),consentMode:false,
        index:initialLoad&&profile?.completedAt&&!this.properties.required?0:(profile?.currentQuestion??1)-1});
      this.project();
    },
    project(){
      const q=this.data.questions[this.data.index];if(!q)return;
      const a=this.data.answers[q.id],chosen=a?.status==='answered'?a.values.length:a?.status==='undisclosed'?1:0;
      this.setData({question:q,questionFrames:[q],questionNumber:this.data.index+1,consentMode:q.sensitive&&this.data.healthChoice==='unasked',
        options:q.options.map(option=>({...option,selected:selectedCareOption(a,option.value)})),
        canAdvance:chosen>0||a?.status==='not_authorized',
        selectionLabel:q.multiple?`可多选，最多 ${q.max} 项${chosen?` · 已选 ${chosen} 项`:''}`:'单选',scrollTop:0});
    },
    choose(event:WechatMiniprogram.TouchEvent){
      if(!current(this)||this.data.busy||this.data.unknown||this.data.consentMode)return;
      const q=this.data.question;if(!q)return;const value=String(event.currentTarget.dataset.value??'');
      const next=toggleCareOption(q,this.data.answers[q.id],value);
      this.setData({answers:{...this.data.answers,[q.id]:next.answer},error:next.error});this.project();
    },
    birthdayColumn(event:{detail:{column:number;value:number}}){
      if(!current(this)||this.data.busy||this.data.unknown||this.data.birthdayLocked)return;
      const patch=birthdayMonthColumn(this.data.birthdayRanges,this.data.birthdayIndex,event.detail);if(patch)this.setData(patch);
    },
    chooseBirthday(event:{detail:{value:number[]}}){
      if(!current(this)||this.data.busy||this.data.unknown||this.data.birthdayLocked)return;
      const patch=selectedBirthday(event.detail.value);if(patch)this.setData(patch);
    },
    clearBirthday(){if(current(this)&&!this.data.busy&&!this.data.unknown)this.setData(birthdayPicker());},
    previous(){
      if(!current(this)||this.data.busy||this.data.unknown||this.data.index===0)return;
      this.setData({index:nextCareQuestion(this.data.questions,this.data.index,-1,this.data.healthChoice),error:''});this.project();
    },
    acceptSensitive(){void this.decideSensitive('granted');},
    declineSensitive(){void this.decideSensitive('declined');},
    async decideSensitive(choice:'granted'|'declined'){
      if(!current(this)||this.data.busy||this.data.unknown)return;
      const answers=choice==='declined'?withoutSensitiveAnswers(this.data.questions,this.data.answers):this.data.answers;
      const index=choice==='declined'&&this.data.question?.sensitive?nextCareQuestion(this.data.questions,this.data.index,1,choice):this.data.index;
      await this.submit({questionnaireVersion:this.data.questionnaireVersion,expectedVersion:this.data.profileVersion,currentQuestion:index+1,
        answers,consentChoice:choice,consentVersion:this.data.consentVersion},false,true);
    },
    openSensitiveChoice(){if(this.data.busy||this.data.unknown)return;this.setData({consentMode:true,error:''});},
    async next(){
      if(!current(this)||this.data.busy)return;
      if(this.data.unknown){await this.retrySave();return;}
      if(!this.data.canAdvance){this.setData({error:'请选择本题答案；个人情况可选择不愿透露或不愿回答。'});return;}
      const complete=this.data.index===this.data.questions.length-1;
      const index=complete?this.data.index:nextCareQuestion(this.data.questions,this.data.index,1,this.data.healthChoice);
      await this.submit({questionnaireVersion:this.data.questionnaireVersion,expectedVersion:this.data.profileVersion,currentQuestion:index+1,answers:this.data.answers},complete,false);
    },
    async retrySave(){const intent=pending.get(this);if(intent&&!this.data.busy)await this.send(intent);},
    async submit(body:CareSave,complete:boolean,consent:boolean){
      const command={...body,...(!this.data.completed&&this.data.birthdaySupported?{birthdayMonthDay:this.data.birthday||null}:{})};
      const intent={body:JSON.parse(JSON.stringify(command)) as CareSave,key:clientOperationKey('care-profile'),complete,consent};pending.set(this,intent);await this.send(intent);
    },
    async send(intent:Pending){
      const o=owners.get(this);if(!o||!current(this))return;const attempt=++o.attempt;
      this.setData({busy:true,error:''});
      try{
        const result=await saveCareSurvey(intent.body,intent.key,intent.complete,this.data.questions);
        if(!current(this,attempt))return;
        pending.delete(this);this.setData({unknown:false});this.applyProfile(result.profile);
        if(!result.current){this.setData({error:'档案已有更新，已显示最新记录，请核对后继续。'});return;}
        if(intent.complete){wx.showToast({title:'护理档案已保存',icon:'success'});this.triggerEvent('complete');}
      }catch(error){
        if(!current(this,attempt))return;
        const e=error as {status?:number;title?:string;code?:string};
        const definitive=typeof e.status==='number'&&e.status>=400&&e.status<500&&![408,429].includes(e.status);
        if(definitive){pending.delete(this);this.setData({unknown:false,reloadNeeded:e.code==='CARE_PROFILE_CHANGED',error:e.title||'答案未保存，请核对后重试。'});}
        else this.setData({unknown:true,error:'保存结果尚未确认，答案已保留。请重试原操作或核对最新档案。'});
      }finally{if(current(this,attempt))this.setData({busy:false});}
    }
  }
});
