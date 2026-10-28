import ast
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest
from types import SimpleNamespace,ModuleType
from unittest.mock import patch
import zlib

HERE=Path(__file__).resolve().parent
PROJECT=HERE.parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
m=load('comments_stage',HERE/'trial-editorial-comments-stage.py')
f=load('comments_finalizer',HERE/'finalize-trial-editorial-comments-stage.py')
r=load('comments_runner',HERE/'run-trial-editorial-comments-stage.py')
u=load('comments_upgrade',HERE/'trial-editorial-comments-upgrade.py')

class TarSafetyTests(unittest.TestCase):

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.owner = patch.object(m, 'OWNER', os.getuid())
        self.owner.start()
        self.addCleanup(self.owner.stop)
        top=patch.object(m,'TOP','tencent-release-fixture');top.start();self.addCleanup(top.stop)

    def archive(self, entries):
        path = self.root / ('archive-' + str(len(list(self.root.glob('archive-*')))) + '.tgz')
        with tarfile.open(path, 'w:gz') as archive:
            for name, kind, data in [(m.TOP, tarfile.DIRTYPE, None), *entries]:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.mode = 0o6777
                if kind == tarfile.REGTYPE:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
                elif kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    member.linkname = data
                    archive.addfile(member)
                else:
                    archive.addfile(member)
        return path

    def output(self):
        output = self.root / ('output-' + str(len(list(self.root.glob('output-*')))))
        output.mkdir(mode=0o700)
        return output

    def test_unfinished_template_refuses_before_target_or_writes(self):
        with patch.object(m, 'target') as target, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(), 1)
        target.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['code'], 'STAGE_FINAL_ARCHIVE_BINDING_REQUIRED')

    def test_stdin_exact_size_and_sha_binding(self):
        data = b'binary archive bytes\x00\xffsynthetic'
        with patch.object(m, 'ARCHIVE_SIZE', len(data)), patch.object(m, 'ARCHIVE_SHA256', hashlib.sha256(data).hexdigest()):
            target = self.root / 'received'
            m.receive_archive(target, io.BytesIO(data))
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            for i, bad in enumerate((data + b'x', data[:-1], b'x' * len(data))):
                with self.assertRaises(m.Refused):
                    m.receive_archive(self.root / ('bad-' + str(i)), io.BytesIO(bad))

    def test_valid_contained_npm_symlink_and_modes_under_private_umask(self):
        archive = self.archive([(m.TOP + '/node_modules/demo/bin/tool.js', tarfile.REGTYPE, b'public synthetic code'),
                                (m.TOP + '/node_modules/.bin/tool', tarfile.SYMTYPE, '../demo/bin/tool.js')])
        output = self.output()
        previous = os.umask(0o077)
        try:
            release = m.unpack(archive, output)
        finally:
            os.umask(previous)
        self.assertEqual((release / 'node_modules/.bin/tool').resolve(), release / 'node_modules/demo/bin/tool.js')
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((release / 'node_modules/demo/bin/tool.js').stat().st_mode), 0o755)
        for parent, names, files in os.walk(release):
            self.assertEqual(stat.S_IMODE(Path(parent).stat().st_mode), 0o755)

    def test_absolute_traversal_second_top_devices_fifo_and_duplicates_refused(self):
        cases = [('/etc/synthetic', tarfile.REGTYPE, b'x'),
                 (m.TOP + '/../synthetic', tarfile.REGTYPE, b'x'),
                 ('other-release/x', tarfile.REGTYPE, b'x'),
                 (m.TOP + '/device', tarfile.CHRTYPE, None),
                 (m.TOP + '/fifo', tarfile.FIFOTYPE, None)]
        for entry in cases:
            with self.subTest(entry=entry), self.assertRaises(m.Refused):
                m.unpack(self.archive([entry]), self.output())
        entry = (m.TOP + '/same', tarfile.REGTYPE, b'x')
        with self.assertRaises(m.Refused):
            m.unpack(self.archive([entry, entry]), self.output())

    def test_absolute_and_escaping_symlinks_refused(self):
        for target in ('/etc/passwd', '../../outside', '../outside/../../escape'):
            with self.subTest(target=target), self.assertRaises(m.Refused):
                m.unpack(self.archive([(m.TOP + '/node_modules/.bin/link', tarfile.SYMTYPE, target)]), self.output())

    def test_archive_child_of_symlink_or_regular_file_refused_before_extraction(self):
        for kind, data in ((tarfile.SYMTYPE, 'demo'), (tarfile.REGTYPE, b'not a directory')):
            archive = self.archive([(m.TOP + '/node_modules/a', kind, data),
                                    (m.TOP + '/node_modules/a/child', tarfile.REGTYPE, b'do not write')])
            output = self.output()
            with self.assertRaisesRegex(m.Refused, 'LINK_PARENT_REFUSED'):
                m.unpack(archive, output)
            self.assertEqual(list(output.iterdir()), [])

    def test_link_chain_dotdot_escape_refused_after_safe_private_extraction(self):
        archive = self.archive([(m.TOP + '/node_modules/dir', tarfile.SYMTYPE, '.'),
                                (m.TOP + '/node_modules/a', tarfile.SYMTYPE, 'dir/../outside')])
        with self.assertRaisesRegex(m.Refused, 'EXTERNAL_LINK_REFUSED'):
            m.unpack(archive, self.output())

    def test_contained_hardlink_only_to_archive_regular_file(self):
        archive = self.archive([(m.TOP + '/node_modules/demo/file', tarfile.REGTYPE, b'public bytes'),
                                (m.TOP + '/node_modules/demo/copy', tarfile.LNKTYPE, m.TOP + '/node_modules/demo/file')])
        release = m.unpack(archive, self.output())
        self.assertEqual((release / 'node_modules/demo/copy').read_bytes(), b'public bytes')
        self.assertEqual((release / 'node_modules/demo/copy').stat().st_ino,
                         (release / 'node_modules/demo/file').stat().st_ino)
        for target in ('/etc/passwd', m.TOP + '/index.js', m.TOP + '/node_modules/missing'):
            with self.assertRaises(m.Refused):
                m.unpack(self.archive([(m.TOP + '/node_modules/demo/copy', tarfile.LNKTYPE, target)]), self.output())

    def test_member_count_and_expanded_size_are_bounded(self):
        archive = self.archive([(m.TOP + '/node_modules/a', tarfile.REGTYPE, b'0123456789')])
        with patch.object(m, 'MAX_MEMBERS', 1), self.assertRaisesRegex(m.Refused, 'COUNT_REFUSED'):
            m.unpack(archive, self.output())
        with patch.object(m, 'MAX_EXPANDED', 5), self.assertRaisesRegex(m.Refused, 'EXPANDED_SIZE_REFUSED'):
            m.unpack(archive, self.output())

    def test_wrong_identity_root_and_unsafe_parent_block_before_stage_creation(self):
        with patch.object(m.os, 'geteuid', return_value=501), self.assertRaisesRegex(m.Refused, 'ROOT_REQUIRED'):
            m.target()
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m, 'metadata', return_value='wrong'), \
                patch.object(m, 'safe_parents') as parents:
            with self.assertRaisesRegex(m.Refused, 'WRONG_INSTANCE'):
                m.target()
            parents.assert_not_called()
        unsafe = self.root / 'unsafe'
        unsafe.mkdir(mode=0o777)
        unsafe.chmod(0o777)
        with self.assertRaisesRegex(m.Refused, 'UNSAFE_DIRECTORY'):
            m.safe_directory(unsafe)

    def test_no_follow_bounded_read_hash_and_unsafe_mode_refusal(self):
        regular = self.root / 'public'
        data = b'public reviewed bytes'
        regular.write_bytes(data)
        regular.chmod(0o600)
        expected = hashlib.sha256(data).hexdigest()
        link = self.root / 'link'
        link.symlink_to(regular)
        for read in (m.read_regular, f.read_verified, r.read_verified):
            with self.subTest(reader=read.__module__):
                self.assertEqual(read(regular, len(data), expected), data)
                with self.assertRaises(OSError):
                    read(link, len(data), expected)
                with self.assertRaises(Exception):
                    read(regular, len(data) - 1, expected)
                with self.assertRaises(Exception):
                    read(regular, len(data), '0' * 64)
                regular.chmod(0o666)
                with self.assertRaises(Exception):
                    read(regular, len(data), expected)
                regular.chmod(0o600)

