import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspectMiniProgramPackage } from "./miniprogram-package-lib.js";

const root = resolve(import.meta.dirname, "..");
const project = resolve(root, "apps/miniprogram");
const output = resolve(root, "docs/evidence/support-commercial-chat-2026-09-12");
const screenshots = resolve(output, "screenshots");
const recordings = resolve(output, "recordings");
const fixturePath = resolve(root, "tmp/miniprogram-acceptance/fixture.json");
const automationArgsPath = resolve(root, "tmp/miniprogram-acceptance/support-capture-args.json");
const recordingsOnly = process.argv.includes("--recordings-only");
const manifestOnly = process.argv.includes("--manifest-only");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
  scope: string;
  origin: string;
  database: { name: string; migrationCount: number; latestMigration: string };
  routes: { managementSupportChat: { query: string } };
  facts: { supportConversationId: string; pendingOrderId: string };
  assertions: { paymentAvailable: boolean; credentialsOrTokensPersisted: boolean };
};
if (fixture.scope !== "local_devtools_synthetic_nonproduction"
  || fixture.origin !== "http://127.0.0.1:18080"
  || !/(^|_)test(_|$)/.test(fixture.database.name)
  || fixture.database.migrationCount !== 35
  || fixture.database.latestMigration !== "202609120001_support_commercial_chat.sql"
  || fixture.assertions.paymentAvailable
  || fixture.assertions.credentialsOrTokensPersisted) {
  throw new Error("A current isolated acceptance fixture is required");
}

await Promise.all([mkdir(screenshots, { recursive: true }), mkdir(recordings, { recursive: true })]);
const inspection = await inspectMiniProgramPackage(project);
if (!inspection.ok) throw new Error(`Mini Program package gate failed: ${inspection.errors.join(",")}`);

function parse(raw: string): any {
  const offset = raw.indexOf("{");
  if (offset < 0) throw new Error(`wechatide produced no JSON: ${raw.slice(0, 160)}`);
  const value = JSON.parse(raw.slice(offset));
  if (!value.ok || value.result?.success === false) throw new Error(`wechatide failed: ${JSON.stringify(value)}`);
  return value.result;
}

function wechatide(client: string, tool: string, args: string[]): any {
  return parse(execFileSync("wechatide", ["-c", client, tool, "--project", project, ...args], { cwd: root, encoding: "utf8", timeout: 45_000 }));
}

function openPage(page: string, query = ""): void {
  wechatide("project-action", "simulator_open_page", ["--page", page, ...(query ? ["--query", query] : [])]);
}

type Sender = "user" | "ai" | "admin" | "system";
type RawMessage = {
  id: string;
  sequence: number;
  senderType: Sender;
  body: string;
  contentType: string;
  createdAt: string;
  attachments: Array<{ id: string; mimeType: string; sizeBytes: number; previewPath: string; localPath: string }>;
  orderCard: null | { orderId: string; orderNumberTail: string; status: string; currency: "CNY"; totalCents: number; productName: string; productImage: string; itemSummary: string; statusLabel: string; totalYuan: string };
  deliveryState: "server_accepted" | "read";
  localState?: "pending" | "failed";
};

const at = (minute: number) => `2026-09-11T20:${String(minute).padStart(2, "0")}:00.000Z`;
function message(sequence: number, senderType: Sender, body: string, minute: number, extra: Partial<RawMessage> = {}): RawMessage {
  return {
    id: `visual-${senderType}-${sequence}`,
    sequence,
    senderType,
    body,
    contentType: senderType === "system" ? "system" : "text",
    createdAt: at(minute),
    attachments: [],
    orderCard: null,
    deliveryState: "server_accepted",
    ...extra
  };
}

const conversation = (status: "ai_active" | "waiting_human" | "human_active" | "resolved", teamReadSequence = 0, memberReadSequence = 0) => ({
  id: fixture.facts.supportConversationId,
  status,
  version: 8,
  teamReadSequence,
  memberReadSequence
});
const offline = { agentDisplayName: "小熹", operatorOnline: false, operatorTyping: false, memberOnline: true, memberTyping: false, serverTime: at(59) };
const online = { ...offline, operatorOnline: true };
const orderCard = {
  orderId: fixture.facts.pendingOrderId,
  orderNumberTail: "1288",
  status: "pending_payment",
  currency: "CNY" as const,
  totalCents: 26900,
  productName: "CISME 合成验收护理精华",
  productImage: "/assets/cisme/community-card-purple-bottle-v1.jpg",
  itemSummary: "合成 30ml × 1",
  statusLabel: "待支付",
  totalYuan: "269.00"
};
const imageAttachment = {
  id: "visual-media-1",
  mimeType: "image/jpeg",
  sizeBytes: 262144,
  previewPath: "",
  localPath: "/assets/cisme/community-card-purple-bottle-v1.jpg"
};

