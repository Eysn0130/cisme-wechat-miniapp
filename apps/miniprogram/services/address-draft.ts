export type AddressLabel = "home" | "company" | "other";
export type AddressField = "recipientName" | "phone" | "region" | "detail" | "postalCode" | "label" | "isDefault";
export type AddressRegionSource = "empty" | "parsed" | "wechat" | "picker" | "server";

export interface AddressDraft {
  id: string;
  recipientName: string;
  phone: string;
  region: string[];
  regionText: string;
  regionCodes: string[];
  regionSource: AddressRegionSource;
  regionNeedsConfirmation: boolean;
  detail: string;
  postalCode: string;
  nationalCode: string;
  label: AddressLabel;
  isDefault: boolean;
  expectedVersion: number;
  clientRequestKey: string;
  manualTouched: Record<AddressField, boolean>;
}

export interface AddressDraftPatch {
  recipientName?: string;
  phone?: string;
  region?: string[];
  regionCodes?: string[];
  regionSource?: AddressRegionSource;
  regionNeedsConfirmation?: boolean;
  detail?: string;
  postalCode?: string;
  nationalCode?: string;
}

export interface AddressValidation {
  valid: boolean;
  firstField: AddressField | "";
  errors: Partial<Record<AddressField, string>>;
}

export interface QuickAddressParseResult {
  status: "success" | "partial" | "failed";
  patch: AddressDraftPatch;
  recognized: string[];
  missing: string[];
  warnings: string[];
}

export interface StoredAddressDraft {
  schema: 1;
  ownerMemberId: string;
  savedAt: number;
  expiresAt: number;
  quickInput: string;
  draft: AddressDraft;
}

const requiredLabels: Record<Exclude<AddressField, "label" | "isDefault" | "postalCode">, string> = {
  recipientName: "收货人",
  phone: "联系电话",
  region: "所在地区",
  detail: "详细地址"
};

function requestKey(now: number, random: number): string {
  return `address-${now}-${random.toString(36).slice(2, 10)}`;
}

export function emptyAddressDraft(now = Date.now(), random = Math.random()): AddressDraft {
  return {
    id: "", recipientName: "", phone: "", region: [], regionText: "", regionCodes: [], regionSource: "empty", regionNeedsConfirmation: false,
    detail: "", postalCode: "", nationalCode: "", label: "home", isDefault: false, expectedVersion: 0,
    clientRequestKey: requestKey(now, random),
    manualTouched: { recipientName: false, phone: false, region: false, detail: false, postalCode: false, label: false, isDefault: false }
  };
}

function normalizedTriplet(values: unknown): string[] {
  return Array.isArray(values) ? [0, 1, 2].map((index) => String(values[index] ?? "").trim()) : [];
}

export function mergeAddressDraft(draft: AddressDraft, patch: AddressDraftPatch, protectManual = true): AddressDraft {
  const next: AddressDraft = { ...draft, manualTouched: { ...draft.manualTouched } };
  for (const field of ["recipientName", "phone", "detail", "postalCode"] as const) {
    if (patch[field] === undefined || (protectManual && draft.manualTouched[field])) continue;
    next[field] = String(patch[field]);
  }
  if (patch.region !== undefined && !(protectManual && draft.manualTouched.region)) {
    next.region = normalizedTriplet(patch.region);
    next.regionText = next.region.filter(Boolean).join(" ");
    next.regionCodes = normalizedTriplet(patch.regionCodes);
    next.regionSource = patch.regionSource ?? "empty";
    next.regionNeedsConfirmation = patch.regionNeedsConfirmation ?? next.regionCodes.some((code) => !code);
    next.nationalCode = String(patch.nationalCode ?? next.regionCodes[2] ?? "");
  }
  return next;
}

export function touchAddressField(draft: AddressDraft, field: AddressField, value: string | boolean | string[]): AddressDraft {
  const next = { ...draft, manualTouched: { ...draft.manualTouched, [field]: true } };
  if (field === "region") {
    next.region = normalizedTriplet(value);
    next.regionText = next.region.filter(Boolean).join(" ");
    return next;
  }
  if (field === "isDefault") next.isDefault = Boolean(value);
  else if (field === "label") next.label = value as AddressLabel;
  else next[field] = String(value) as never;
  return next;
}