class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        owner=patch.object(m,'OWNER',os.getuid());owner.start();self.addCleanup(owner.stop)

    def test_exact_upgrade_and_real_compatibility_pins(self):
        self.assertEqual(m.sha((HERE/'trial-editorial-comments-upgrade.py').read_bytes()),m.REVIEWED_HELPER_SHA256)
        self.assertEqual(m.REVIEWED_HELPER_SHA256,f.HELPER_SHA);self.assertEqual(m.REVIEWED_HELPER_SHA256,r.HELPER_SHA256)
        self.assertEqual(m.COMPATIBILITY_SHA256,f.COMPATIBILITY_SHA);self.assertEqual(m.COMPATIBILITY_SHA256,r.COMPATIBILITY_SHA256)
        self.assertEqual(m.MIGRATION_SHA256,m.sha((PROJECT/'db/migrations'/m.MIGRATION).read_bytes()))
        self.assertEqual(m.BASELINE_HEAD,u.BASELINE_HEAD);self.assertEqual(m.BASELINE_TREE,u.BASELINE_TREE)
        self.assertEqual(m.ROOTS,(Path('/opt/cisme-trial'),))

    def test_payload_hashes_refuse_placeholders_and_unreviewed_bytes(self):
        for function,field in [(m.helper_payload,'HELPER_B64_ZLIB'),(m.compatibility_payload,'COMPATIBILITY_B64_ZLIB')]:
            with self.assertRaises(m.Refused):function()
            with patch.object(m,field,base64.b64encode(zlib.compress(b'not reviewed')).decode()),self.assertRaises(m.Refused):function()
        raw=(HERE/'trial-editorial-comments-upgrade.py').read_bytes()
        with patch.object(m,'HELPER_B64_ZLIB',base64.b64encode(zlib.compress(raw)).decode()):self.assertEqual(m.helper_payload(),raw)

    def test_receipt_precedes_binding_without_cycle(self):
        raw=b'fixed synthetic receipt';receipt={'privateStage':'/var/lib/cisme-dependency-stage/synthetic'}
        with patch.multiple(m,HEAD='a'*40,TREE='b'*40,CI_RUN_ID=123,ARCHIVE_SIZE=15,ARCHIVE_SHA256='c'*64,RELEASE_MANIFEST_SHA256='d'*64):
            b=m.application_binding(receipt,raw)
        self.assertEqual(b['kind'],'trial-editorial-comments-upgrade');self.assertEqual(b['migrations'],99)
        self.assertEqual(b['stageReceiptSha256'],m.sha(raw));self.assertEqual(b['compatibilitySha256'],m.COMPATIBILITY_SHA256)
        self.assertEqual(b['compatibilityReceipt'],'/var/lib/cisme-dependency-stage/synthetic/rollback-compatibility.json')
        self.assertEqual(b['migrationSha256'],u.MIGRATION_SHA);self.assertNotIn('applicationBindingSha256',b)
        with patch.object(u,'read',return_value=b'exact helper'),patch.object(u,'sha',return_value=b['helperSha256']):self.assertEqual(u.validate_binding(b),b)

    def guard_fixture(self):
        module=ModuleType('synthetic_exact_guard');profile={'name':'trial'}
        config={'APP_ENV':'staging','WECHAT_APP_ID':'canonical','WECHAT_PHONE_BINDING_ENABLED':'false','COS_DIRECT_UPLOAD_ENABLED':'false'}
        old={'directory':'/synthetic/old','manifest':{'sourceHead':m.BASELINE_HEAD,'sourceTree':m.BASELINE_TREE,'migrations':['synthetic']*98},'manifestSha256':'old-manifest','dependenciesSha256':m.DEPENDENCIES}
        calls=[];module.APP_ID='canonical';module.BASELINE_MANIFEST='old-manifest'
        module.load_primitives=lambda value:calls.append(('load',value))or{'profile':profile,'config':config,'release':'/synthetic/old'}
        module.fixed_profile=lambda p:None;module.production_capture=lambda:{'config':{}};module.six_keys=lambda *a:None
        module.article_fence=lambda p:{'publishedCount':20,'items':['same private article/actor facts']}
        module.production_preserved=lambda p:None
        module.D=SimpleNamespace(closed_context=lambda *a:True,artifact=lambda *a:old,database_facts=lambda p:{'database':'cisme_trial','owner':'cisme_trial','journal':old['manifest']['migrations']},general=SimpleNamespace(reviewed_main=lambda:{'sha':'a'*40,'tree':'b'*40,'ciRunId':123}))
        for name in ('preflight','apply','active_context'):setattr(module,name,lambda *a:(_ for _ in()).throw(AssertionError('activation entry called')))
        return module,config,old,calls

    def test_baseline_is45091_actual98_and_latest_main_push_ci_before_writes(self):
        module,config,old,calls=self.guard_fixture()
        with patch.multiple(m,HEAD='a'*40,TREE='b'*40,CI_RUN_ID=123,OPERATIONS=Path('/synthetic/new')),patch.object(m.types,'ModuleType',return_value=module):
            value=m.baseline_guard(b'# no mutation fixture');self.assertEqual(calls,[('load',True)])
            module.D.general.reviewed_main=lambda:{'sha':'a'*40,'tree':'b'*40,'ciRunId':999}
            with self.assertRaisesRegex(m.Refused,'EXACT_MAIN_PUSH_CI'):m.baseline_guard(b'# fixture')
            module.D.general.reviewed_main=lambda:{'sha':'a'*40,'tree':'b'*40,'ciRunId':123}
            for key in ('WECHAT_PHONE_BINDING_ENABLED','COS_DIRECT_UPLOAD_ENABLED'):
                config[key]='true'
                with self.assertRaisesRegex(m.Refused,'CLOSED_TRIAL'):m.baseline_guard(b'# fixture')
                config[key]='false'
            old['manifest']['sourceHead']='0'*40
            with self.assertRaisesRegex(m.Refused,'45091_SCHEMA98'):m.baseline_guard(b'# fixture')
        self.assertEqual(value[2]['articleFence']['publishedCount'],20)

    def test_main_or_compatibility_rejection_cannot_create_stage(self):
        fields={'HEAD':'a'*40,'TREE':'b'*40,'TOP':'tencent-release-'+'a'*12,'CI_RUN_ID':123,'ARCHIVE_SIZE':10,'ARCHIVE_SHA256':'c'*64,'RELEASE_MANIFEST_SHA256':'d'*64}
        with patch.multiple(m,**fields),patch.object(m,'helper_payload',return_value=b'fixture'),patch.object(m,'compatibility_payload',return_value=b'fixture'),patch.object(m,'target'),patch.object(m,'baseline_guard',side_effect=m.Refused('STAGE_EXACT_MAIN_PUSH_CI_REQUIRED')),patch.object(m.tempfile,'mkdtemp')as create,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(),1);create.assert_not_called()
        with patch.multiple(m,**fields),patch.object(m,'helper_payload',return_value=b'fixture'),patch.object(m,'compatibility_payload',side_effect=m.Refused('STAGE_ACTUAL_COMPATIBILITY_REQUIRED')),patch.object(m,'target')as target,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(),1);target.assert_not_called()

    def test_unknown_existing_candidate_or_runner_refused(self):
        trial=self.root/'trial';(trial/'releases').mkdir(parents=True);ops=trial/'editorial-comment-runners'/'fixture';ops.parent.mkdir();ops.mkdir(mode=0o700)
        with patch.multiple(m,ROOT=trial,ROOTS=(trial,),TOP='fixture',OPERATIONS=ops,STAGE_BASE=self.root/'stage'),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'safe_parents'),patch.object(m,'metadata',side_effect=lambda field:m.BINDING[field]),patch.object(m.socket,'gethostname',return_value='VM-0-10-ubuntu'):
            with self.assertRaisesRegex(m.Refused,'DESTINATION_ALREADY_EXISTS'):m.target()
            ops.rmdir();(trial/'releases'/'fixture').mkdir()
            with self.assertRaisesRegex(m.Refused,'DESTINATION_ALREADY_EXISTS'):m.target()

    def fixture_archive(self,head='a'*40):
        top='tencent-release-'+head[:12];old=sorted(p.name for p in (PROJECT/'db/migrations').glob('*.sql')if p.name<='202610260001_owned_editorial.sql');self.assertEqual(len(old),98)
        files={name:b'synthetic runtime'for name in m.ENTRIES};files['migrate.mjs']=(PROJECT/'scripts/release-migrate.mjs').read_bytes()
        package=json.loads((PROJECT/'package.json').read_bytes());release={'name':'cisme-tencent-release','version':package['version'],'private':True,'type':'module','engines':package['engines'],'dependencies':package['dependencies']};files['package.json']=(json.dumps(release)+'\n').encode()
        lock=json.loads((PROJECT/'package-lock.json').read_bytes());lock['name']=release['name'];lock['packages']['']={k:v for k,v in release.items()if k not in ('private','type')};lock['packages']={k:v for k,v in lock['packages'].items()if not k or(k.startswith('node_modules/')and not v.get('link'))};files['package-lock.json']=(json.dumps(lock)+'\n').encode()
        for name in old+[m.MIGRATION]:files['db/migrations/'+name]=(PROJECT/'db/migrations'/name).read_bytes()
        manifest={'schemaVersion':1,'configurationIncluded':False,'sourceHead':head,'sourceTree':'b'*40,'sourceLockSha256':m.LOCK_PERMIT,'node':'v24.14.0','deployed':False,'releaseReady':False,'buildPlatform':{'os':'linux','arch':'x64','libc':'glibc'},'migrations':old+[m.MIGRATION],'hashes':{n:m.sha(v)for n,v in files.items()}}
        raw_manifest=(json.dumps(manifest)+'\n').encode();files['release-manifest.json']=raw_manifest;files['node_modules/demo/package.json']=b'{"name":"synthetic"}'
        out=io.BytesIO();dirs={top,top+'/node_modules',top+'/node_modules/demo',top+'/db',top+'/db/migrations'}
        with tarfile.open(fileobj=out,mode='w:gz')as tar:
            for name in sorted(dirs):member=tarfile.TarInfo(name);member.type=tarfile.DIRTYPE;member.mode=0o755;tar.addfile(member)
            for name,data in files.items():member=tarfile.TarInfo(top+'/'+name);member.mode=0o644;member.size=len(data);tar.addfile(member,io.BytesIO(data))
        return out.getvalue(),m.sha(raw_manifest),old

    def test_full_synthetic_stage_only_installs_candidate_helper_binding_and_compat(self):
        raw,digest,old=self.fixture_archive();archive=self.root/'digest.tar.gz';archive.write_bytes(raw);extract=self.root/'digest';extract.mkdir()
        with patch.object(m,'TOP','tencent-release-'+'a'*12):release=m.unpack(archive,extract)
        dependencies=m.dependency_digest(release/'node_modules',os.getuid());trial=self.root/'trial';(trial/'releases').mkdir(parents=True);stage=self.root/'stages';stage.mkdir(mode=0o700);ops=trial/'editorial-comment-runners'/('a'*12)
        helper=(HERE/'trial-editorial-comments-upgrade.py').read_bytes();compat=b'synthetic compatibility';proof=SimpleNamespace(validate_binding=lambda b:None,stage_binding=lambda *a:None,compatibility=lambda *a:None)
        production=self.root/'production';production.mkdir();sentinel=production/'not-touched';sentinel.write_bytes(b'unchanged')
        fields={'HEAD':'a'*40,'TREE':'b'*40,'TOP':'tencent-release-'+'a'*12,'CI_RUN_ID':123,'ARCHIVE_SIZE':len(raw),'ARCHIVE_SHA256':m.sha(raw),'RELEASE_MANIFEST_SHA256':digest,'ROOT':trial,'ROOTS':(trial,),'STAGE_BASE':stage,'OPERATIONS':ops,'DEPENDENCIES':dependencies}
        original=m.dependency_digest;out=io.StringIO();before=os.umask(0o022)
        try:
            with patch.multiple(m,**fields),patch.object(m,'target')as target,patch.object(m,'helper_payload',return_value=helper),patch.object(m,'compatibility_payload',return_value=compat),patch.object(m,'dependency_digest',side_effect=lambda path:original(path,os.getuid())),patch.object(m,'baseline_guard',return_value=(proof,'old','private')),patch.object(m,'candidate_contract',return_value={'directory':str(trial/'releases'/('tencent-release-'+'a'*12))})as contract,patch('sys.stdin',SimpleNamespace(buffer=io.BytesIO(raw))),contextlib.redirect_stdout(out):self.assertEqual(m.main(),0)
        finally:os.umask(before)
        value=json.loads(out.getvalue());stage=Path(value['privateStage']);receipt_raw=(stage/'stage-receipt.json').read_bytes();b=json.loads((ops/'application-binding.json').read_bytes())
        self.assertEqual(set(ops.iterdir()),{ops/'application-binding.json',ops/'trial-editorial-comments-upgrade.py'});self.assertEqual(ops.stat().st_mode&0o777,0o700)
        self.assertEqual((stage/'rollback-compatibility.json').read_bytes(),compat);self.assertEqual((stage/'rollback-compatibility.json').stat().st_mode&0o777,0o600)
        self.assertEqual(b['stageReceiptSha256'],m.sha(receipt_raw));self.assertNotIn('applicationBindingSha256',json.loads(receipt_raw));self.assertEqual(value['applicationBindingSha256'],m.sha((ops/'application-binding.json').read_bytes()));self.assertFalse(value['deployed']);self.assertFalse(value['productionChanged']);self.assertEqual(sentinel.read_bytes(),b'unchanged');self.assertEqual(target.call_count,2);self.assertEqual(contract.call_count,4)

    def test_local_archive_checks_all_old98_bytes_and_exact99_source(self):
        raw,digest,old=self.fixture_archive();head='a'*40
        def git(*args):
            self.assertEqual(args[:3],('ls-tree','-r','--name-only'));return ('\n'.join('db/migrations/'+n for n in (old if args[3]==f.BASELINE else old+[m.MIGRATION]))+'\n').encode()
        with patch.object(f,'git',side_effect=git),patch.object(f,'source',side_effect=lambda h,p:(PROJECT/p).read_bytes()):
            f.check_archive(raw,m,head,'b'*40,digest)
            original=f.source
            def changed(h,p):return b'changed'if h==f.BASELINE and p.endswith(old[0])else(PROJECT/p).read_bytes()
            with patch.object(f,'source',side_effect=changed),self.assertRaisesRegex(ValueError,'OLD_MIGRATION_BYTES_CHANGED'):f.check_archive(raw,m,head,'b'*40,digest)

    def test_candidate_uses_new_upgrade_artifact_and_source_contract_and_actor_fence(self):
        directory=self.root/'candidate';directory.mkdir();(directory/'index.js').write_bytes(b'code')
        manifest={'hashes':{'index.js':m.sha(b'code')}};raw=json.dumps(manifest).encode();(directory/'release-manifest.json').write_bytes(raw)
        calls=[];module=SimpleNamespace(artifact_contract=lambda *a:calls.append(('artifact',a)),source_permit=lambda *a:calls.append(('source',a)),production_preserved=lambda value:calls.append(('production',value)),article_fence=lambda p:{'publishedCount':20,'items':['same']},D=SimpleNamespace(general=SimpleNamespace(reviewed_main=lambda:{'sha':'a'*40,'tree':'b'*40,'ciRunId':123})))
        proof={'profile':'trial','production':'private','articleFence':{'publishedCount':20,'items':['same']}}
        with patch.multiple(m,HEAD='a'*40,TREE='b'*40,TOP='tencent-release-'+'a'*12,CI_RUN_ID=123,RELEASE_MANIFEST_SHA256=m.sha(raw)):
            candidate=m.candidate_contract(directory,(module,'old',proof),source=True)
            self.assertEqual([kind for kind,args in calls],['artifact','source','production']);self.assertEqual(calls[1][1][1]['directory'],str(directory));self.assertEqual(candidate['directory'],'/opt/cisme-trial/releases/tencent-release-'+'a'*12)
            module.article_fence=lambda p:{'publishedCount':20,'items':['changed actor only']}
            with self.assertRaisesRegex(m.Refused,'EXISTING20_ACTOR_OR_MEDIA_DRIFT'):m.candidate_contract(directory,(module,'old',proof))

    def test_local_finalizer_rejects_extra_sql_and_native_or_activated_build_claims(self):
        raw,digest,old=self.fixture_archive();head='a'*40
        def git(*args):return ('\n'.join('db/migrations/'+n for n in (old if args[3]==f.BASELINE else old+[m.MIGRATION,'202610290001_unapproved.sql']))+'\n').encode()
        with patch.object(f,'git',side_effect=git),self.assertRaisesRegex(ValueError,'98_PLUS_ONLY99'):f.check_archive(raw,m,head,'b'*40,digest)
        summary={'schemaVersion':1,'kind':'trial-application-build-not-activation','sourceHead':head,'sourceTree':'b'*40,'archiveSha256':'c'*64,'manifestSha256':'d'*64,'archiveBytes':100,'migrations':99,'runtimeDependencies':{'fastify':'5.12.6','sharp':'0.35.5'},'builderImage':f.IMAGE,'network':'none','hostMounts':[],'secretsIncluded':False,'serverMutations':False,'deployed':False,'activationAllowedByBuild':False}
        path=self.root/'summary.json'
        def checked(value):
            data=json.dumps(value).encode();path.write_bytes(data);path.chmod(0o600);return f.checked_summary(path,f.sha(data))
        self.assertEqual(checked(summary)['migrations'],99)
        for key,value in [('migrations',98),('network','bridge'),('hostMounts',['workspace']),('deployed',True),('builderImage','unreviewed')]:
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'ISOLATED_LINUX_BUILD'):checked({**summary,key:value})

    def test_template_source_hashes_and_marker_render_are_exact(self):
        template=(HERE/'trial-editorial-comments-stage.py').read_bytes();runner=(HERE/'run-trial-editorial-comments-stage.py').read_bytes()
        self.assertEqual(f.sha(template),f.TEMPLATE_SHA);self.assertEqual(f.sha(runner),f.RUNNER_SHA)
        fields={'HEAD':'a'*40,'TREE':'b'*40,'ARCHIVE_SHA256':'c'*64,'ARCHIVE_SIZE':100,'RELEASE_MANIFEST_SHA256':'d'*64,'CI_RUN_ID':123,'HELPER_B64_ZLIB':'fixture','COMPATIBILITY_B64_ZLIB':'fixture'}
        rendered=f.render(template,fields);namespace={'__name__':'synthetic'};exec(compile(rendered,'synthetic','exec'),namespace)
        self.assertNotIn(b'# FINALIZER_',rendered);self.assertEqual(namespace['OPERATIONS'],Path('/opt/cisme-trial/editorial-comment-runners/'+'a'*12))
        with self.assertRaisesRegex(ValueError,'TEMPLATE_MARKER'):f.render(template.replace(b'HEAD = None  # FINALIZER_HEAD',b'HEAD = "unexpected"'),fields)

    def test_local_finalizer_refuses_placeholder_before_read_or_git(self):
        args=['tool','--artifact-summary','/not-opened','--expected-summary-sha256','UNSET','--ci-run-id','0','--output-dir','/not-created','--compatibility-receipt','/not-opened']
        with patch('sys.argv',args),patch.object(f,'read_verified')as read,patch.object(f,'git')as git,self.assertRaises(ValueError):f.main()
        read.assert_not_called();git.assert_not_called()

    def test_runner_refuses_foreign_host_and_uses_one_verified_buffer(self):
        args=['tool','--host','ubuntu@150.158.39.74','--identity-file','/not-read','--known-hosts','/not-read']
        with patch('sys.argv',args),patch.object(r,'read_verified')as read,patch.object(r.subprocess,'run')as run,self.assertRaises(ValueError):r.main()
        read.assert_not_called();run.assert_not_called()
        head='a'*40;tree='b'*40;data=b'raw binary archive\x00\xff';archive=self.root/'archive';archive.write_bytes(data);stager=self.root/'root-installer-final.py';stager.write_bytes(b'# inert fixture')
        command={'sourceHead':head,'sourceTree':tree,'helperSha256':r.HELPER_SHA256,'compatibilitySha256':r.COMPATIBILITY_SHA256,'archivePath':str(archive),'archiveSha256':m.sha(data),'archiveSize':len(data),'stagerPath':str(stager),'stagerSha256':m.sha(stager.read_bytes()),'releaseManifestSha256':'c'*64,'serverWriteExecuted':False,'deployed':False}
        (self.root/'stage-command.json').write_text(json.dumps(command));receipt={**command,'staged':True,'manifestSha256':'c'*64,'candidateDirectories':['/opt/cisme-trial/releases/tencent-release-'+head[:12]],'productionChanged':False,'peerFilesChanged':False,'servicesChanged':False,'databaseChanged':False,'configurationChanged':False,'dependenciesSha256':m.DEPENDENCIES,'migrations':99,'helperPath':'/opt/cisme-trial/editorial-comment-runners/'+head[:12]+'/trial-editorial-comments-upgrade.py','applicationBindingPath':'/opt/cisme-trial/editorial-comment-runners/'+head[:12]+'/application-binding.json','applicationBindingSha256':'d'*64,'stageReceiptSha256':'e'*64}
        original=r.read_verified
        def read(path,*a):
            value=original(path,*a)
            if Path(path)==archive:archive.write_bytes(b'changed')
            return value
        args=['tool','--host','ubuntu@124.223.74.198','--identity-file','/not-read','--known-hosts','/not-read']
        with patch.multiple(r,HERE=self.root,HEAD=head,TREE=tree),patch.object(r,'read_verified',side_effect=read),patch.object(r.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(receipt).encode()))as run,patch('sys.argv',args),contextlib.redirect_stdout(io.StringIO()):self.assertEqual(r.main(),0)
        self.assertEqual(run.call_args.kwargs['input'],data);self.assertIn('StrictHostKeyChecking=yes',run.call_args.args[0]);self.assertIn('/usr/bin/python3 -I -B',run.call_args.args[0][-1])