type State = {
  id: string;
  route: "member" | "admin";
  title: string;
  authority: "runtime_presentation_fixture";
  data: Record<string, unknown>;
  messages?: RawMessage[];
  pending?: RawMessage | null;
};

const memberBase = {
  loading: false,
  loadingOlder: false,
  sending: false,
  handoffBusy: false,
  error: "",
  errorAction: "",
  input: "",
  selectedImage: null,
  selectedOrder: null,
  uploadBusy: false,
  attachmentSheetOpen: false,
  orderPickerOpen: false,
  orderPickerLoading: false,
  orderPickerError: "",
  orderChoices: [],
  atBottom: true,
  newMessagesBelow: false,
  newMessagesBelowCount: 0,
  composerFocused: false,
  keyboardHeight: 0,
  pageAlive: true,
  visible: true
};
const commonConversation = [
  message(1, "user", "你好，我想咨询一下护理和订单。", 1),
  message(2, "ai", "你好，我是 CISME AI 助手。我会先记录你的问题；如需真人，我会明确交接。", 2),
  message(3, "user", "我的订单还没有发货，可以帮我看一下吗？", 3),
  message(4, "system", "已为你接入人工客服", 4),
  message(5, "admin", "您好，我是小熹。请把订单卡片发给我，我来核对。", 5)
];

