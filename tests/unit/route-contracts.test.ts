import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@cisme/contracts";
import { assertEventCoverage, assertOperationCoverage, documentedOperations } from "../../scripts/route-contract-lib";

const server=readFileSync("services/api/src/server.ts","utf8");
const spec=readFileSync("openapi/openapi.yaml","utf8");
const catalog=readFileSync("docs/EVENT-CATALOG.md","utf8");

describe("current API and event catalog coverage",()=>{
  it("matches every registered versioned method to a concrete documented operation",()=>{
    expect(assertOperationCoverage(server,spec)).toBeGreaterThan(170);
    expect(documentedOperations(spec)).not.toContainEqual({method:"POST",path:"/v1/care-cycles/{cycleId}/{action}"});
  });

  it("fails when a newly registered method is omitted from OpenAPI",()=>{
    const removed=spec.replace(
      "  /v1/management/commission-rates/pending:\n    get:",
      "  /v1/management/commission-rates/pending:\n    omitted:");
    expect(removed).not.toBe(spec);
    expect(()=>assertOperationCoverage(server,removed)).toThrow("GET /v1/management/commission-rates/pending");
  });

  it("matches typed events and fails when a new event row disappears",()=>{
    expect(assertEventCoverage(EVENT_TYPES,catalog)).toBe(EVENT_TYPES.length);
    const removed=catalog.replace(/^\| `commerce\.order\.paid\.v1` \|.*\n/m,"");
    expect(removed).not.toBe(catalog);
    expect(()=>assertEventCoverage(EVENT_TYPES,removed)).toThrow(/commerce\.order\.paid\.v1/);
  });
});
