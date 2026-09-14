import "./styles.css";

interface ReviewItem {
  id: string;
  workflow: "review" | "publication";
  status: string;
  version: number;
  post_url: string;
  platform_account: string;
  disclosure: string;
  submitted_at?: string;
  reviewed_at?: string;
  reviewed_by?: string;
  reward_enabled?: boolean;
  publication_enabled?: boolean;
  publication_queued?: boolean;
  publication_dead_lettered?: boolean;
  consent_revoked?: boolean;
  feed_item_id?: string | null;
  visible?: boolean | null;
}

interface PointsGrantItem {
  id: string; member_id: string; amount: number; state: string; version: number; rule_code: string;
  frozen_amount: number; available_amount: number; expired_amount: number; reversed_amount: number;
  available_after: string; expires_at: string; pending_action_id?: string; pending_action?: string; requested_by?: string;
}

interface PointsActionItem {
  id: string; grant_id: string; action: string; amount: number; state: string; requested_by: string; requested_at: string;
  grant_state: string; grant_version: number; frozen_amount: number; available_amount: number;
}

const state = {
  api: localStorage.getItem("cisme.admin.api") || "http://127.0.0.1:3100",
  token: "",
  queue: [] as ReviewItem[], selected: null as ReviewItem | null,
  pointsGrants: [] as PointsGrantItem[], pointsActions: [] as PointsActionItem[], selectedFinance: null as { kind: "grant" | "action"; id: string } | null,
  privacyRequests: [] as Array<{id:string;member_id:string;kind:string;message:string;status:string;version:number;response?:string;execution?:{type:string;status:string;executionMode:string}}>, privacyBusy:false,
  error: "", loading: false, enrollmentMessage: ""
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}