function fullWidthToHalfWidth(value: string): string {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}

function captureLabel(text: string, labels: string[], max = 120): string {
  const expression = new RegExp(`(?:^|[\\n,，;；])\\s*(?:${labels.join("|")})\\s*[:：]\\s*([^\\n,，;；]{1,${max}})`, "i");
  return text.match(expression)?.[1]?.trim() ?? "";
}

function regionParts(text: string): { region: string[]; consumed: string[]; warnings: string[] } {
  const provincePattern = /(北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区|台湾省|[\u4e00-\u9fa5]{2,8}?(?:省|自治区))/;
  const provinceMatch = provincePattern.exec(text);
  if (!provinceMatch) return { region: [], consumed: [], warnings: ["未可靠识别省级地区"] };
  const province = provinceMatch[1] ?? "";
  const afterProvince = text.slice((provinceMatch.index ?? 0) + province.length);
  const municipality = /^(北京市|上海市|天津市|重庆市)$/.test(province);
  const cityMatch = /([\u4e00-\u9fa5]{2,10}?(?:市|自治州|地区|盟))/.exec(afterProvince);
  const city = cityMatch?.[1] ?? (municipality ? province : "");
  const afterCity = cityMatch ? afterProvince.slice((cityMatch.index ?? 0) + city.length) : afterProvince;
  const districtMatch = /([\u4e00-\u9fa5]{2,10}?(?:区|县|旗|市))/.exec(afterCity);
  const district = districtMatch?.[1] ?? "";
  const warnings: string[] = [];
  if (!city) warnings.push("未可靠识别城市");
  if (!district) warnings.push("未可靠识别区县");
  warnings.push("识别出的地区名称尚无行政区划 code，请用所在地选择器确认");
  return { region: [province, city, district], consumed: [province, cityMatch?.[1] ?? "", district].filter(Boolean), warnings };
}

export function parseQuickAddress(raw: string): QuickAddressParseResult {
  const text = fullWidthToHalfWidth(String(raw ?? "")).replace(/\r/g, "").replace(/[\t ]+/g, " ").trim().slice(0, 500);
  if (!text) return { status: "failed", patch: {}, recognized: [], missing: Object.values(requiredLabels), warnings: ["请先输入或粘贴地址文本"] };
  const labeledText = text.replace(/\s+(?=(?:收货人|姓名|联系人|联系电话|手机号|手机|电话|详细地址|地址|邮政编码|邮编)\s*[:：])/g, "\n");

  const explicitName = captureLabel(labeledText, ["收货人", "姓名", "联系人"], 40);
  const explicitPhone = captureLabel(labeledText, ["联系电话", "手机号", "手机", "电话"], 30);
  const explicitDetail = captureLabel(labeledText, ["详细地址", "地址"], 160);
  const explicitPostal = captureLabel(labeledText, ["邮政编码", "邮编"], 12);
  const phoneMatch = (explicitPhone || labeledText).match(/(?:\+?86[- ]?)?1[3-9]\d(?:[- ]?\d){8}|\+?[0-9][0-9 -]{5,22}[0-9]/);
  const phone = phoneMatch?.[0]?.replace(/^\+?86[- ]?/, "").replace(/[ -]/g, "").trim() ?? "";
  const postalMatch = explicitPostal.match(/[A-Za-z0-9][A-Za-z0-9 -]{1,11}/) ?? labeledText.match(/(?:邮政编码|邮编)\s*[:：]?\s*([0-9]{6})/);
  const postalCode = explicitPostal ? (postalMatch?.[0] ?? "") : (postalMatch?.[1] ?? "");
  const regionResult = regionParts(explicitDetail || text);

  let recipientName = explicitName;
  if (!recipientName && phoneMatch?.index !== undefined) {
    const beforePhone = labeledText.slice(0, phoneMatch.index).replace(/(?:收货人|姓名|联系人)\s*[:：]?/g, " ").trim();
    const candidate = beforePhone.split(/[\n,，;； ]+/).filter(Boolean).pop() ?? "";
    if (/^[\u4e00-\u9fa5A-Za-z·•]{2,40}$/.test(candidate) && !/(?:省|市|区|县|路|街|号)$/.test(candidate)) recipientName = candidate;
  }

  let detail = explicitDetail || labeledText;
  const removals = [recipientName, phoneMatch?.[0] ?? "", postalCode, ...regionResult.consumed];
  for (const value of removals.filter(Boolean)) detail = detail.replace(value, " ");
  detail = detail
    .replace(/(?:收货人|姓名|联系人|联系电话|手机号|手机|电话|详细地址|地址|邮政编码|邮编)\s*[:：]?/g, " ")
    .replace(/[\n,，;；]+/g, " ").replace(/\s+/g, " ").trim();

  const patch: AddressDraftPatch = {};
  const recognized: string[] = [];
  if (recipientName) { patch.recipientName = recipientName; recognized.push("收货人"); }
  if (phone) { patch.phone = phone; recognized.push("联系电话"); }
  if (regionResult.region.some(Boolean)) {
    patch.region = regionResult.region;
    patch.regionCodes = ["", "", ""];
    patch.regionSource = "parsed";
    patch.regionNeedsConfirmation = true;
    recognized.push("地区名称");
  }
  if (detail.length >= 2) { patch.detail = detail; recognized.push("详细地址"); }
  if (postalCode) { patch.postalCode = postalCode; recognized.push("邮编"); }

  const missing: string[] = [];
  if (!recipientName) missing.push("收货人");
  if (!phone) missing.push("联系电话");
  if (regionResult.region.length !== 3 || regionResult.region.some((item) => !item)) missing.push("完整省市区");
  if (detail.length < 2) missing.push("详细地址");
  const warnings = [...regionResult.warnings];
  if (!explicitName && recipientName) warnings.push("收货人由号码前文本推测，请核对");
  const status = recognized.length === 0 ? "failed" : missing.length ? "partial" : "success";
  if (status === "failed") warnings.unshift("未能可靠拆分这段文本，原文已保留");
  return { status, patch, recognized, missing, warnings: Array.from(new Set(warnings)) };
}

