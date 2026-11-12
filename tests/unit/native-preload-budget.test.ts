import {readFileSync} from "node:fs";
import {expect,it} from "vitest";
import {inspectMiniProgramPackage} from "../../scripts/miniprogram-package-lib";

it("keeps native next-page code preloads within the shared source-package budget",async()=>{
  const app=JSON.parse(readFileSync("apps/miniprogram/app.json","utf8"));
  const inspection=await inspectMiniProgramPackage();
  const roots=new Set<string>(app.subPackages.map((pack:any)=>pack.root));
  const routes=new Set(inspection.routes), groups=new Map<string,Set<string>>();
  for(const [route,rule]of Object.entries(app.preloadRule) as Array<[string,{network:string;packages:string[]}]>){
    expect(routes.has(route),route).toBe(true);
    expect(["all","wifi"]).toContain(rule.network);
    const source=[...roots].find(root=>route.startsWith(root+"/"))??"main";
    const targets=groups.get(source)??new Set<string>();groups.set(source,targets);
    for(const target of rule.packages){
      expect(roots.has(target),target).toBe(true);expect(target).not.toBe(source);
      expect(["pages/task","pages/submit","pages/progress"]).not.toContain(target);
      // Large galleries must not silently consume mobile data during a tab visit.
      if(inspection.actual.subpackageBytes[target]!>400*1024)expect(rule.network).toBe("wifi");
      targets.add(target);
    }
  }
  // WeChat's 2 MB budget is the UNION for all trigger pages in the same package.
  for(const [source,targets]of groups){
    const bytes=[...targets].reduce((sum,root)=>sum+inspection.actual.subpackageBytes[root]!,0);
    expect(bytes,source).toBeLessThanOrEqual(2*1024*1024);
  }
});
