import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspectMiniProgramPackage } from "./miniprogram-package-lib.js";

const root = resolve(import.meta.dirname, "..");
const project = join(root, "apps/miniprogram");
const output = join(root, "docs/evidence/support-composer-2026-09-12");
const screenshots = join(output, "screenshots");
const fixture = JSON.parse(await readFile(join(root, "tmp/miniprogram-acceptance/fixture.json"), "utf8")) as {
  scope: string;
  origin: string;
  database: { name: string; migrationCount: number; latestMigration: string };
  routes: { managementSupportChat: { query: string } };
  assertions: { paymentAvailable: boolean; credentialsOrTokensPersisted: boolean };
};
if (fixture.scope !== "local_devtools_synthetic_nonproduction"
  || fixture.origin !== "http://127.0.0.1:18080"
  || !/(^|_)test(_|$)/.test(fixture.database.name)
  || fixture.database.migrationCount !== 35
  || fixture.database.latestMigration !== "202609120001_support_commercial_chat.sql"
  || fixture.assertions.paymentAvailable || fixture.assertions.credentialsOrTokensPersisted) {
  throw new Error("Composer capture requires the isolated synthetic local acceptance fixture");
}
const inspection = await inspectMiniProgramPackage(project);
if (!inspection.ok) throw new Error(`Mini Program package gate failed: ${inspection.errors.join(", ")}`);
await mkdir(screenshots, { recursive: true });

function run(client: string, tool: string, args: string[]): any {
  const raw = execFileSync("wechatide", ["-c", client, tool, "--project", project, ...args], {
    cwd: root, encoding: "utf8", timeout: 45_000
  });
  const json = raw.slice(raw.indexOf("{"));
  if (!json.startsWith("{")) throw new Error(`wechatide returned no JSON: ${raw.slice(0, 160)}`);
  const response = JSON.parse(json);
  if (!response.ok || response.result?.success === false) throw new Error(`${tool}: ${JSON.stringify(response)}`);
  return response.result;
}
const evaluate = (source: string): any => run("automation", "automation_evaluate", ["--fn-source", source]).result?.result;
const action = (operation: "input" | "tap", selector: string, value?: string): void => {
  run("automation", "automation_element_action", ["--action", operation, "--selector", selector, ...(value === undefined ? [] : ["--value", value])]);
};
const open = async (page: string, query = ""): Promise<void> => {
  run("project-action", "simulator_open_page", ["--page", page, ...(query ? ["--query", query] : [])]);
  await delay(2_000);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = evaluate("function(){var p=getCurrentPages().slice(-1)[0];return {route:p&&p.route,loading:p&&p.data.loading,error:p&&p.data.error}}") ?? {};
    if (state.route === page && state.loading === false && !state.error) return;
    await delay(500);
  }
  throw new Error(`The requested page did not settle at ${page}`);
};
const state = (): any => evaluate("function(){var p=getCurrentPages().slice(-1)[0];return {route:p.route,input:p.data.input,lineCount:p.data.composerLineCount,capped:p.data.composerCapped,sendEnabled:p.data.composerSendEnabled,sheet:p.data.attachmentSheetOpen,sheetMode:p.data.attachmentSheetMode,picker:p.data.orderPickerOpen,order:p.data.selectedOrder&&p.data.selectedOrder.orderNumberTail,focused:p.data.composerFocused,keyboardHeight:p.data.keyboardHeight,sending:p.data.sending,error:p.data.error,pending:p.data.pendingMessage&&p.data.pendingMessage.deliveryLabel}}") ?? {};

const evidence: Array<Record<string, unknown>> = [];
async function capture(id: string, title: string, authority: string, expected?: Record<string, unknown>): Promise<void> {
  await delay(280);
  const current = state();
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (current[key] !== value) throw new Error(`${id}: ${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(current[key])}`);
  }
  const file = `screenshots/${id}.png`;
  const absolute = join(output, file);
  const shot = run("runtime", "simulator_screenshot", ["--path", absolute, "--wait", "0", "--optimize=false"]);
  const bytes = await readFile(absolute);
  evidence.push({ id, title, authority, route: current.route, file,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
    widthPx: shot.imageWidth, heightPx: shot.imageHeight,
    packageSourceSha256: inspection.actual.sourceSha256, observed: current });
  process.stdout.write(`${id}: ${JSON.stringify(current)}\n`);
}

const member = "pages/support/index";
await open(member);
await capture("01-empty-disabled-safe-area", "空白三行、禁用发送、iPhone 模拟器安全区", "native_local_api", { input: "", sendEnabled: false });
action("input", ".support-input", "Composer 一行文字");
await capture("02-one-line-active", "一行内容，发送激活", "native_input_event", { lineCount: 1, capped: false, sendEnabled: true });
action("input", ".support-input", "第一行\n第二行\n第三行");
await capture("03-three-lines", "三行仍在默认高度", "native_input_event", { lineCount: 3, capped: false });
action("input", ".support-input", "第一行\n第二行\n第三行\n第四行\n第五行\n第六行");
await capture("04-six-lines-expanded", "六行向上自然扩展", "native_input_event", { lineCount: 6, capped: false });
action("input", ".support-input", "第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行");
await capture("05-eight-lines-internal-scroll", "八行封顶并在 textarea 内滚动", "native_input_event", { lineCount: 8, capped: true });
action("input", ".support-input", "这是一段用于验证文本换行和图标避让的较长正文。\n第二行继续说明订单和护理疑问。\n第三行保留上下文。\n第四行确认按钮位置。\n第五行确认边框。\n第六行确认滚动上限。\n第七行不让文本压住图标。\n第八行仍可编辑。");
await capture("06-long-copy-fixed-icons", "长正文下三个图标不漂移或遮挡", "native_input_event", { capped: true, sendEnabled: true });