const states: State[] = [
  { id: "01-member-empty", route: "member", title: "空会话", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: null, presence: offline, statusLabel: "随时为你提供帮助", statusTone: "neutral" }, messages: [] },
  { id: "02-member-user-only", route: "member", title: "仅用户消息", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("waiting_human"), presence: offline, statusLabel: "等待人工客服", statusTone: "waiting" }, messages: [message(1, "user", "你好，我想咨询一下护理方案。", 1)] },
  { id: "03-member-ai-conversation", route: "member", title: "AI 身份明确的会话", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("ai_active"), presence: offline, statusLabel: "CISME AI 助手", statusTone: "ai" }, messages: commonConversation.slice(0, 3) },
  { id: "04-member-waiting-human", route: "member", title: "等待人工", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("waiting_human"), presence: offline, statusLabel: "等待人工客服", statusTone: "waiting" }, messages: commonConversation.slice(0, 3) },
  { id: "05-member-human-assigned-neutral", route: "member", title: "已分配但无在线心跳", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: offline, statusLabel: "人工客服处理中", statusTone: "neutral" }, messages: commonConversation },
  { id: "06-member-human-online", route: "member", title: "真实心跳在线语义", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: online, statusLabel: "小熹 · 人工客服已接入", statusTone: "online" }, messages: commonConversation },
  { id: "07-member-human-typing", route: "member", title: "人工正在输入", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: { ...online, operatorTyping: true }, statusLabel: "小熹 · 人工客服已接入", statusTone: "online" }, messages: commonConversation },
  { id: "08-member-mixed-handoff", route: "member", title: "AI 到人工交接与系统事件", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: online, statusLabel: "小熹 · 人工客服已接入", statusTone: "online" }, messages: [...commonConversation, message(6, "admin", "我已经看到你的问题，现在帮你核对。", 6)] },
  { id: "09-member-image-message", route: "member", title: "安全图片消息", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active", 7), presence: online, statusLabel: "小熹 · 人工客服已接入", statusTone: "online" }, messages: [...commonConversation, message(6, "user", "这是我现在看到的包装。", 6, { contentType: "mixed", attachments: [imageAttachment] })] },
  { id: "10-member-order-card", route: "member", title: "本人订单卡片", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active", 7), presence: online, statusLabel: "小熹 · 人工客服已接入", statusTone: "online" }, messages: [...commonConversation, message(6, "user", "是这个订单。", 6, { contentType: "mixed", orderCard })] },
  { id: "11-member-send-failed", route: "member", title: "发送失败且草稿保留", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: offline, statusLabel: "人工客服处理中", statusTone: "neutral", input: "网络恢复后仍可重试这段文字。", error: "消息尚未获得服务端确认，正文和附件仍保留。", errorAction: "" }, messages: commonConversation, pending: message(6, "user", "网络恢复后仍可重试这段文字。", 6, { localState: "failed" }) },
  { id: "12-member-unread-history", route: "member", title: "读历史时两条新消息", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: online, statusLabel: "小熹 · 人工客服已接入", statusTone: "online", atBottom: false, newMessagesBelow: true, newMessagesBelowCount: 2 }, messages: [...commonConversation, message(6, "admin", "第一条新回复。", 6), message(7, "admin", "第二条新回复。", 6)] },
  { id: "13-member-resolved", route: "member", title: "已结束会话", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("resolved"), presence: offline, statusLabel: "本次服务已结束", statusTone: "resolved" }, messages: [...commonConversation, message(6, "admin", "本次问题已经处理完成。如有需要，可以继续留言开启新会话。", 6)] },
  { id: "14-member-multiline-composer", route: "member", title: "多行输入与聚焦输入区", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: online, statusLabel: "小熹 · 人工客服已接入", statusTone: "online", composerFocused: true, keyboardHeight: 300, input: "第一行：订单还未发货\n第二行：请帮我确认预计时间\n第三行：谢谢" }, messages: commonConversation },
  { id: "15-member-long-message", route: "member", title: "长消息排版", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: online, statusLabel: "小熹 · 人工客服已接入", statusTone: "online" }, messages: [...commonConversation, message(6, "admin", "我已经完整记录你的问题。关于护理步骤，请继续按 00 净澈、01 清洁、02 修护、03 精护的顺序操作；关于订单，我会根据你发送的订单卡片核对状态，不需要你在聊天里重复填写完整收货信息。", 6)] },
  { id: "16-member-attachment-sheet", route: "member", title: "附件 Bottom Sheet", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: online, statusLabel: "小熹 · 人工客服已接入", statusTone: "online", attachmentSheetOpen: true }, messages: commonConversation },
  { id: "17-member-image-upload-failed", route: "member", title: "图片失败独立重传", authority: "runtime_presentation_fixture", data: { ...memberBase, conversation: conversation("human_active"), presence: online, statusLabel: "小熹 · 人工客服已接入", statusTone: "online", input: "正文不会因为图片失败而丢失。", selectedImage: { localPath: imageAttachment.localPath, size: imageAttachment.sizeBytes, mimeType: imageAttachment.mimeType, status: "failed", progress: 38, mediaId: "visual-draft-media", error: "上传未完成，图片和正文仍保留。" }, error: "上传未完成，图片和正文仍保留。" }, messages: commonConversation },
  { id: "18-admin-member-typing", route: "admin", title: "管理员端会员正在输入", authority: "runtime_presentation_fixture", data: { conversation: conversation("human_active", 7, 5), presence: { ...online, memberTyping: true }, memberDisplayName: "CISME 验收会员", statusLabel: "处理中 · 会员在线", statusTone: "online", assignedToMe: true, canAssign: true, canReply: true, canViewContext: true, aiProviderAvailable: false, loading: false, loadingOlder: false, busy: false, error: "", input: "", pendingMessage: null, contextOpen: false, atBottom: true, newMessagesBelow: false, newMessagesBelowCount: 0, composerFocused: false, pageAlive: true, visible: true }, messages: commonConversation },
  { id: "19-admin-image-order", route: "admin", title: "管理员端图片与订单卡片", authority: "runtime_presentation_fixture", data: { conversation: conversation("human_active", 8, 5), presence: online, memberDisplayName: "CISME 验收会员", statusLabel: "处理中 · 会员在线", statusTone: "online", assignedToMe: true, canAssign: true, canReply: true, canViewContext: true, aiProviderAvailable: false, loading: false, loadingOlder: false, busy: false, error: "", input: "已经收到，我来核对。", pendingMessage: null, contextOpen: false, atBottom: true, newMessagesBelow: false, newMessagesBelowCount: 0, composerFocused: true, pageAlive: true, visible: true }, messages: [...commonConversation, message(6, "user", "这是图片和对应订单。", 6, { contentType: "mixed", attachments: [imageAttachment], orderCard })] },
  { id: "20-admin-context-audited", route: "admin", title: "管理员必要信息面板", authority: "runtime_presentation_fixture", data: { conversation: conversation("human_active", 8, 5), presence: online, memberDisplayName: "CISME 验收会员", statusLabel: "处理中 · 会员在线", statusTone: "online", assignedToMe: true, canAssign: true, canReply: true, canViewContext: true, aiProviderAvailable: false, loading: false, loadingOlder: false, busy: false, error: "", input: "", pendingMessage: null, contextOpen: true, memberContext: { displayName: "CISME 验收会员", memberStatus: "active", maskedPhone: "138****1234", memberSince: "2026-09-01" }, atBottom: true, newMessagesBelow: false, newMessagesBelowCount: 0, composerFocused: false, pageAlive: true, visible: true }, messages: commonConversation },
  { id: "21-admin-resolved", route: "admin", title: "管理员已结束状态", authority: "runtime_presentation_fixture", data: { conversation: conversation("resolved", 8, 8), presence: offline, memberDisplayName: "CISME 验收会员", statusLabel: "本次服务已结束", statusTone: "resolved", assignedToMe: false, canAssign: true, canReply: true, canViewContext: true, aiProviderAvailable: false, loading: false, loadingOlder: false, busy: false, error: "", input: "", pendingMessage: null, contextOpen: false, atBottom: true, newMessagesBelow: false, newMessagesBelowCount: 0, composerFocused: false, pageAlive: true, visible: true }, messages: [...commonConversation, message(6, "admin", "本次服务已完成。", 6)] }
];

