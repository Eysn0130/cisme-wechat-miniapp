import { expect, it, vi } from "vitest";
import { memberDisplayIdentities } from "../../services/api/src/displayIdentity";
import { communityIdentityBadge, identityLabel, claimIdentityBadgeIntro, memberIdentityBadge } from "../../apps/miniprogram/services/display-identity";
import { officialEditorialPublisherId } from "../../apps/miniprogram/services/editorial-publisher";

it("uses effective administrative and explicit display grants together, and counts a sharing officer independently", async () => {
  const rows = [
    { id: "ordinary", grants: [], officer: false },
    { id: "officer", grants: [], officer: true },
    { id: "administrator", grants: ["community.moderate", "community.admin_badge"], officer: true },
    { id: "designationOnly", grants: ["community.admin_badge"], officer: false },
    { id: "support", grants: ["support.read", "support.reply", "community.admin_badge"], officer: false },
    { id: "finance", grants: ["commerce.refund.approve", "commission.settlement.approve"], officer: false },
    { id: "manager", grants: ["member.manage"], officer: true }
  ];
  const query = vi.fn().mockResolvedValue({ rows });
  const ids = rows.map(row => row.id);
  const projection = await memberDisplayIdentities({ query } as any, "test", ids);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]![0]).toContain("g.revoked_at IS NULL");
  expect(query.mock.calls[0]![1].slice(0, 2)).toEqual([ids, "test"]);
  expect([...projection].map(([id, role]) => [id, role.privateIdentity, role.publicBadge])).toEqual([
    ["ordinary", "member", undefined],
    ["officer", "sharing-officer", "sharing-officer"],
    ["administrator", "administrator", "administrator"],
    ["designationOnly", "member", undefined],
    ["support", "support", undefined],
    ["finance", "member", undefined],
    ["manager", "administrator", "sharing-officer"]
  ]);
});

it("reserves the official mark for the official account and plays an intro only once for a given identity", () => {
  expect(communityIdentityBadge("official","ordinary")).toBe("");
  expect(communityIdentityBadge("support","ordinary")).toBe("");
  expect(communityIdentityBadge(undefined,officialEditorialPublisherId)).toBe("official");
  expect(identityLabel("member")).toBe("普通会员");
  expect(identityLabel("support")).toBe("官方客服");
  expect(identityLabel(undefined)).toBe("");
  expect(memberIdentityBadge("sharing-officer")).toBe("sharing-officer");
  expect(memberIdentityBadge("administrator")).toBe("administrator");
  expect(memberIdentityBadge("support")).toBe("support");
  expect(memberIdentityBadge("member")).toBe("");
  expect(memberIdentityBadge("official")).toBe("");
  expect(claimIdentityBadgeIntro("sample-author","administrator")).toBe(true);
  expect(claimIdentityBadgeIntro("sample-author","administrator")).toBe(false);
  expect(claimIdentityBadgeIntro("another-author","administrator")).toBe(true);
});