// The DevTools simulator does not paint a phone soft keyboard. This frame
// records the focus/inset presentation fixture only, never keyboard E2E.
evaluate("function(){var p=getCurrentPages().slice(-1)[0];p.setData({composerFocused:true,keyboardHeight:300});return {route:p.route}}");
await capture("07-keyboard-inset-fixture", "模拟键盘高度与 focus 的布局（非软键盘实测）", "simulated_keyboard_inset", { keyboardHeight: 300, focused: true });
evaluate("function(){var p=getCurrentPages().slice(-1)[0];p.setData({composerFocused:false,keyboardHeight:0});return {route:p.route}}");
action("tap", ".support-tool:nth-child(1)");
await capture("08-image-entry-sheet", "图片入口真实弹出相册/拍照", "native_action_local", { sheet: true, sheetMode: "image" });
action("tap", ".support-sheet__cancel");
action("tap", ".support-tool:nth-child(2)");
await capture("09-attachment-entry-sheet", "回形针只提供本人订单", "native_action_local", { sheet: true, sheetMode: "attachment" });
action("tap", ".support-sheet__options button");
await delay(800);
await capture("10-owned-order-picker", "真实本地接口返回本人可关联订单", "native_action_local_api", { picker: true });
action("tap", ".support-order-choice");
await capture("11-order-draft-send-active", "本人订单与长正文共同保留且可发送", "native_action_local_api", { sendEnabled: true });
action("tap", ".support-tool--send");
for (let attempt = 0; attempt < 16 && (state().sending || state().order); attempt += 1) await delay(250);
await capture("12-send-ack-reset", "服务端确认后清草稿且高度回落", "native_action_local_api", { input: "", order: null, lineCount: 1, capped: false, sendEnabled: false, sending: false, error: "" });

// Separate scroll presentation state; do not mix synthetic messages with the
// local API send assertion above. No synthetic message is written to the DB.
evaluate(`function(){var p=getCurrentPages().slice(-1)[0];p.stopPolling();p.clearPresenceTimer();var a=[];for(var i=1;i<=30;i++)a.push({id:"composer-scroll-"+i,sequence:i,senderType:i%2?"user":"admin",body:"本地滚动条位置消息 "+i,contentType:"text",createdAt:"2026-09-12T01:"+String(i).padStart(2,"0")+":00.000Z",attachments:[],orderCard:null,deliveryState:"server_accepted"});p.setData({messages:p.present(a,p.data.conversation,p.data.presence),anchor:"support-30"});return {route:p.route}}`);
await capture("13-thread-scrollbar-near-edge", "30 条消息时滚动条紧贴右缘", "runtime_presentation_fixture", { sendEnabled: false });

const admin = "pages/management-support-chat/index";
await open(admin, fixture.routes.managementSupportChat.query);
// The isolated fixture grants local admin roles; these frames never exercise
// a production operator or expose real customer data.
evaluate("function(){var p=getCurrentPages().slice(-1)[0];p.stopPolling();p.clearPresenceTimer();p.setData({loading:false,busy:false,input:'',composerLineCount:1,composerCapped:false,composerSendEnabled:false,assignedToMe:true,conversation:Object.assign({},p.data.conversation,{status:'human_active'}),aiProviderAvailable:false});return {route:p.route}}");
await capture("14-admin-empty", "人工客服文本回复默认三行", "runtime_presentation_fixture", { input: "", sendEnabled: false });
action("input", ".operator-input", "人工回复第一行\n第二行\n第三行\n第四行\n第五行\n第六行");
await capture("15-admin-six-lines", "人工客服六行向上扩展", "native_input_event_on_role_fixture", { lineCount: 6, capped: false, sendEnabled: true });
action("input", ".operator-input", "第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行");
await capture("16-admin-eight-lines-capped", "人工客服超限后内部滚动与固定发送键", "native_input_event_on_role_fixture", { lineCount: 8, capped: true });

await writeFile(join(output, "visual-evidence-manifest.json"), JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  packageSourceSha256: inspection.actual.sourceSha256,
  environment: { tool: "WeChat DevTools Stable 2.02.2608070 + wechatide 0.3.9", scope: fixture.scope, origin: fixture.origin, database: fixture.database },
  screenshots: evidence,
  exclusions: ["physical iOS/Android keyboard", "real photo-picker/album/camera media upload", "production data", "payment", "formal Mini Program upload"]
}, null, 2) + "\n");
process.stdout.write(JSON.stringify({ screenshots: evidence.length, sourceSha256: inspection.actual.sourceSha256, output }, null, 2) + "\n");
