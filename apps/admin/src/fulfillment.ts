/** Uses the existing authenticated operator channel. Permissions are always
 * rechecked by the API; a hidden button is never an authorization boundary. */
export function mountFulfillment(root:HTMLElement,api:(path:string,init?:RequestInit)=>Promise<any>,download:(path:string)=>Promise<Blob>){
  root.innerHTML=`<h2>订单履约中心</h2><p>只对已真实交寄的订单登记物流。Excel 用于拣货与核对，系统发货记录才是事实依据。</p>
    <label>物流状态<select data-state><option value="awaiting_dispatch">待发货</option><option value="shipped">已发货</option><option value="delivered">快递已签收</option><option value="exception">物流异常</option><option value="all">全部已支付</option></select></label>
    <label>精确订单号<input data-number maxlength="32"/></label><div class="actions"><button data-load>查询订单</button><button data-next disabled>下一页</button><button data-export>导出当前筛选 Excel</button></div>
    <p>导出含姓名、手机与地址，只限授权履约用途；下载前会记录操作员、时间、筛选条件和数量。请按团队个人信息规定妥善保管和删除本地文件。</p>
    <div data-orders></div><h3>登记单笔或批量物流</h3><p>从 Excel 复制 5 列，按顺序：订单号、快递公司代码、快递公司名称、运单号、实际交寄时间（ISO UTC，如 2026-09-22T10:00:00.000Z）。每次最多 25 行，不含表头。仅支持本单全部商品一次发货。</p>
    <textarea data-rows rows="5" maxlength="16000" aria-label="待登记物流行"></textarea>
    <label><input data-confirm type="checkbox"/>已核对订单、运单和实际交寄事实</label>
    <div class="actions"><button data-submit>确认登记物流</button><button data-new>开始另一批</button></div><p data-status role="status" aria-live="polite"></p>`;
  const q=<T extends HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
  let busy=false,cursor:string|null=null,filter='',key='',frozen='';
  const status=(text:string)=>{if(root.isConnected)q('[data-status]').textContent=text;};
  const lock=(value:boolean)=>{busy=value;root.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLTextAreaElement|HTMLSelectElement>('button,input,textarea,select').forEach(e=>e.disabled=value);q<HTMLButtonElement>('[data-next]').disabled=value||!cursor;};
  const filters=()=>new URLSearchParams({state:q<HTMLSelectElement>('[data-state]').value,orderNumber:q<HTMLInputElement>('[data-number]').value.trim()}).toString();
  async function load(next=false){if(busy)return;lock(true);status('正在核对订单…');try{
    const selected=filters();if(next&&selected!==filter)throw Error('筛选已改变，请重新查询。');
    const page=await api(`/v1/management/shipments?${selected}&limit=50${next&&cursor?`&before=${encodeURIComponent(cursor)}`:''}`);
    if(!root.isConnected)return;filter=selected;cursor=page.nextCursor;
    const area=q('[data-orders]');area.replaceChildren();
    for(const order of page.items){const row=document.createElement('p');row.textContent=`${order.orderNumber} · ${order.items} · ${order.logisticsState}${order.receiptConfirmedAt?' · 用户已确认收货':''}`;area.append(row);}
    status(page.items.length?`本页 ${page.items.length} 单${cursor?'，还有下一页':''}`:'当前筛选没有订单。');
  }catch(error){cursor=null;q('[data-orders]').replaceChildren();status((error as Error).message);}finally{if(root.isConnected)lock(false);}}
  q('[data-load]').onclick=()=>void load();q('[data-next]').onclick=()=>void load(true);
  q('[data-export]').onclick=async()=>{if(busy)return;lock(true);status('正在生成并审计导出…');try{
    const blob=await download(`/v1/management/shipments/export?${filters()}&limit=500`);
    if(!root.isConnected)return;
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='cisme-fulfillment.xlsx';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    status('已生成下载；本次导出审计已记录。');
  }catch(error){status((error as Error).message);}finally{if(root.isConnected)lock(false);}};
  q('[data-new]').onclick=()=>{if(busy)return;key='';frozen='';q<HTMLTextAreaElement>('[data-rows]').value='';q<HTMLInputElement>('[data-confirm]').checked=false;status('请填写下一批真实交寄信息。');};
  q('[data-submit]').onclick=async()=>{if(busy)return;
    const raw=q<HTMLTextAreaElement>('[data-rows]').value;
    if(!q<HTMLInputElement>('[data-confirm]').checked){status('请先核对并确认实际交寄事实。');return;}
    if(key&&raw!==frozen){status('上次请求仍使用原批次编号，请保留原行重试或先查订单结果，再开始另一批。');return;}
    key||=`ship-${crypto.randomUUID()}`;frozen=raw;lock(true);status('正在登记，结果将逐行显示…');
    try{const result=await api('/v1/management/shipments/import',{method:'POST',headers:{'idempotency-key':key},body:JSON.stringify({rows:frozen})});
      status(result.results.map((r:{orderId:string;status:string;code?:string})=>`${r.orderId}：${r.status==='accepted'?'已登记，微信同步独立处理':r.code}`).join('\n'));
    }catch(error){status(`结果待核对：${(error as Error).message}。可用相同行重试，系统沿用本批编号。`);}finally{if(root.isConnected)lock(false);}
  };
}
