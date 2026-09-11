import { createHash } from "node:crypto";
import { DomainError } from "@cisme/domain";

export const SUPPORT_AI_STATUS = "PROVIDER INTEGRATION PENDING" as const;
export type SupportAiCitation = { sourceId: string; version: string };
export type SupportAiSuggestion = { text: string; citations: SupportAiCitation[]; confidence: number; handoffReason: string | null };
export type ModelSafeSupportProjection = { conversationId: string; status: string; messages: Array<{ sequence: number; senderType: string; body: string }> };
export interface SupportAiProvider {
  readonly id: string;
  readonly available: boolean;
  suggest(input: { conversation: ModelSafeSupportProjection; knowledge: ApprovedKnowledgeSource[] }): Promise<SupportAiSuggestion>;
}
export type ApprovedKnowledgeSource = { id: string; version: string; title: string; content: string; sha256: string; approved: true };

export class ApprovedKnowledgeRegistry {
  private readonly sources = new Map<string, ApprovedKnowledgeSource>();
  constructor(sources: ApprovedKnowledgeSource[]) {
    for (const source of sources) {
      if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(source.id) || !source.version.trim() || !source.title.trim() || !source.content.trim()) throw new Error("KNOWLEDGE_SOURCE_INVALID");
      if (createHash("sha256").update(source.content).digest("hex") !== source.sha256) throw new Error("KNOWLEDGE_SOURCE_HASH_MISMATCH");
      const key = `${source.id}@${source.version}`;
      if (this.sources.has(key)) throw new Error("KNOWLEDGE_SOURCE_DUPLICATE");
      this.sources.set(key, Object.freeze({ ...source }));
    }
  }
  list(): ApprovedKnowledgeSource[] { return [...this.sources.values()]; }
  has(citation: SupportAiCitation): boolean { return this.sources.has(`${citation.sourceId}@${citation.version}`); }
}

export type ReadonlyToolContext = { memberId: string; conversationId: string };
export type ReadonlyToolHandler = (args: Record<string, unknown>, context: ReadonlyToolContext) => Promise<Record<string, unknown>>;
const SAFE_TOOL_NAMES = new Set(["catalog_public_summary", "member_support_summary", "support_conversation_status"]);
function containsAuthorityOverride(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => /^(member_?id|user_?id|principal_?id|sql|query|url|uri)$/i.test(key) || containsAuthorityOverride(nested));
}
export class ReadonlyAiToolRegistry {
  private readonly handlers = new Map<string, ReadonlyToolHandler>();
  register(name: string, handler: ReadonlyToolHandler): void {
    if (!SAFE_TOOL_NAMES.has(name) || this.handlers.has(name)) throw new Error("AI_TOOL_NOT_ALLOWLISTED");
    this.handlers.set(name, handler);
  }
  names(): string[] { return [...this.handlers.keys()].sort(); }
  async execute(name: string, args: Record<string, unknown>, context: ReadonlyToolContext): Promise<Record<string, unknown>> {
    const handler = this.handlers.get(name);
    if (!handler) throw new DomainError("AI_TOOL_NOT_ALLOWED", "The requested AI tool is not allowlisted", 403);
    if (containsAuthorityOverride(args)) throw new DomainError("AI_TOOL_SCOPE_OVERRIDE_FORBIDDEN", "Tool scope comes from the authenticated server context", 403);
    return handler(Object.freeze({ ...args }), Object.freeze({ ...context }));
  }
}

export class DisabledSupportAiProvider implements SupportAiProvider {
  readonly id = "disabled"; readonly available = false;
  async suggest(): Promise<SupportAiSuggestion> { throw new DomainError("SUPPORT_AI_PROVIDER_PENDING", SUPPORT_AI_STATUS, 503); }
}

export class SupportAiBoundary {
  constructor(private readonly provider: SupportAiProvider, private readonly knowledge: ApprovedKnowledgeRegistry, private readonly timeoutMs = 4_000) {}
  status() { return { status: SUPPORT_AI_STATUS, providerId: this.provider.id, providerAvailable: this.provider.available, approvedKnowledgeSources: this.knowledge.list().map(({ id, version, title, sha256 }) => ({ id, version, title, sha256 })), autoSendEnabled: false, businessWriteToolsEnabled: false }; }
  async suggestedReply(conversation: ModelSafeSupportProjection): Promise<SupportAiSuggestion> {
    if (!this.provider.available) throw new DomainError("SUPPORT_AI_PROVIDER_PENDING", SUPPORT_AI_STATUS, 503);
    const knowledge = this.knowledge.list();
    if (!knowledge.length) throw new DomainError("SUPPORT_AI_KNOWLEDGE_PENDING", "No approved knowledge source is available", 503);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer=setTimeout(()=>reject(new DomainError("SUPPORT_AI_TIMEOUT", "AI suggestion timed out; use human handling", 503)),this.timeoutMs); });
      const output = await Promise.race([this.provider.suggest({ conversation, knowledge }), timeout]);
      const text=typeof output.text==="string"?output.text.trim():"";
      if (!text || Array.from(text).length>4000) throw new DomainError("SUPPORT_AI_OUTPUT_INVALID", "AI suggestion output is invalid", 502);
      if (!Number.isFinite(output.confidence)||output.confidence<0||output.confidence>1) throw new DomainError("SUPPORT_AI_OUTPUT_INVALID", "AI confidence is invalid", 502);
      if (!Array.isArray(output.citations)||!output.citations.length||output.citations.some((citation)=>!this.knowledge.has(citation))) throw new DomainError("SUPPORT_AI_UNGROUNDED", "AI suggestion lacks an approved source; use human handling", 409);
      return { text, citations: output.citations, confidence: output.confidence, handoffReason: output.handoffReason??null };
    } finally { if(timer)clearTimeout(timer); }
  }
}