export function validateAddressDraft(draft: AddressDraft): AddressValidation {
  const errors: Partial<Record<AddressField, string>> = {};
  const nameLength = Array.from(draft.recipientName.trim()).length;
  if (nameLength < 1 || nameLength > 40) errors.recipientName = "请填写 1–40 字的收货人姓名";
  if (!/^\+?[0-9\s-]{6,24}$/.test(draft.phone.trim())) errors.phone = "请填写可用于配送联系的电话号码";
  if (draft.region.length !== 3 || draft.region.some((item) => !item)) errors.region = "请选择完整的省、市、区县";
  else if (draft.regionNeedsConfirmation || draft.regionCodes.length !== 3 || draft.regionCodes.some((code) => !code)) errors.region = "请用所在地选择器确认行政区划";
  const detailLength = Array.from(draft.detail.trim()).length;
  if (detailLength < 2 || detailLength > 120) errors.detail = "请填写 2–120 字的街道和门牌信息";
  if (draft.postalCode && !/^[A-Za-z0-9 -]{2,12}$/.test(draft.postalCode.trim())) errors.postalCode = "邮政编码格式不正确";
  const firstField = (["recipientName", "phone", "region", "detail", "postalCode"] as AddressField[]).find((field) => errors[field]) ?? "";
  return { valid: !firstField, firstField, errors };
}

export function makeStoredAddressDraft(ownerMemberId: string, draft: AddressDraft, quickInput: string, now = Date.now()): StoredAddressDraft {
  return { schema: 1, ownerMemberId, savedAt: now, expiresAt: now + 24 * 60 * 60 * 1000, quickInput: quickInput.slice(0, 500), draft };
}

export function recoverStoredAddressDraft(value: unknown, ownerMemberId: string, now = Date.now()): StoredAddressDraft | null {
  const candidate = value as Partial<StoredAddressDraft> | null;
  if (!candidate || candidate.schema !== 1 || candidate.ownerMemberId !== ownerMemberId || !candidate.draft || !Number.isFinite(candidate.expiresAt) || Number(candidate.expiresAt) <= now) return null;
  return candidate as StoredAddressDraft;
}