const applySource = `function(spec){var p=getCurrentPages().slice(-1)[0];if(!p)return {route:"",messageCount:0};if(p.stopPolling)p.stopPolling();if(p.clearPresenceTimer)p.clearPresenceTimer();var raw=spec.messages||[];var conv=spec.data.conversation===undefined?p.data.conversation:spec.data.conversation;var presence=spec.data.presence||p.data.presence;var messages=p.present?p.present(raw,conv,presence,spec.data.memberDisplayName):raw;var pending=spec.pending&&p.present?p.present([spec.pending],conv,presence,spec.data.memberDisplayName)[0]:null;var patch=Object.assign({},spec.data,{messages:messages,pendingMessage:pending,syncCursor:raw.length?raw[raw.length-1].sequence:0,maxSeenSequence:raw.length?raw[raw.length-1].sequence:0,readCursor:0,olderCursor:null,anchor:''});p.setData(patch);return {route:p.route,messageCount:messages.length,statusLabel:p.data.statusLabel};}`;

let currentRoute: State["route"] | null = null;
const evidence: Array<Record<string, unknown>> = [];
async function applyState(state: State): Promise<void> {
  if (currentRoute !== state.route) {
    if (state.route === "member") openPage("pages/support/index");
    else openPage("pages/management-support-chat/index", fixture.routes.managementSupportChat.query);
    currentRoute = state.route;
    // simulator_open_page returns after dispatch; the runtime page stack is
    // briefly empty while a newly compiled subpackage is mounted.
    await delay(2_000);
  }
  await writeFile(automationArgsPath, JSON.stringify([{ data: state.data, messages: state.messages ?? [], pending: state.pending ?? null }]), { mode: 0o600 });
  const expectedRoute = state.route === "member" ? "pages/support/index" : "pages/management-support-chat/index";
  let applied: any = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    applied = wechatide("automation", "automation_evaluate", ["--fn-source", applySource, "--args-file", automationArgsPath]);
    if (applied.result?.result?.route === expectedRoute) {
      await delay(260);
      return;
    }
    await delay(500);
  }
  throw new Error(`Unexpected route while applying ${state.id}: ${JSON.stringify(applied)}`);
}

for (const state of states) {
  const path = join(screenshots, `${state.id}.png`);
  let captured: { imageWidth: number; imageHeight: number };
  if (recordingsOnly || manifestOnly) {
    const existing = await readFile(path);
    captured = { imageWidth: existing.readUInt32BE(16), imageHeight: existing.readUInt32BE(20) };
  } else {
    await applyState(state);
    captured = wechatide("runtime", "simulator_screenshot", ["--path", path, "--wait", "1", "--optimize=false"]);
  }
  const body = await readFile(path);
  evidence.push({
    id: state.id,
    title: state.title,
    route: state.route === "member" ? "pages/support/index" : "pages/management-support-chat/index",
    authority: state.authority,
    file: `screenshots/${state.id}.png`,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.length,
    widthPx: captured.imageWidth,
    heightPx: captured.imageHeight,
    packageSourceSha256: inspection.actual.sourceSha256,
    result: "PASS_NATIVE_DEVTOOLS_PRESENTATION"
  });
}