function render() {
  const root = document.querySelector<HTMLElement>("#app")!;
  root.innerHTML = `
    <header><div><span class="eyebrow">CISME OPERATIONS</span><h1>审核、发布与积分资产台</h1></div><div class="status">R0 · 内容与财务双人复核</div></header>
    <section class="credentials panel">
      <label>API 地址<input id="api" value="${escapeHtml(state.api)}"/></label>
      <label>已验证操作员会话<input id="token" type="password" value="${escapeHtml(state.token)}" autocomplete="off"/></label>
      <p class="guard-note">共享管理口令与手填 Principal 已停用；此受控台不会自行提升身份。正式环境需接入已批准的操作员登录流程。</p>
      <button id="load">${state.loading ? "同步中…" : "读取授权队列"}</button>
    </section>
    <section class="enrollment panel">
      <div><span class="eyebrow">EXPERIENCE QUALIFICATION</span><h2>体验成员护理资格</h2><p>仅凭签收证据或已批准测试履约创建 PLANNED 周期；不得用作生产订单替代。</p></div>
      <label>会员体验编号<input id="enrollment-member" placeholder="小程序会员中心显示的 UUID"/></label>
      <label>资格类型<select id="enrollment-type"><option value="approved_tester_fulfillment">已批准测试履约</option><option value="verified_delivery">已核验签收</option></select></label>
      <label>外部证据编号<input id="enrollment-ref" placeholder="测试批次/签收凭证唯一编号"/></label>
      <label>事实发生时间<input id="enrollment-time" type="datetime-local"/></label>
      <label class="enrollment-evidence">可复核证据<input id="enrollment-evidence" placeholder="不得填写密钥；记录签收/测试批准事实"/></label>
      <button id="enroll">创建待开始周期</button>
      ${state.enrollmentMessage ? `<p class="success">${escapeHtml(state.enrollmentMessage)}</p>` : ""}
    </section>
    ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
    <section class="panel"><h2>隐私与数据权利受理</h2><p>support / review_lead 可回复；只有 review_lead 能建立不执行数据操作的 dry-run/plan-only 计划。计划、回复、实际完成三者不得混同。</p><button id="privacy-load">刷新受理队列</button>${state.privacyRequests.map(item=>`<article class="panel"><strong>${escapeHtml(item.kind)} · ${escapeHtml(item.status)} · v${item.version}</strong><p>会员 ${escapeHtml(item.member_id)} / 请求 ${escapeHtml(item.id)}</p><p>${escapeHtml(item.message)}</p>${item.response?`<p>上次回复：${escapeHtml(item.response)}</p>`:''}${item.execution?`<p>执行计划：${escapeHtml(item.execution.type)} / ${escapeHtml(item.execution.status)} / ${escapeHtml(item.execution.executionMode)}</p>`:''}<label>处理状态<select id="privacy-status-${item.id}"><option value="reviewing">处理中</option><option value="responded">已回复（不代表执行完成）</option></select></label><label>给会员的回复<textarea id="privacy-response-${item.id}" maxlength="4000" placeholder="说明核验要求、实际处理结果或依法保留的具体理由。"></textarea></label><button data-privacy-id="${item.id}" ${state.privacyBusy?'disabled':''}>保存并向会员展示回复</button>${!item.execution&&['access','delete','close_account','withdraw'].includes(item.kind)?`<label>计划原因码<select id="privacy-plan-reason-${item.id}"><option>USER_RIGHTS_VERIFIED</option><option>SCOPE_REVIEW_REQUIRED</option></select></label><button data-privacy-plan="${item.id}" ${state.privacyBusy?'disabled':''}>仅建立执行计划（不执行）</button>`:''}</article>`).join('') || '<p>尚未读取或暂无受理记录。</p>'}</section>
    <div class="workspace">
      <section class="panel queue"><div class="section-title"><h2>审核 / 发布待办</h2><span>${state.queue.length} 件</span></div>
        ${state.queue.map((item) => `<button class="queue-item ${state.selected?.id === item.id && state.selected?.workflow === item.workflow ? "selected" : ""}" data-id="${item.id}" data-workflow="${item.workflow}"><strong>${escapeHtml(item.platform_account)}</strong><span>${item.workflow === "review" ? "领奖审核" : "公开发布"} · ${escapeHtml(item.status)} · v${item.version}</span><small>${escapeHtml(item.submitted_at ?? item.reviewed_at)}</small></button>`).join("") || `<div class="empty">暂无待办</div>`}
      </section>
      <section class="panel detail">${state.selected ? detailTemplate(state.selected) : `<div class="empty detail-empty">选择一条投稿，查看证据并记录原因码。</div>`}</section>
    </div>
    <div class="workspace finance-workspace">
      <section class="panel queue"><div class="section-title"><h2>积分资产 / 复核</h2><span>${state.pointsGrants.length + state.pointsActions.filter((item) => item.state === "pending").length} 件</span></div>
        ${state.pointsActions.filter((item) => item.state === "pending").map((item) => `<button class="queue-item finance-item ${state.selectedFinance?.kind === "action" && state.selectedFinance.id === item.id ? "selected" : ""}" data-finance-kind="action" data-id="${item.id}"><strong>待复核 · ${escapeHtml(item.action)}</strong><span>${item.amount} 分 · grant v${item.grant_version}</span><small>发起人 ${escapeHtml(item.requested_by)}</small></button>`).join("")}
        ${state.pointsGrants.map((item) => `<button class="queue-item finance-item ${state.selectedFinance?.kind === "grant" && state.selectedFinance.id === item.id ? "selected" : ""}" data-finance-kind="grant" data-id="${item.id}"><strong>${item.amount} 分 · ${escapeHtml(item.state)}</strong><span>冻结 ${item.frozen_amount} / 可用 ${item.available_amount} · v${item.version}</span><small>${item.pending_action_id ? `已有待复核 ${escapeHtml(item.pending_action)}` : escapeHtml(item.rule_code)}</small></button>`).join("") || `<div class="empty">当前 Principal 无积分队列，或暂无资产</div>`}
      </section>
      <section class="panel detail">${financeDetailTemplate()}</section>
    </div>`;
  bindEvents();
}

