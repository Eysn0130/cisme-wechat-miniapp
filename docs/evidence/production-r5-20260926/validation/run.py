import concurrent.futures,subprocess,json,pathlib,datetime,os
root=pathlib.Path('/Users/mini/CISME');out=root/'tmp/production-r5-f627-final'
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=root,text=True).strip()
groups={
 'tests': [('unit',['npm','test']),('integration',['npm','run','test:integration'])],
 'build': [('build',['npm','run','build']),('contracts',['npm','run','lint:contracts']),('package',['npm','run','miniprogram:package-gate']),('routes',['npm','run','miniprogram:route-audit']),('design-status',['npm','run','design:qa:status'])],
 'audit': [('audit-production',['npm','audit','--omit=dev','--audit-level=high']),('audit-all',['npm','audit','--audit-level=high']),('secrets',['tmp/release-preparation/gitleaks/gitleaks','git','.','--no-banner','--no-color','--redact=100']),('deployment',['python3','-m','unittest','discover','-s','infra/tencent','-p','test_staging_*.py']),('monitor',['python3','-B','-m','unittest','discover','-s','infra/tencent','-p','test_production_*.py']),('linux-resume',['docker','run','--rm','--network','none','--user','0','--mount','type=bind,src=/Users/mini/CISME/infra/tencent,dst=/checks,readonly','--entrypoint','/usr/bin/python3','openclaw-sandbox:bookworm-slim','-B','/checks/test_production_forward_resume_linux.py'])]
}
env=dict(os.environ,CISME_TEST_POSTGRES_IMAGE='postgres:16.15-alpine')
def run_group(group):
 result=[]
 for name,args in groups[group]:
  start=datetime.datetime.now(datetime.timezone.utc).isoformat()
  with (out/(name+'.log')).open('wb') as log:
   try:code=subprocess.run(args,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=1800).returncode
   except subprocess.TimeoutExpired:code=124
  item={'check':name,'command':args,'exitCode':code,'startedAtUtc':start,'finishedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'log':name+'.log'};result.append(item)
  print(json.dumps({'check':name,'exitCode':code}),flush=True)
 return result
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
 checks=[item for items in executor.map(run_group,groups) for item in items]
report={'head':head,'tree':tree,'postgresImage':env['CISME_TEST_POSTGRES_IMAGE'],'nodeVersion':subprocess.check_output(['node','--version'],text=True).strip(),'checks':checks,'allPassed':all(x['exitCode']==0 for x in checks),'remoteCI':False}
(out/'results.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'finished':True,'allPassed':report['allPassed']}),flush=True)
