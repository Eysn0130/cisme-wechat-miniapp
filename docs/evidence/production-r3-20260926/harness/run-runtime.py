import pathlib,json,subprocess,os,pwd,shutil,hashlib
b=pathlib.Path('/opt/cisme/rehearsals/r3-20260926-1100');u=pwd.getpwnam('cisme')
s=pathlib.Path('/home/ubuntu/runtime-harness.js');assert hashlib.sha256(s.read_bytes()).hexdigest()=='b814a8d789790fd2939627b91a9c580ddb4380ab107a1995fa3a7402380dfcf1'
for name in ['harness','work','tmp']:
 p=b/name;p.mkdir(mode=0o700,exist_ok=True);os.chown(p,u.pw_uid,u.pw_gid)
p=b/'harness/runtime-harness.mjs';shutil.copyfile(s,p);os.chown(p,u.pw_uid,u.pw_gid);os.chmod(p,0o600)
n=b/'harness/node_modules'
if not n.exists():n.symlink_to(b/'candidate/node_modules')
r=subprocess.run(['systemd-run','--unit=cisme-r3-runtime-1100','--wait','--pipe','--collect','--property=User=cisme','--property=WorkingDirectory='+str(b/'work'),'--property=Environment=TMPDIR='+str(b/'tmp'),'--property=IPAddressDeny=any','--property=IPAddressAllow=localhost','--property=NoNewPrivileges=true','/opt/node-v24.14.0-linux-x64/bin/node',str(p)],text=True,capture_output=True)
(b/'logs/runtime-harness.log').write_text(r.stdout+r.stderr);print('runtimeExit',r.returncode);print(r.stdout[-2000:]);print(r.stderr[-1500:])