function financeDetailTemplate(): string {
  const selection = state.selectedFinance;
  if (!selection) return `<div class="empty detail-empty">财务操作员选择资产发起动作；不同的财务复核员批准或拒绝。</div>`;
  if (selection.kind === "action") {
    const item = state.pointsActions.find((candidate) => candidate.id === selection.id);
    if (!item) return `<div class="empty detail-empty">该动作已离开当前队列。</div>`;
    return `<div class="section-title"><div><span class="eyebrow">POINTS · CHECKER</span><h2>${escapeHtml(item.action)} ${item.amount} 分</h2></div><span class="badge">${escapeHtml(item.state)}</span></div>
      <dl><dt>Grant</dt><dd>${escapeHtml(item.grant_id)}</dd><dt>发起人</dt><dd>${escapeHtml(item.requested_by)}</dd><dt>当前余额</dt><dd>冻结 ${item.frozen_amount} / 可用 ${item.available_amount}</dd></dl>
      <label class="full">复核原因码<select id="points-decision-reason"><option>FINANCE_CHECKED</option><option>ACTION_REJECTED</option><option>REVERSAL_CONFIRMED</option><option>EXPIRY_CONFIRMED</option></select></label>
      <label class="full">复核证据<textarea id="points-decision-evidence" placeholder="记录审批单、规则版本和可复核事实；审批人必须与发起人不同。"></textarea></label>
      <p class="guard-note">批准会原子更新 lot、projection、append-only entry、outbox 与 audit；拒绝不会改变余额。</p>
      <div class="actions"><button id="points-reject" class="danger">拒绝</button><button id="points-approve">批准执行</button></div>`;
  }
  const item = state.pointsGrants.find((candidate) => candidate.id === selection.id);
  if (!item) return `<div class="empty detail-empty">该资产已离开当前队列。</div>`;
  return `<div class="section-title"><div><span class="eyebrow">POINTS · MAKER</span><h2>${item.amount} 分资产</h2></div><span class="badge">${escapeHtml(item.state)} · v${item.version}</span></div>
    <dl><dt>Grant</dt><dd>${escapeHtml(item.id)}</dd><dt>会员</dt><dd>${escapeHtml(item.member_id)}</dd><dt>四桶守恒</dt><dd>冻结 ${item.frozen_amount} / 可用 ${item.available_amount} / 到期 ${item.expired_amount} / 冲正 ${item.reversed_amount}</dd><dt>最早解冻</dt><dd>${escapeHtml(item.available_after)}</dd><dt>到期日</dt><dd>${escapeHtml(item.expires_at)}</dd></dl>
    <label class="full">资产动作<select id="points-action"><option value="unfreeze">整笔解冻</option><option value="expire">整笔到期</option><option value="reverse_remaining">冲正剩余余额</option></select></label>
    <label class="full">发起原因码<select id="points-action-reason"><option>HOLD_COMPLETE</option><option>EXPIRY_REACHED</option><option>REWARD_VOIDED</option></select></label>
    <label class="full">发起证据<textarea id="points-action-evidence" placeholder="记录财务批准号、规则版本或冲正案件编号。"></textarea></label>
    <p class="guard-note">${item.pending_action_id ? `该资产已有待复核动作，由 ${escapeHtml(item.requested_by)} 发起。` : "发起动作不会立即改账；必须由另一个 finance_approver Principal 复核。"}</p>
    <div class="actions"><button id="points-request" ${item.pending_action_id ? "disabled" : ""}>提交财务复核</button></div>`;
}

function detailTemplate(item: ReviewItem): string {
  if (item.workflow === "publication") return publicationTemplate(item);
  return `<div class="section-title"><div><span class="eyebrow">SUBMISSION</span><h2>${escapeHtml(item.platform_account)}</h2></div><span class="badge">${escapeHtml(item.status)}</span></div>
    <dl><dt>公开链接</dt><dd><a href="${escapeHtml(item.post_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.post_url)}</a></dd><dt>利益披露</dt><dd>${escapeHtml(item.disclosure)}</dd><dt>权威版本</dt><dd>${item.version}</dd></dl>
    <label class="full">原因码<select id="reason"><option>CONTENT_CLEAR</option><option>EVIDENCE_INCOMPLETE</option><option>DISCLOSURE_INCOMPLETE</option><option>POLICY_VIOLATION</option><option>APPEAL_UPHELD</option></select></label>
    <label class="full">审核证据<textarea id="evidence" placeholder="仅记录可复核事实；不要粘贴敏感密钥。"></textarea></label>
    <div class="actions"><button data-decision="request_changes" class="secondary">要求补件</button><button data-decision="reject" class="danger">驳回</button><button data-decision="approve">${item.reward_enabled ? "通过并生成冻结积分" : "通过（本环境不发积分）"}</button></div>`;
}

