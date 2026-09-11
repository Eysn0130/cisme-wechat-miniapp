/// <reference types="miniprogram-api-typings" />
/// <reference path="../../apps/miniprogram/types/global.d.ts" />
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { centsToYuan, parseYuanToCents } from "../../apps/miniprogram/services/commerce";

const root=resolve(import.meta.dirname,"../..");
describe("R4-A native commerce boundary",()=>{
  it("parses yuan text exactly into integer cents without floating point",()=>{
    expect(parseYuanToCents("269")).toBe(26900);expect(parseYuanToCents("269.0")).toBe(26900);expect(parseYuanToCents("0.01")).toBe(1);expect(centsToYuan(26901)).toBe("269.01");
    for(const invalid of ["","0","01.00","1.001","1e2","NaN","-1","1000000.01","1,000.00"])expect(()=>parseYuanToCents(invalid)).toThrow("PRICE_YUAN_INVALID");
  });
  it("registers native catalog and isolated order routes without a client payment-success path",async()=>{
    const app=JSON.parse(await readFile(resolve(root,"apps/miniprogram/app.json"),"utf8"));const routes=[...(app.pages??[]),...(app.subPackages??[]).flatMap((item:{root:string;pages:string[]})=>item.pages.map(page=>`${item.root}/${page}`))];
    for(const route of ["pages/management-catalog/index","pages/management-product/index","pages/checkout/index","pages/orders/index","pages/order-detail/index","pages/management-orders/index","pages/management-order-detail/index"])expect(routes).toContain(route);
    const detail=await readFile(resolve(root,"apps/miniprogram/pages/product/index.ts"),"utf8");expect(detail).toContain("catalogDetail(this.data.id)");expect(detail).not.toContain("catalog.items.find");
    const orderSources=await Promise.all(["services/orders.ts","pages/checkout/index.ts","pages/order-detail/index.ts"].map(path=>readFile(resolve(root,"apps/miniprogram",path),"utf8")));
    expect(orderSources.join("\n")).not.toContain("requestPayment");expect(orderSources.join("\n")).not.toContain("payment-success");
  });
  it("keeps qualification, publication and inventory as separate mobile commands",async()=>{
    const page=await readFile(resolve(root,"apps/miniprogram/pages/management-product/index.ts"),"utf8");for(const command of ["qualifyProduct","publishProduct","adjustInventory","expectedPriceVersion","expectedVersion"])expect(page).toContain(command);
    expect(page).toContain("确认可售须填写证据引用");expect(page).toContain("服务端保存");
  });
});