function devtoolsWindowRect(): { x: number; y: number; width: number; height: number } {
  const raw = execFileSync("osascript", [
    "-e", "tell application \"System Events\"",
    "-e", "tell process \"微信开发者工具\"",
    "-e", "set targetWindow to first window whose name is \"miniprogram\"",
    "-e", "get {position of targetWindow, size of targetWindow}",
    "-e", "end tell",
    "-e", "end tell"
  ], { encoding: "utf8" }).trim();
  const values = raw.split(/,\s*/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) throw new Error(`Cannot parse DevTools window bounds: ${raw}`);
  const rect = { x: values[0]!, y: values[1]!, width: values[2]!, height: values[3]! };
  if (rect.width < 800 || rect.height < 600) throw new Error(`Unexpected DevTools main window bounds: ${raw}`);
  return rect;
}

function activateDevtools(): void {
  execFileSync("osascript", [
    "-e", "tell application \"微信开发者工具\" to activate",
    "-e", "tell application \"System Events\"",
    "-e", "tell process \"微信开发者工具\"",
    "-e", "set frontmost to true",
    "-e", "set targetWindow to first window whose name is \"miniprogram\"",
    "-e", "perform action \"AXRaise\" of targetWindow",
    "-e", "end tell",
    "-e", "end tell"
  ], { stdio: "ignore" });
}

async function record(id: string, steps: Array<{ state: State; holdMs: number }>): Promise<Record<string, unknown>> {
  if (!steps[0]) throw new Error(`Recording ${id} requires at least one state`);
  await applyState(steps[0].state);
  activateDevtools();
  await delay(500);
  const window = devtoolsWindowRect();
  // Stable full-mode layout preflight: the 484x1048 simulator is shown at 0.5x,
  // 87 points from the right and 88 points below the window origin.
  const rect = { x: window.x + window.width - 329, y: window.y + 88, width: 242, height: 524 };
  const seconds = Math.ceil((900 + steps.reduce((sum, step) => sum + step.holdMs, 0)) / 1000) + 5;
  const path = join(recordings, `${id}.mov`);
  await rm(path, { force: true });
  const process = spawn("screencapture", ["-v", `-R${rect.x},${rect.y},${rect.width},${rect.height}`, `-V${seconds}`, "-x", path], { stdio: "ignore" });
  const finished = new Promise<void>((resolvePromise, reject) => {
    process.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`screencapture exited ${code}`)));
    process.once("error", reject);
  });
  await delay(700);
  await delay(steps[0].holdMs);
  for (const step of steps.slice(1)) {
    await applyState(step.state);
    await delay(step.holdMs);
  }
  await finished;
  const body = await readFile(path);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration,codec_name", "-of", "json", path], { encoding: "utf8" }));
  return { id, file: `recordings/${id}.mov`, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length,
    capture: "macOS screencapture of the visible WeChat DevTools simulator region", packageSourceSha256: inspection.actual.sourceSha256,
    stream: probe.streams?.[0] ?? null, qualification: "Genuine native simulator screen recording of deterministic local presentation states; not physical-device, public-network, system media-picker, or end-to-end upload evidence." };
}

const byId = (id: string) => states.find((state) => state.id === id)!;
const recordingSpecs = [
  ["A-user-send-human-typing-reply", [
    { state: byId("02-member-user-only"), holdMs: 900 },
    { state: byId("05-member-human-assigned-neutral"), holdMs: 900 },
    { state: byId("07-member-human-typing"), holdMs: 1100 },
    { state: byId("08-member-mixed-handoff"), holdMs: 1200 }
  ]],
  ["B-ai-handoff-human-takeover", [
    { state: byId("03-member-ai-conversation"), holdMs: 900 },
    { state: byId("04-member-waiting-human"), holdMs: 900 },
    { state: byId("05-member-human-assigned-neutral"), holdMs: 900 },
    { state: byId("08-member-mixed-handoff"), holdMs: 1200 }
  ]],
  ["C-attachment-sheet-upload-preview-message", [
    { state: byId("08-member-mixed-handoff"), holdMs: 700 },
    { state: byId("16-member-attachment-sheet"), holdMs: 1000 },
    { state: byId("17-member-image-upload-failed"), holdMs: 1100 },
    { state: byId("09-member-image-message"), holdMs: 1300 }
  ]],
  ["D-order-card-member-to-admin", [
    { state: byId("16-member-attachment-sheet"), holdMs: 800 },
    { state: byId("10-member-order-card"), holdMs: 1100 },
    { state: byId("19-admin-image-order"), holdMs: 1400 }
  ]]
] as Array<[string, Array<{ state: State; holdMs: number }>]>;