function publicationTemplate(item: ReviewItem): string {
  const blocked = item.consent_revoked || item.publication_queued || item.publication_dead_lettered || item.visible || !item.publication_enabled;
  const status = item.consent_revoked ? "许可已撤回" : item.visible ? "已公开" : item.publication_dead_lettered ? "发布失败，需事件重驱" : item.publication_queued ? "发布队列处理中" : item.publication_enabled ? "待发布复核" : "UGC 发布门关闭";
  return `<div class="section-title"><div><span class="eyebrow">PUBLICATION · FOUR EYES</span><h2>${escapeHtml(item.platform_account)}</h2></div><span class="badge">${status}</span></div>
    <dl><dt>外部链接</dt><dd><a href="${escapeHtml(item.post_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.post_url)}</a></dd><dt>利益披露</dt><dd>${escapeHtml(item.disclosure)}</dd><dt>领奖审核人</dt><dd>${escapeHtml(item.reviewed_by)}</dd></dl>
    <label class="full">公开标题<input id="publication-title" maxlength="60" placeholder="最多 60 字；不得自动生成或夸大功效"/></label>
    <label class="full">公开摘要<textarea id="publication-excerpt" maxlength="240" placeholder="最多 240 字；基于已核验事实编辑。"></textarea></label>
    <label class="full">AI 使用声明<select id="ai-usage"><option value="none">未使用</option><option value="assisted">AI 辅助</option><option value="generated">AI 生成</option><option value="unknown">无法确认</option></select></label>
    <label class="full">发布原因码<select id="publication-reason"><option>PUBLICATION_CLEAR</option><option>RIGHTS_VERIFIED</option><option>BRAND_CURATED</option></select></label>
    <label class="full">发布复核证据<textarea id="publication-evidence" placeholder="记录内容安全、权利、利益披露与 AI 标识复核事实。"></textarea></label>
    <p class="guard-note">领奖审核与公开发布是两个决策；同一 Principal 不得完成两步。</p>
    <div class="actions"><button id="publish" ${blocked ? "disabled" : ""}>${status}</button></div>`;
}

function bindEvents() {
  document.querySelector("#privacy-load")?.addEventListener("click",()=>void loadPrivacyRequests());
  document.querySelectorAll<HTMLButtonElement>("[data-privacy-id]").forEach(button=>button.addEventListener("click",()=>void respondPrivacy(button.dataset.privacyId!)));
  document.querySelectorAll<HTMLButtonElement>("[data-privacy-plan]").forEach(button=>button.addEventListener("click",()=>void planPrivacy(button.dataset.privacyPlan!)));
  document.querySelector("#load")?.addEventListener("click", () => void loadQueue());
  document.querySelector("#enroll")?.addEventListener("click", () => void enrollExperienceMember());
  document.querySelectorAll<HTMLElement>(".queue-item").forEach((element) => element.addEventListener("click", () => { state.selected = state.queue.find((item) => item.id === element.dataset.id && item.workflow === element.dataset.workflow) ?? null; render(); }));
  document.querySelectorAll<HTMLButtonElement>("[data-decision]").forEach((button) => button.addEventListener("click", () => void review(button.dataset.decision!)));
  document.querySelector<HTMLButtonElement>("#publish")?.addEventListener("click", () => void publish());
  document.querySelectorAll<HTMLElement>(".finance-item").forEach((element) => element.addEventListener("click", () => { state.selectedFinance = { kind: element.dataset.financeKind as "grant" | "action", id: element.dataset.id! }; render(); }));
  document.querySelector<HTMLButtonElement>("#points-request")?.addEventListener("click", () => void requestPointsAction());
  document.querySelector<HTMLButtonElement>("#points-approve")?.addEventListener("click", () => void decidePointsAction("approve"));
  document.querySelector<HTMLButtonElement>("#points-reject")?.addEventListener("click", () => void decidePointsAction("reject"));
}

function credentials() {
  state.api = (document.querySelector<HTMLInputElement>("#api")?.value || state.api).replace(/\/$/, "");
  state.token = document.querySelector<HTMLInputElement>("#token")?.value || state.token;
  localStorage.setItem("cisme.admin.api", state.api);
  sessionStorage.removeItem("cisme.admin.principal");
  sessionStorage.removeItem("cisme.admin.token");
}

let queueRequestEpoch = 0;
let queueAbortController: AbortController | null = null;