class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.root.chmod(0o700)
        self.head='a'*40;self.tree='b'*40;self.data=b'synthetic archive bytes\x00\xff'
        archive=self.root/'archive';archive.write_bytes(self.data);archive.chmod(0o600)
        stager=self.root/'root-installer-final.py';stager.write_bytes(b'# inert fixture');stager.chmod(0o600)
        self.command={'sourceHead':self.head,'sourceTree':self.tree,'helperSha256':r.HELPER_SHA256,
          'compatibilitySha256':r.COMPATIBILITY_SHA256,'archivePath':str(archive),'archiveSha256':m.sha(self.data),
          'archiveSize':len(self.data),'stagerPath':str(stager),'stagerSha256':m.sha(stager.read_bytes()),
          'releaseManifestSha256':'c'*64,'serverWriteExecuted':False,'deployed':False}
        (self.root/'stage-command.json').write_text(json.dumps(self.command));(self.root/'stage-command.json').chmod(0o600)
        self.args=['tool','--host','ubuntu@124.223.74.198','--identity-file','/synthetic-key','--known-hosts','/synthetic-known-hosts']

    def run_runner(self,result=None,error=None):
        output=io.StringIO()
        with patch.multiple(r,HERE=self.root,HEAD=self.head,TREE=self.tree),patch('sys.argv',self.args),\
             patch.object(r.subprocess,'run',return_value=result,side_effect=error)as run,contextlib.redirect_stdout(output):
            status=r.main()
        return status,json.loads(output.getvalue()),run

    def stage_error(self,error):
        fields={'HEAD':self.head,'TREE':self.tree,'TOP':'tencent-release-'+self.head[:12],'CI_RUN_ID':123,
          'ARCHIVE_SIZE':10,'ARCHIVE_SHA256':'c'*64,'RELEASE_MANIFEST_SHA256':'d'*64}
        output=io.StringIO()
        with patch.multiple(m,**fields),patch.object(m,'helper_payload',return_value=b'fixture'),\
             patch.object(m,'compatibility_payload',return_value=b'fixture'),patch.object(m,'target'),\
             patch.object(m,'baseline_guard',side_effect=error),patch.object(m.tempfile,'mkdtemp')as create,contextlib.redirect_stdout(output):
            self.assertEqual(m.main(),1)
        create.assert_not_called()
        return output.getvalue(),json.loads(output.getvalue())

    def test_cross_module_refusals_retain_only_reviewed_codes_and_local_locations(self):
        self.assertNotIsInstance(u.Refused('COMMENTS_SOURCE_NETWORK_UNAVAILABLE'),m.Refused)
        for code in ('COMMENTS_SOURCE_NETWORK_UNAVAILABLE','NO_SCHEMA_PRODUCTION_DRIFT','DEPENDENCY_FILE_UNSAFE',
                     'GITHUB_PROVENANCE_UNAVAILABLE','PRODUCTION_COMMAND_FAILED','EXACT_MAIN_PUSH_CI_REQUIRED','LATEST_MAIN_CI_NOT_SUCCESSFUL'):
            with self.subTest(code=code):
                raw,value=self.stage_error(u.Refused(code))
                self.assertEqual(value['code'],code);self.assertEqual(value['failurePhase'],'baseline_guard')
                self.assertEqual(value['stageFunction'],'main');self.assertIs(type(value['stageLine']),int)
                self.assertFalse(value['deployed']);self.assertFalse(value['privateValuesExported'])

    def test_exception_prose_unknown_namespaces_and_oversize_codes_never_export(self):
        for secret in ('COMMENTS_SOURCE_UNAVAILABLE https://private.invalid/?token=PRIVATE_SECRET',
                       'COMMENTS_SECRET\nPRIVATE_SECRET','PRIVATE_SECRET_VALUE','COMMENTS_'+('A'*121)):
            with self.subTest(secret=secret):
                raw,value=self.stage_error(u.Refused(secret));self.assertEqual(value['code'],'STAGE_REVIEW_REQUIRED')
                self.assertNotIn('PRIVATE_SECRET',raw);self.assertNotIn('https://',raw)
        self.assertEqual(m.PUBLIC_ERROR_PREFIXES,r.PUBLIC_ERROR_PREFIXES)
        self.assertEqual(m.PUBLIC_ERROR_EXACT,r.PUBLIC_ERROR_EXACT)
        self.assertEqual(m.PUBLIC_PHASES,r.PUBLIC_PHASES);self.assertEqual(m.PUBLIC_FUNCTIONS,r.PUBLIC_FUNCTIONS)

    def test_nonzero_remote_code_is_parsed_only_after_private_evidence_is_complete(self):
        stdout=json.dumps({'ok':False,'deployed':False,'privateValuesExported':False,'code':'COMMENTS_SOURCE_NETWORK_UNAVAILABLE',
          'failurePhase':'candidate_source','stageFunction':'candidate_contract','stageLine':413,'ignoredPrivate':'PRIVATE_SECRET'}).encode()
        stderr=b'PRIVATE_STDERR_KEY_AND_ID'
        original=r.remote_failure
        def inspect(data):
            directories=list(self.root.glob('stage-attempt-*'));self.assertEqual(len(directories),1)
            self.assertEqual((directories[0]/'stdout.bin').read_bytes(),stdout)
            self.assertEqual((directories[0]/'stderr.bin').read_bytes(),stderr)
            self.assertEqual(json.loads((directories[0]/'transport.json').read_bytes())['sshReturnCode'],1)
            return original(data)
        with patch.object(r,'remote_failure',side_effect=inspect):
            status,value,run=self.run_runner(SimpleNamespace(returncode=1,stdout=stdout,stderr=stderr))
        self.assertEqual(status,1);self.assertEqual(run.call_count,1)
        self.assertEqual(value['code'],'COMMENTS_SOURCE_NETWORK_UNAVAILABLE');self.assertEqual(value['failurePhase'],'candidate_source')
        self.assertEqual(value['stageFunction'],'candidate_contract');self.assertEqual(value['stageLine'],413)
        self.assertFalse(value['automaticReplay']);self.assertTrue(value['resultRequiresReview'])
        self.assertNotIn('PRIVATE_',json.dumps(value));directory=Path(value['localEvidenceDirectory'])
        self.assertEqual(directory.parent,self.root);self.assertEqual(stat.S_IMODE(directory.stat().st_mode),0o700)
        self.assertEqual({p.name for p in directory.iterdir()},{'stdout.bin','stderr.bin','transport.json'})
        for path in directory.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600);self.assertEqual(path.stat().st_nlink,1)
        metadata=json.loads((directory/'transport.json').read_bytes())
        self.assertEqual(metadata['stdoutSha256'],m.sha(stdout));self.assertEqual(metadata['stderrSha256'],m.sha(stderr))

    def test_attempt_evidence_never_overwrites_a_previous_failure(self):
        one=self.run_runner(SimpleNamespace(returncode=1,stdout=b'private first',stderr=b'first stderr'))[1]
        first=Path(one['localEvidenceDirectory']);before={p.name:p.read_bytes()for p in first.iterdir()}
        two=self.run_runner(SimpleNamespace(returncode=255,stdout=b'private second',stderr=b'second stderr'))[1]
        self.assertNotEqual(first,Path(two['localEvidenceDirectory']))
        self.assertEqual(before,{p.name:p.read_bytes()for p in first.iterdir()});self.assertEqual(len(list(self.root.glob('stage-attempt-*'))),2)

    def test_malformed_private_or_duplicate_remote_failure_fields_are_not_exported(self):
        base={'ok':False,'deployed':False,'privateValuesExported':False,'code':'COMMENTS_SOURCE_UNAVAILABLE'}
        cases=[b'PRIVATE_TOKEN_STDOUT',json.dumps({**base,'code':'COMMENTS_PRIVATE /secret/key'}).encode(),
          json.dumps({**base,'deployed':True}).encode(),json.dumps({**base,'privateValuesExported':True}).encode(),
          b'{"ok":false,"ok":true,"deployed":false,"privateValuesExported":false,"code":"COMMENTS_SOURCE_UNAVAILABLE"}',
          b'PRIVATE_SECRET'+b'x'*65536]
        for stdout in cases:
            with self.subTest(length=len(stdout)):
                status,value,run=self.run_runner(SimpleNamespace(returncode=1,stdout=stdout,stderr=b'PRIVATE_STDERR'))
                self.assertEqual(status,1);self.assertEqual(value['code'],'SSH_STAGE_REVIEW_REQUIRED')
                self.assertEqual(value['failurePhase'],'unknown');self.assertNotIn('PRIVATE_',json.dumps(value));self.assertEqual(run.call_count,1)
                self.assertEqual((Path(value['localEvidenceDirectory'])/'stdout.bin').read_bytes(),stdout)

    def test_only_allowlisted_remote_locations_and_real_integer_line_are_exported(self):
        value=r.remote_failure(json.dumps({'ok':False,'deployed':False,'privateValuesExported':False,'code':'COMMENTS_SOURCE_UNAVAILABLE',
          'failurePhase':'/private/secret','stageFunction':'PRIVATE_SECRET','stageLine':True}).encode())
        self.assertEqual(value,{'code':'COMMENTS_SOURCE_UNAVAILABLE','failurePhase':'unknown'})

    def test_transport_timeout_preserves_partial_output_and_never_replays_or_claims_a_verified_result(self):
        error=subprocess.TimeoutExpired('synthetic ssh',600,output=b'PRIVATE_PARTIAL_STDOUT',stderr=b'PRIVATE_PARTIAL_STDERR')
        with patch.object(r,'remote_failure')as parse:
            status,value,run=self.run_runner(error=error)
        self.assertEqual(status,1);self.assertEqual(run.call_count,1);parse.assert_not_called()
        self.assertEqual(value['code'],'SSH_STAGE_TRANSPORT_TIMEOUT');self.assertFalse(value['automaticReplay']);self.assertTrue(value['resultRequiresReview'])
        directory=Path(value['localEvidenceDirectory']);metadata=json.loads((directory/'transport.json').read_bytes())
        self.assertTrue(metadata['timedOut']);self.assertIsNone(metadata['sshReturnCode'])
        self.assertEqual((directory/'stdout.bin').read_bytes(),b'PRIVATE_PARTIAL_STDOUT')
        self.assertEqual((directory/'stderr.bin').read_bytes(),b'PRIVATE_PARTIAL_STDERR');self.assertNotIn('PRIVATE_',json.dumps(value))

    def test_launch_failure_does_not_export_exception_arguments(self):
        status,value,run=self.run_runner(error=FileNotFoundError('/PRIVATE_SECRET_KEY'))
        self.assertEqual(status,1);self.assertEqual(run.call_count,1);self.assertEqual(value['code'],'SSH_STAGE_TRANSPORT_FAILED')
        self.assertNotIn('PRIVATE_',json.dumps(value));metadata=json.loads((Path(value['localEvidenceDirectory'])/'transport.json').read_bytes())
        self.assertTrue(metadata['launchFailed']);self.assertIsNone(metadata['sshReturnCode'])

    def test_zero_exit_invalid_receipt_is_private_and_requires_review_without_replay(self):
        status,value,run=self.run_runner(SimpleNamespace(returncode=0,stdout=b'{"private":"PRIVATE_SECRET"}',stderr=b'private warning'))
        self.assertEqual(status,1);self.assertEqual(run.call_count,1);self.assertEqual(value['code'],'SSH_STAGE_RESPONSE_INVALID')
        self.assertEqual(value['failurePhase'],'response_validation');self.assertNotIn('PRIVATE_',json.dumps(value))

    def test_nonprivate_evidence_parent_refuses_before_ssh(self):
        self.root.chmod(0o755)
        with patch.multiple(r,HERE=self.root,HEAD=self.head,TREE=self.tree),patch('sys.argv',self.args),\
             patch.object(r.subprocess,'run')as run,self.assertRaises(ValueError):r.main()
        run.assert_not_called();self.assertEqual(list(self.root.glob('stage-attempt-*')),[])

    def test_strict_ssh_and_single_buffer_flags_are_unchanged_on_failure(self):
        status,value,run=self.run_runner(SimpleNamespace(returncode=255,stdout=b'',stderr=b'private ssh failure'))
        self.assertEqual(status,1);self.assertEqual(run.call_count,1);args=run.call_args.args[0]
        for flag in ('BatchMode=yes','StrictHostKeyChecking=yes','ConnectTimeout=10','PasswordAuthentication=no',
                     'KbdInteractiveAuthentication=no','IdentitiesOnly=yes','UserKnownHostsFile=/synthetic-known-hosts'):
            self.assertIn(flag,args)
        self.assertEqual(args[-2],'ubuntu@124.223.74.198');self.assertIn('sudo -n /usr/bin/env -i',args[-1])
        self.assertIn('/usr/bin/python3 -I -B',args[-1]);self.assertEqual(run.call_args.kwargs['input'],self.data)

if __name__=='__main__':unittest.main()
