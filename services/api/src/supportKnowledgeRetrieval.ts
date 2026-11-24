import {createHash} from 'node:crypto';
import type {SupportHelpAction} from '@cisme/contracts';
import {DomainError} from '@cisme/domain';
import {supportHelpArticles} from './supportHelpArticles.js';
import {catalogAnswer} from './supportCatalogKnowledge.js';
import type {ApprovedKnowledgeSource,ModelSafeSupportProjection,SupportKnowledgeGrounding} from './supportAiBoundary.js';

const careGuideId='cisme.care-guide';
const supportPolicyIds=new Set(['cisme.support-policy','cisme.support-safety']);
const catalogId='cisme.catalog-live';
const actions=new Set<SupportHelpAction>(['orders','care-records','points','invite','my-community','settings','sharing-officer','shop','privacy']);
const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
const normalizeTerms=(terms:readonly string[])=>terms.map(normalize);
const searchable=supportHelpArticles.map(article=>({article,terms:normalizeTerms(article.terms)}));
const careTerms=/护理流程|护理顺序|四步护理|净澈|修护|精护|护理周期|怎么护理|护理怎么做|用过的产品|保存今日|记录护理|填写感受/;
const policyTerms=/你好|您好|谢谢|你是谁|你是人工|你是ai|人工|客服|接待时间|服务时间|不适|过敏|刺痛|疼痛|受伤|问诊|治疗|退款|扣款|改价|改积分/;
const catalogTerms=/商品|产品|商城|在售|库存|现货|缺货|有货|售罄|多少钱|怎么卖|价格|标价|定价|规格|容量|毫升|卖哪些|都卖什么|净润|净屑|小紫瓶|洗发水|洗发露|精华|套组/;
const claimedAction=/(?:我|客服|系统)?已(?:经)?(?:为(?:您|你)|帮(?:您|你))?(?:提交|申请|完成|办理|批准|处理|发起|执行|核实|查询|通知|安排|开启|转接|接入|修改).{0,12}(?:退款|售后|订单|积分|人工|付款|支付|资格)|(?:退款|退货|订单|积分|人工申请|人工客服).{0,6}已(?:经)?(?:到账|退回|批准|排队|完成|提交|接入|修改)|已(?:经)?(?:退款|退回|转人工|排队|下单|改价)|(?:您|你)的(?:订单|退款|物流|积分).{0,12}(?:正在|已经|已|余额|是)/u;

export function supportQuestionText(conversation:ModelSafeSupportProjection){
  return conversation.question?.body??[...conversation.messages].reverse().find(row=>row.senderType==='user')?.body??'';
}

export function publicCatalogQuestion(conversation:ModelSafeSupportProjection){
  const query=normalize(supportQuestionText(conversation));
  return !/退款|退货|运费|扣款|积分余额/.test(query)&&catalogTerms.test(query);
}

export function approvedSupportArticles():ApprovedKnowledgeSource[]{
  return supportHelpArticles.map(({id,version,title,content})=>({id,version,title,content,approved:true,
    sha256:createHash('sha256').update(content).digest('hex')}));
}

function rank(question:string){
  return searchable.map(({article,terms})=>{
    const matches=terms.filter(term=>term.length>=2&&question.includes(term));
    const score=matches.length ? Math.max(...matches.map(term=>term.length))*3+matches.length : 0;
    return {article,score};
  }).filter(result=>result.score>0).sort((a,b)=>b.score-a.score).slice(0,3).map(result=>result.article);
}

function unsupported(){
  return new DomainError('SUPPORT_AI_UNGROUNDED','目前没有足够资料确认这件事，可申请人工继续核对',409);
}

/** The model selects a relevant offered guide. Procedural facts and entry
 * links come from the local reviewed article, never a model-supplied route. */
export const supportKnowledgeGrounding:SupportKnowledgeGrounding={
  select(conversation,sources){
    const question=normalize(supportQuestionText(conversation));
    const matched=new Set(rank(question).map(article=>article.id));
    return sources.filter(source=>matched.has(source.id)||supportPolicyIds.has(source.id)||
      source.id===careGuideId&&careTerms.test(question)||source.id===catalogId&&publicCatalogQuestion(conversation));
  },
  refine(suggestion,conversation,knowledge){
    if (suggestion.route==='human_followup') return suggestion;
    if(suggestion.handoffReason){
      return {...suggestion,text:'目前没有足够资料确认这件事，需要人工核对。'};
    }
    if (suggestion.route==='clarify'){
      return {...suggestion,text:'你是在补充之前申请人工的问题，还是有新的使用问题？'};
    }
    const cited = new Set(suggestion.citations.map(({sourceId,version})=>`${sourceId}@${version}`));
    const question=supportQuestionText(conversation);
    const catalog=knowledge.find(source=>source.id===catalogId&&cited.has(`${source.id}@${source.version}`));
    if(catalog&&suggestion.confidence>=0.75){
      const text=catalogAnswer(catalog,question);
      if(text)return {...suggestion,text,citations:[{sourceId:catalog.id,version:catalog.version}]};
    }
    const related=rank(normalize(question));
    const humanArticles=suggestion.route==='mixed'&&conversation.humanRequest?.anchorQuestion
      ?new Set(rank(normalize(conversation.humanRequest.anchorQuestion)).map(item=>item.id)):undefined;
    const article=related.find(candidate=>!humanArticles?.has(candidate.id)&&cited.has(`${candidate.id}@${candidate.version}`));
    if(article&&suggestion.confidence>=0.75){
      return {...suggestion,text:article.content,citations:[{sourceId:article.id,version:article.version}]};
    }
    const substantive=knowledge.some(source=>cited.has(`${source.id}@${source.version}`)&&
      (source.id===careGuideId||source.id===catalogId&&source.content.includes('\n{"available":true,')));
    if(suggestion.confidence<0.5||!substantive&&!policyTerms.test(normalize(question)))throw unsupported();
    // A valid source identifier does not turn generated text into an actual operation.
    if(claimedAction.test(suggestion.text))throw unsupported();
    return suggestion;
  }
};

/** Known public destinations are optional on saved AI messages. The stable
 * short text is persisted with the response and its source version is audited. */
export function supportGuideForReply(body:string):{knowledgeTitle?:string;helpAction?:SupportHelpAction}{
  const article=supportHelpArticles.find(article=>body===article.content||
    body.startsWith(article.content+'\n之前申请人工的问题'));
  if(!article)return {};
  const action=article.action as SupportHelpAction|undefined;
  return {knowledgeTitle:article.title,...(action&&actions.has(action)?{helpAction:action}:{})};
}