async function api(path: string, init?: RequestInit, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), 8_000);
  try {
    const response = await fetch(`${state.api}${path}`, { ...init, signal: controller.signal, headers: { "content-type": "application/json", authorization: `Bearer ${state.token}`, ...init?.headers } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.title || body.code || "请求失败");
    return body;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function loadQueue() {
  const epoch = ++queueRequestEpoch;
  queueAbortController?.abort();
  const controller = new AbortController();
  queueAbortController = controller;
  credentials(); state.loading = true; state.error = ""; render();
  try {
    const [reviewResult, publicationResult, grantResult, actionResult] = await Promise.allSettled([
      api("/v1/admin/reviews", undefined, controller.signal),
      api("/v1/admin/publications", undefined, controller.signal),
      api("/v1/admin/points/grants", undefined, controller.signal),
      api("/v1/admin/points/actions", undefined, controller.signal)
    ]);
    if (epoch !== queueRequestEpoch) return;
    const results = [reviewResult, publicationResult, grantResult, actionResult];
    const authorized = results.some((result) => result.status === "fulfilled");
    if (!authorized) throw (results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined)?.reason ?? new Error("当前 Principal 没有任何授权队列");
    const reviews = reviewResult.status === "fulfilled" ? (reviewResult.value as ReviewItem[]).map((item) => ({ ...item, workflow: "review" as const })) : [];
    const publications = publicationResult.status === "fulfilled" ? (publicationResult.value as ReviewItem[]).map((item) => ({ ...item, workflow: "publication" as const })) : [];
    state.pointsGrants = grantResult.status === "fulfilled" ? grantResult.value as PointsGrantItem[] : [];
    state.pointsActions = actionResult.status === "fulfilled" ? actionResult.value as PointsActionItem[] : [];
    state.queue = [...reviews, ...publications];
    state.selected = state.selected ? state.queue.find((item) => item.id === state.selected?.id && item.workflow === state.selected?.workflow) ?? null : state.queue[0] ?? null;
    state.selectedFinance = state.selectedFinance && ((state.selectedFinance.kind === "grant" ? state.pointsGrants : state.pointsActions).some((item) => item.id === state.selectedFinance?.id)) ? state.selectedFinance : (state.pointsActions.find((item) => item.state === "pending") ? { kind: "action", id: state.pointsActions.find((item) => item.state === "pending")!.id } : state.pointsGrants[0] ? { kind: "grant", id: state.pointsGrants[0].id } : null);
  }
  catch (error) { if (epoch === queueRequestEpoch && !controller.signal.aborted) state.error = String((error as Error).message); }
  finally {
    if (epoch === queueRequestEpoch) {
      if (queueAbortController === controller) queueAbortController = null;
      state.loading = false;
      render();
    }
  }
}

async function requestPointsAction() {
  if (state.selectedFinance?.kind !== "grant") return;
  const grant = state.pointsGrants.find((item) => item.id === state.selectedFinance?.id); if (!grant) return;
  const action = document.querySelector<HTMLSelectElement>("#points-action")!.value;
  const reasonCode = document.querySelector<HTMLSelectElement>("#points-action-reason")!.value;
  const note = document.querySelector<HTMLTextAreaElement>("#points-action-evidence")!.value.trim();
  if (!note) { state.error = "必须填写可复核的财务发起证据。"; render(); return; }
  try {
    await api(`/v1/admin/points/grants/${grant.id}/actions`, { method: "POST", headers: { "idempotency-key": `points-${action}-${grant.id}-v${grant.version}` }, body: JSON.stringify({ action, expectedGrantVersion: grant.version, reasonCode, evidence: { note } }) });
    await loadQueue();
  } catch (error) { state.error = String((error as Error).message); render(); }
}

async function decidePointsAction(decision: "approve" | "reject") {
  if (state.selectedFinance?.kind !== "action") return;
  const action = state.pointsActions.find((item) => item.id === state.selectedFinance?.id); if (!action) return;
  const reasonCode = document.querySelector<HTMLSelectElement>("#points-decision-reason")!.value;
  const note = document.querySelector<HTMLTextAreaElement>("#points-decision-evidence")!.value.trim();
  if (!note) { state.error = "必须填写可复核的财务复核证据。"; render(); return; }
  try {
    await api(`/v1/admin/points/actions/${action.id}/${decision}`, { method: "POST", headers: { "idempotency-key": `points-${decision}-${action.id}` }, body: JSON.stringify({ reasonCode, evidence: { note } }) });
    await loadQueue();
  } catch (error) { state.error = String((error as Error).message); render(); }
}

async function publish() {
  if (!state.selected || state.selected.workflow !== "publication") return;
  const title = document.querySelector<HTMLInputElement>("#publication-title")!.value.trim();
  const excerpt = document.querySelector<HTMLTextAreaElement>("#publication-excerpt")!.value.trim();
  const aiUsage = document.querySelector<HTMLSelectElement>("#ai-usage")!.value;
  const reasonCode = document.querySelector<HTMLSelectElement>("#publication-reason")!.value;
  const note = document.querySelector<HTMLTextAreaElement>("#publication-evidence")!.value.trim();
  if (!title || !excerpt || !note) { state.error = "标题、摘要和可复核发布证据均为必填。"; render(); return; }
  try {
    await api(`/v1/admin/submissions/${state.selected.id}/publish`, { method: "POST", headers: { "idempotency-key": `publish-${state.selected.id}-v${state.selected.version}` }, body: JSON.stringify({ title, excerpt, aiUsage, reasonCode, evidence: { note } }) });
    await loadQueue();
  } catch (error) { state.error = String((error as Error).message); render(); }
}

async function enrollExperienceMember() {
  credentials();
  const memberId = document.querySelector<HTMLInputElement>("#enrollment-member")!.value.trim();
  const qualificationType = document.querySelector<HTMLSelectElement>("#enrollment-type")!.value;
  const externalRef = document.querySelector<HTMLInputElement>("#enrollment-ref")!.value.trim();
  const occurredAtInput = document.querySelector<HTMLInputElement>("#enrollment-time")!.value;
  const evidence = document.querySelector<HTMLInputElement>("#enrollment-evidence")!.value.trim();
  if (!memberId || !externalRef || !occurredAtInput || !evidence) { state.error = "体验资格的会员编号、证据编号、发生时间和证据说明均为必填。"; render(); return; }
  try {
    const result = await api("/v1/admin/tester-enrollments", { method: "POST", body: JSON.stringify({ memberId, qualificationType, externalRef, occurredAt: new Date(occurredAtInput).toISOString(), timezone: "Asia/Shanghai", protocolVersion: "care-r0-v1", reasonCode: "EXPERIENCE_QUALIFICATION_VERIFIED", evidence: { note: evidence } }) });
    state.error = "";
    state.enrollmentMessage = `已创建或复用待开始周期 ${(result as { cycle: { id: string } }).cycle.id}`;
    render();
  } catch (error) { state.error = String((error as Error).message); render(); }
}

async function review(decision: string) {
  if (!state.selected) return;
  const reasonCode = document.querySelector<HTMLSelectElement>("#reason")!.value;
  const note = document.querySelector<HTMLTextAreaElement>("#evidence")!.value.trim();
  if (!note) { state.error = "必须填写可复核的审核证据。"; render(); return; }
  try {
    await api(`/v1/admin/submissions/${state.selected.id}/review`, { method: "POST", headers: { "idempotency-key": `review-${state.selected.id}-v${state.selected.version}` }, body: JSON.stringify({ decision, reasonCode, evidence: { note }, expectedVersion: state.selected.version }) });
    await loadQueue();
  } catch (error) { state.error = String((error as Error).message); render(); }
}

render();

async function loadPrivacyRequests(){
 credentials();state.error='';
 try{state.privacyRequests=await api('/v1/admin/privacy-requests');}
 catch(e){state.privacyRequests=[];state.error=(e as Error).message;}
 render();
}
async function respondPrivacy(id:string){
 if(state.privacyBusy)return;
 credentials();
 const status=document.querySelector<HTMLSelectElement>(`#privacy-status-${id}`)!.value;
 const response=document.querySelector<HTMLTextAreaElement>(`#privacy-response-${id}`)!.value.trim();
 if(!response){state.error='请填写具体处理回复。';render();return;}
 const item=state.privacyRequests.find(request=>request.id===id);if(!item){state.error='受理记录已变化，请刷新。';render();return;}
 state.privacyBusy=true;
 try{await api(`/v1/admin/privacy-requests/${id}/response`,{method:'POST',body:JSON.stringify({status,response,expectedVersion:item.version})});state.privacyRequests=await api('/v1/admin/privacy-requests');state.error='';}
 catch(e){state.error=(e as Error).message;}
 finally{state.privacyBusy=false;render();}
}
async function planPrivacy(id:string){
 if(state.privacyBusy)return;
 credentials();
 const item=state.privacyRequests.find(request=>request.id===id);if(!item){state.error='受理记录已变化，请刷新。';render();return;}
 const reasonCode=document.querySelector<HTMLSelectElement>(`#privacy-plan-reason-${id}`)?.value||'SCOPE_REVIEW_REQUIRED';
 state.privacyBusy=true;
 try{await api(`/v1/admin/privacy-requests/${id}/execution-plan`,{method:'POST',headers:{'idempotency-key':`privacy-plan-${id}-v${item.version}`},body:JSON.stringify({expectedVersion:item.version,reasonCode})});state.privacyRequests=await api('/v1/admin/privacy-requests');state.error='';}
 catch(e){state.error=(e as Error).message;}
 finally{state.privacyBusy=false;render();}
}