async function existingRecording(id: string): Promise<Record<string, unknown>> {
  const path = join(recordings, `${id}.mov`);
  const body = await readFile(path);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration,codec_name", "-of", "json", path], { encoding: "utf8" }));
  return { id, file: `recordings/${id}.mov`, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length,
    capture: "macOS screencapture of the visible WeChat DevTools simulator region", packageSourceSha256: inspection.actual.sourceSha256,
    stream: probe.streams?.[0] ?? null, qualification: "Genuine native simulator screen recording of deterministic local presentation states; not physical-device, public-network, system media-picker, or end-to-end upload evidence." };
}

const recordingEvidence = [] as Array<Record<string, unknown>>;
for (const [id, steps] of recordingSpecs) recordingEvidence.push(manifestOnly ? await existingRecording(id) : await record(id, steps));

execFileSync("magick", ["montage", "-font", "/System/Library/Fonts/HelveticaNeue.ttc", ...evidence.map((item) => join(output, String(item.file))), "-thumbnail", "181x392", "-tile", "5x", "-geometry", "+5+5", join(output, "support-state-contact-sheet.png")]);
const contactBody = await readFile(join(output, "support-state-contact-sheet.png"));
const contactStat = await stat(join(output, "support-state-contact-sheet.png"));

async function artifact(file: string, metadata: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const body = await readFile(join(output, file));
    return { file, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length, packageSourceSha256: inspection.actual.sourceSha256, ...metadata };
  } catch {
    return null;
  }
}

const supplementalEvidence = (await Promise.all([
  artifact("member-human-assigned-neutral.png", {
    id: "member-human-assigned-neutral-local-api",
    authority: "isolated_loopback_api_runtime",
    result: "PASS_NATIVE_DEVTOOLS_LOCAL_API",
    qualification: "Rendered from the isolated cisme_test API and current member session; assigned human has no valid operator heartbeat, so the header remains neutral."
  }),
  artifact("screenshots/22-member-large-font-23.png", {
    id: "22-member-large-font-23",
    authority: "isolated_loopback_api_plus_devtools_font_size_23",
    result: "PASS_NATIVE_DEVTOOLS_LARGE_FONT_PRESENTATION",
    qualification: "WeChat DevTools fontSizeSetting 23 presentation check; not physical-device accessibility evidence."
  })
])).filter((item): item is Record<string, unknown> => item !== null);

const derivedArtifacts = (await Promise.all([
  ...recordingEvidence.map((item) => artifact(`recordings/${String(item.id)}-keyframes.png`, { kind: "recording_keyframes", sourceRecording: item.file })),
  artifact("recordings/recordings-contact-sheet.png", { kind: "recording_contact_sheet" })
])).filter((item): item is Record<string, unknown> => item !== null);

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  packageSourceSha256: inspection.actual.sourceSha256,
  environment: { tool: "WeChat DevTools Stable 2.02.2608070 + wechatide 0.3.9", scope: fixture.scope, origin: fixture.origin, database: fixture.database },
  screenshots: evidence,
  supplementalEvidence,
  recordings: recordingEvidence,
  derivedArtifacts,
  contactSheet: { file: "support-state-contact-sheet.png", sha256: createHash("sha256").update(contactBody).digest("hex"), bytes: contactStat.size },
  result: "PASS_NATIVE_DEVTOOLS_PRESENTATION_FIXTURES_WITH_QUALIFICATIONS",
  exclusions: ["physical iOS", "physical Android", "system media picker automation", "public HTTPS", "formal Mini Program upload", "production identity", "real payment", "real user data"]
};
await writeFile(join(output, "visual-evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ event: "CISME_SUPPORT_COMMERCIAL_CHAT_CAPTURED", packageSourceSha256: inspection.actual.sourceSha256,
  screenshots: evidence.length, recordings: recordingEvidence.length, output }, null, 2));
