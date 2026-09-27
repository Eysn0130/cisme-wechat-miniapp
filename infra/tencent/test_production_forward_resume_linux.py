"""Hermetic Linux recovery exercise, with real child processes and a disk fact.

Run in an unnetworked disposable root container. Cloud identity, GitHub, database
and qualification boundaries are synthetic; no fixture is a production approval.
The production apply/resume record, locking, cutover, switching and PID/cwd health
engine run unchanged. R3 supplies the separate real PostgreSQL migration evidence.
"""
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.request

spec=importlib.util.spec_from_file_location('resume_linux',Path(__file__).with_name('production-release.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0,'requires disposable Linux root container')
class LinuxForwardResume(unittest.TestCase):
    def test_activation_failure_repair_requalify_resume_and_read_business(self):
        with tempfile.TemporaryDirectory(prefix='cisme-r4-linux-') as temporary,ExitStack() as stack:
            root=Path(temporary);releases=root/'releases';releases.mkdir()
            old=releases/'old-fixture';old.mkdir();new=releases/'new-fixture';new.mkdir()
            current=root/'current';current.symlink_to(old)
            live=root/'runtime.env';live.write_text('APP_ENV=staging\n')
            candidate=root/'candidate.env';candidate.write_text('APP_ENV=production\nCISME_MIGRATION_READ_ONLY=true\n')
            candidate.chmod(0o600);live.chmod(0o600)
            facts=root/'business.json';facts.write_text(json.dumps(['fact-before-upgrade']))
            migration=root/'migration.done';failure=root/'operational-fault';failure.touch()
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            api=new/'api.py';api.write_text('''import http.server,json,pathlib,sys
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  body=pathlib.Path(sys.argv[2]).read_bytes();self.send_response(200);self.end_headers();self.wfile.write(body)
 def log_message(self,*a):pass
http.server.HTTPServer(('127.0.0.1',int(sys.argv[1])),Handler).serve_forever()
''')
            worker=new/'worker.py';heartbeat=root/'heartbeat'
            worker.write_text('import pathlib,sys,time\nwhile True:\n pathlib.Path(sys.argv[1]).write_text(str(time.time_ns()))\n time.sleep(.05)\n')
            migrator=new/'migrate.py'
            migrator.write_text('''import json,pathlib,sys
marker=pathlib.Path(sys.argv[1]);facts=pathlib.Path(sys.argv[2])
if not marker.exists():
 data=json.loads(facts.read_text());data.append('fact-after-protection-point');facts.write_text(json.dumps(data));marker.touch();print(json.dumps({'applied':'synthetic-step'}))
''')
            (new/'release-manifest.json').write_text('{}');(new/'release-manifest.json').chmod(0o600)
            processes={};events=[];all_pids=[]
            def stop():
                for process in processes.values():
                    if process.poll() is None:process.terminate()
                for process in processes.values():process.wait(timeout=5)
                processes.clear()
            stack.callback(stop)
            def command(args,**kwargs):
                if args[0]=='systemctl':
                    if args[1]=='stop':stop();events.append('stop');return b''
                    if args[1]=='start':
                        processes[m.UNITS[0]]=subprocess.Popen([sys.executable,str(api),str(port),str(facts)],cwd=new,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                        processes[m.UNITS[1]]=subprocess.Popen([sys.executable,str(worker),str(heartbeat)],cwd=new,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                        all_pids.extend(p.pid for p in processes.values());events.append('start');return b''
                    if args[1]=='is-active':return '\n'.join('active' if u in processes and processes[u].poll() is None else 'inactive' for u in args[2:]).encode()
                    if args[1]=='show':
                        p=processes.get(args[2]);running=p is not None and p.poll() is None
                        return (('active' if running else 'inactive') if 'ActiveState' in args else str(p.pid if running else 0)).encode()
                if args[-1]=='up':
                    result=subprocess.run([sys.executable,str(migrator),str(migration),str(facts)],cwd=new,capture_output=True,check=True)
                    events.append('migrate');return result.stdout
                raise AssertionError('unexpected command '+str(args))
            original_env=m.sha(live.read_bytes());candidate_sha=m.sha(candidate.read_bytes())
            previous={'directory':str(old)};manifest_sha=m.sha((new/'release-manifest.json').read_bytes())
            def preflight(directory,env,*,services_stopped=False,resume_plan=None):
                self.assertEqual(Path(directory),new);self.assertEqual(Path(env),candidate)
                if services_stopped:m.require_services_stopped()
                if resume_plan:self.assertEqual(resume_plan['candidateEnvironmentSha256'],candidate_sha)
                return {'main':{'sha':'a'*40,'tree':'b'*40,'ciRunId':1},'previous':previous,
                        'candidateDirectory':str(new),'manifestSha256':manifest_sha,
                        'candidateEnvironmentSha256':candidate_sha,'liveEnvironmentSha256':m.sha(live.read_bytes()),
                        'migrationPlan':{'applied':int(migration.exists()),'pending':[] if migration.exists() else ['synthetic-step']}}
            reviewed={}
            def qualify(path,plan):
                self.assertEqual(reviewed['live'],plan['liveEnvironmentSha256'])
                self.assertEqual(reviewed['pending'],plan['migrationPlan']['pending'])
                events.append('requalify')
                return {'recoveryMode':'forward-only','candidateHead':'a'*40,'manifestSha256':manifest_sha,
                        'candidateEnvironmentSha256':candidate_sha,'backup':{'sha256':'d'*64},'reviewReference':'SYNTHETIC-NOT-PRODUCTION'}
            def ready():
                if failure.exists():raise m.observe.target.Refused('SYNTHETIC_OPERATIONAL_FAULT')
                with urllib.request.urlopen('http://127.0.0.1:'+str(port),timeout=2) as response:
                    self.assertEqual(json.load(response),['fact-before-upgrade','fact-after-protection-point'])
                self.assertTrue(heartbeat.exists())
            real_healthy=m.healthy
            def healthy(directory):
                # Avoid thirty intentional failed polls. The repaired run uses
                # the real PID/cwd checks and an actual HTTP business read.
                if failure.exists():raise m.observe.target.Refused('SYNTHETIC_OPERATIONAL_FAULT')
                return real_healthy(directory)
            for name,value in [('ROOT',root),('CURRENT',current),('LIVE',live),('command',command),
                               ('preflight',preflight),('qualifications',qualify),('local_https_ready',ready),('healthy',healthy)]:
                stack.enter_context(patch.object(m,name,value))
            stack.enter_context(patch.object(m.observe,'identity',return_value={'fixtureOnly':True}))
            stack.enter_context(patch.object(m.observe,'guard_for_upgrade',return_value={'fixtureOnly':True}))
            stack.enter_context(patch.object(m.journal,'query',return_value=0))
            stack.enter_context(patch.object(m.pwd,'getpwnam',return_value=SimpleNamespace(pw_gid=0)))
            reviewed.update(live=original_env,pending=['synthetic-step'])
            with self.assertRaisesRegex(m.observe.target.Refused,'UPGRADE_FAILED_FORWARD_RECOVERY_REQUIRED'):
                m.apply(new,candidate,'/synthetic-only','SYNTHETIC-NOT-PRODUCTION')
            failed=next((root/'production-upgrades').iterdir())
            self.assertTrue(json.loads((failed/'forward-recovery-required.json').read_text())['servicesStopped'])
            self.assertEqual(processes,{});self.assertEqual(current.resolve(),new)
            self.assertFalse((failed/'deployed.json').exists())
            # Repair the environmental fault, retaining the exact candidate and
            # all post-protection facts. Explicitly re-review remaining inputs.
            failure.unlink();reviewed.update(live=candidate_sha,pending=[])
            report=m.apply(new,candidate,'/synthetic-only','SYNTHETIC-NOT-PRODUCTION',failed)
            self.assertTrue(report['deployed']);self.assertFalse(report['databaseRestored'])
            self.assertEqual(json.loads(facts.read_text()),['fact-before-upgrade','fact-after-protection-point'])
            before=heartbeat.read_text();time.sleep(.1);self.assertNotEqual(heartbeat.read_text(),before)
            self.assertEqual(len(list((root/'production-upgrades').glob('*/deployed.json'))),1)
            self.assertEqual(events.count('migrate'),2);self.assertEqual(events.count('requalify'),2)
            stop()
            self.assertTrue(all(not Path('/proc/'+str(pid)).exists() for pid in all_pids))


if __name__=='__main__':unittest.main()
