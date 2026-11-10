"""Offline103->104 deployment guards; no network, SSH or database mutations."""
import copy, importlib.util, json, types, unittest
from pathlib import Path
from unittest.mock import Mock, patch
HERE=Path(__file__).resolve().parent
ROOT=next(parent for parent in HERE.parents if (parent/'package.json').is_file() and (parent/'apps/miniprogram').is_dir())
SPEC=importlib.util.spec_from_file_location('support_collaboration_upgrade', HERE/'trial-support-ai-human-collaboration-upgrade.py')
M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)
RUNNER=M.RUNNERS/('1'*12)/'trial-support-ai-human-collaboration-upgrade.py'
PROFILE={'name':'trial','root':str(M.ROOT),'units':('cisme-trial-api.service','cisme-trial-worker.service'),'database':'cisme_trial','user':'cisme-trial'}

# Historical deployment guards retain their approved dependency bytes.
# Today's dependency additions must not rewrite those immutable allowlists.
def fixture_source(name):
    base=ROOT/'infra/tencent/fixtures/approved-dependencies-before-commerce-20261110' if str(name) in ('package.json','package-lock.json') else ROOT
    return (base/name).read_bytes()


def fixture():
 names=sorted(p.name for p in (ROOT/'db/migrations').glob('*.sql') if p.name<M.MIGRATION)
 assert len(names)==103
 files={name:fixture_source(path) for name,path in [('migrate.mjs','scripts/release-migrate.mjs'),('package.json','package.json'),('package-lock.json','package-lock.json')]}
 files.update({'db/migrations/'+name:(ROOT/'db/migrations'/name).read_bytes() for name in names})
 old={'directory':str(M.ROOT/'releases'/('tencent-release-'+M.BASELINE_HEAD[:12])),'files':files,'dependenciesSha256':M.DEPENDENCIES,'manifestSha256':M.BASELINE_MANIFEST,'manifest':{'sourceHead':M.BASELINE_HEAD,'sourceTree':M.BASELINE_TREE,'migrations':names}}
 candidate=copy.deepcopy(old)
 candidate.update(directory=str(M.ROOT/'releases'/('tencent-release-'+'1'*12)),manifestSha256='a'*64)
 candidate['manifest'].update(sourceHead='1'*40,sourceTree='2'*40,migrations=names+[M.MIGRATION],sourceLockSha256=M.SOURCE_LOCK,node='v24.14.0',buildPlatform={'os':'linux','arch':'x64','libc':'glibc'},configurationIncluded=False,deployed=False,releaseReady=False)
 migration=ROOT/'db/migrations'/M.MIGRATION
 candidate['files']['db/migrations/'+M.MIGRATION]=migration.read_bytes() if migration.exists() else b'synthetic-reviewed-guard104'
 helper=b'synthetic-reviewed-helper';archive=b'synthetic-private-archive'
 b={'schemaVersion':1,'kind':'trial-support-ai-human-collaboration-upgrade','baselineHead':M.BASELINE_HEAD,'baselineTree':M.BASELINE_TREE,'sourceHead':'1'*40,'sourceTree':'2'*40,'helperSha256':M.sha(helper),'manifestSha256':'a'*64,'archiveSha256':M.sha(archive),'archiveBytes':len(archive),'archivePath':str(M.STAGES/('support-ai-human-collaboration-'+'1'*12+'-synthetic123')/'archive.tar.gz'),'dependenciesSha256':M.DEPENDENCIES,'migrations':104,'applicationRollbackAllowed':False,'migrationSha256':{name:M.sha(candidate['files']['db/migrations/'+name]) for name in names+[M.MIGRATION]}}
 return old,candidate,b,helper,archive

class ArtifactTests(unittest.TestCase):
 def test_exact_current_helper_binding_and_artifact_are_pinned(self):
  self.assertEqual(M.BASELINE_HEAD,'83a59649715d150a1f71d7c0209fb7f126552b37')
  self.assertEqual(M.sha((ROOT/'infra/tencent/trial-support-fresh-update.py').read_bytes()),M.BASELINE_HELPER_SHA)
  self.assertEqual(M.BASELINE_BINDING_SHA,'b55434bf2ab897cf96011a18a036748963aa46355753f27e8f04fc070cd8d36b')
  self.assertEqual(M.HELPER_SOURCE,'infra/tencent/trial-support-ai-human-collaboration-upgrade.py')
  self.assertEqual(M.sha((ROOT/'db/migrations'/M.MIGRATION).read_bytes()),M.MIGRATION_SHA)
  old,candidate,b,helper,_=fixture()
  with patch.object(M,'__file__',str(RUNNER)),patch.object(M,'read',return_value=helper):self.assertEqual(M.validate_binding(b),b)
  M.artifact_contract(old,candidate,b)
 def test_all_old103_sql_migrator_package_and_lock_bytes_remain_exact(self):
  old,candidate,b,_,_=fixture()
  for name in old['files']:
   changed=copy.deepcopy(candidate);changed['files'][name]+=b'x'
   with self.subTest(name=name),self.assertRaises(M.Refused):M.artifact_contract(old,changed,b)
 def test_unique104_sql_hash_is_required(self):
  old,candidate,b,_,_=fixture();candidate['files']['db/migrations/'+M.MIGRATION]+=b'x'
  with self.assertRaisesRegex(M.Refused,'SQL_BINDING_HASH'):M.artifact_contract(old,candidate,b)
 def test_no_extra_missing_or_reordered_migrations(self):
  old,candidate,b,_,_=fixture()
  for names in [candidate['manifest']['migrations'][:-1],candidate['manifest']['migrations']+['209901010001_unrequested.sql'],list(reversed(candidate['manifest']['migrations']))]:
   changed=copy.deepcopy(candidate);changed['manifest']['migrations']=names
   with self.subTest(names=names[-2:]),self.assertRaises(M.Refused):M.artifact_contract(old,changed,b)
 def test_distinct_trial_linux_exact_dependency_candidate_only(self):
  old,candidate,b,_,_=fixture()
  for edit in [{'directory':'/opt/cisme/releases/tencent-release-'+'1'*12},{'dependenciesSha256':'f'*64},{'directory':old['directory']}]:
   with self.subTest(edit=edit),self.assertRaises(M.Refused):M.artifact_contract(old,{**candidate,**edit},b)
  candidate['manifest']['buildPlatform']['os']='darwin'
  with self.assertRaises(M.Refused):M.artifact_contract(old,candidate,b)
 def test_binding_refuses_wrong_scope_count_rollback_path_or_hash(self):
  _,_,b,helper,_=fixture()
  for edit in [{'migrations':103},{'migrations':105},{'applicationRollbackAllowed':True},{'sourceHead':M.BASELINE_HEAD},{'archivePath':'/tmp/archive.tar.gz'},{'migrationSha256':{}},{'helperSha256':'f'*64},{'archiveBytes':True},{'baselineTree':'f'*40}]:
   with self.subTest(edit=edit),patch.object(M,'__file__',str(RUNNER)),patch.object(M,'read',return_value=helper),self.assertRaises(M.Refused):M.validate_binding({**b,**edit})
 def test_binding_and_runner_are_exact_own_namespace(self):
  _,_,b,helper,_=fixture();raw=json.dumps(b).encode();exact=RUNNER.parent/'application-binding.json'
  with patch.object(M,'__file__',str(RUNNER)),patch.object(M,'read',side_effect=lambda p,*args:helper if p.name==RUNNER.name else raw):
   self.assertEqual(M.binding(exact,M.sha(raw)),b)
   with self.assertRaises(M.Refused):M.binding(exact.with_name('binding.json'),M.sha(raw))
  with patch.object(M,'__file__','/tmp/untrusted.py'),patch.object(M,'read',return_value=helper),self.assertRaises(M.Refused):M.validate_binding(b)

class CommittedSourceTests(unittest.TestCase):
 def test_exact_committed_tree_pins_helper_all104_sql_and_verify_only(self):
  _,candidate,b,helper,_=fixture()
  sources={M.HELPER_SOURCE:helper,'scripts/release-migrate.mjs':candidate['files']['migrate.mjs']}
  sources.update({name:raw for name,raw in candidate['files'].items() if name.startswith('db/migrations/')})
  tree={'sha':b['sourceTree'],'truncated':False,'tree':[{'path':name,'type':'blob','mode':'100644','sha':M.git_blob(raw)} for name,raw in sources.items()]}
  commit={'sha':b['sourceHead'],'tree':{'sha':b['sourceTree']}}
  command=Mock(return_value=json.dumps({'verified':True,'sourceHead':b['sourceHead'],'sourceTree':b['sourceTree'],'migrations':104}).encode())
  package=lambda name,head:fixture_source(name)
  with patch.object(M,'response',side_effect=[json.dumps(commit).encode(),json.dumps(tree).encode()]),patch.object(M,'read',return_value=helper),patch.object(M,'source_bytes',side_effect=package),patch.object(M,'D',types.SimpleNamespace(command=command)):
   M.source_permit(b,candidate)
  self.assertEqual(command.call_args.args[0][-1],'verify');self.assertNotIn('up',command.call_args.args[0])
 def test_truncated_tree_wrong104_or_uncommitted_helper_cannot_execute(self):
  _,candidate,b,helper,_=fixture()
  sources={M.HELPER_SOURCE:helper,'scripts/release-migrate.mjs':candidate['files']['migrate.mjs']}
  sources.update({name:raw for name,raw in candidate['files'].items() if name.startswith('db/migrations/')})
  tree={'sha':b['sourceTree'],'truncated':False,'tree':[{'path':name,'type':'blob','mode':'100644','sha':M.git_blob(raw)} for name,raw in sources.items()]}
  commit={'sha':b['sourceHead'],'tree':{'sha':b['sourceTree']}}
  for mode in ['truncated','helper','104']:
   edited=copy.deepcopy(tree)
   if mode=='truncated':edited['truncated']=True
   else:
    target=M.HELPER_SOURCE if mode=='helper' else 'db/migrations/'+M.MIGRATION
    next(entry for entry in edited['tree'] if entry['path']==target)['sha']='f'*40
   command=Mock()
   with self.subTest(mode=mode),patch.object(M,'response',side_effect=[json.dumps(commit).encode(),json.dumps(edited).encode()]),patch.object(M,'read',return_value=helper),patch.object(M,'D',types.SimpleNamespace(command=command)),self.assertRaises(M.Refused):M.source_permit(b,candidate)
   command.assert_not_called()

class ReadOnlyGuardTests(unittest.TestCase):
 def test_schema_guard_exact_columns_owner_controlled_reply_and_trigger_for_each_phase(self):
  for flag in [False,True]:
   value={'columns':M.COLLABORATION_COLUMNS if flag else [],'controlledReplyGuard':flag,'controlledReplyStates':flag,'senderOwner':'cisme_trial','senderTrigger':True}
   objects={'metadataGuard':flag,'constraints':M.COLLABORATION_CONSTRAINTS if flag else [],'replyIndex':M.REPLY_INDEX if flag else None,'replyForeignKeys':0}
   with patch.object(M,'D',types.SimpleNamespace(query=Mock(side_effect=[value,objects]))):M.schema104(PROFILE,flag)
  good={'columns':M.COLLABORATION_COLUMNS,'controlledReplyGuard':True,'controlledReplyStates':True,'senderOwner':'cisme_trial','senderTrigger':True}
  for edit in [{'columns':[]},{'controlledReplyGuard':False},{'controlledReplyStates':False},{'senderOwner':'postgres'},{'senderTrigger':False}]:
   with self.subTest(edit=edit),patch.object(M,'D',types.SimpleNamespace(query=Mock(return_value={**good,**edit}))),self.assertRaises(M.Refused):M.schema104(PROFILE,True)
 def test_new_metadata_checks_index_and_no_reply_fk_are_exact(self):
  columns={'columns':M.COLLABORATION_COLUMNS,'controlledReplyGuard':True,'controlledReplyStates':True,'senderOwner':'cisme_trial','senderTrigger':True}
  objects={'metadataGuard':True,'constraints':M.COLLABORATION_CONSTRAINTS,'replyIndex':M.REPLY_INDEX,'replyForeignKeys':0}
  for edit in [{'metadataGuard':False},{'constraints':[]},{'replyIndex':None},{'replyForeignKeys':1},{'replyIndex':{**M.REPLY_INDEX,'valid':False}},{'replyIndex':{**M.REPLY_INDEX,'unique':True}},{'constraints':[{**M.COLLABORATION_CONSTRAINTS[0],'definition':'CHECKtrue'},*M.COLLABORATION_CONSTRAINTS[1:]]}]:
   with self.subTest(edit=edit),patch.object(M,'D',types.SimpleNamespace(query=Mock(side_effect=[columns,{**objects,**edit}]))),self.assertRaises(M.Refused):M.schema104(PROFILE,True)
 def test_new_fields_require_exact_neutral_old_row_values(self):
  query=Mock(return_value={'conversationFieldsNeutral':True,'replyLinksNeutral':True})
  with patch.object(M,'D',types.SimpleNamespace(query=query)):M.neutral_initial_fields(PROFILE)
  sql=query.call_args.args[1]
  self.assertIn('human_request_generation IS DISTINCT FROM 0',sql);self.assertIn('human_request_anchor_sequence IS NOT NULL',sql);self.assertIn('human_request_context_version IS DISTINCT FROM 0',sql);self.assertIn('reply_to_message_id IS NOT NULL',sql)
  for value in [{'conversationFieldsNeutral':False,'replyLinksNeutral':True},{'conversationFieldsNeutral':True,'replyLinksNeutral':False}]:
   with self.subTest(value=value),patch.object(M,'D',types.SimpleNamespace(query=Mock(return_value=value))),self.assertRaises(M.Refused):M.neutral_initial_fields(PROFILE)
 def test_journal_validates_trial_role_isolation_and_both_schema_invariants(self):
  old,candidate,*_=fixture();plan={'profile':PROFILE,'config':{},'ownership':{}}
  for names in [old['manifest']['migrations'],candidate['manifest']['migrations']]:
   guard=Mock(return_value=names);schema101=Mock();schema103=Mock();schema104=Mock()
   with patch.object(M,'C',types.SimpleNamespace(database_guard=guard)),patch.object(M,'S',types.SimpleNamespace(schema101=schema101)),patch.object(M,'B',types.SimpleNamespace(schema103=schema103)),patch.object(M,'schema104',schema104):
    self.assertEqual(M.journal(plan,[names],True),names)
    guard.assert_called_once_with(PROFILE,{}, {},[names],True);schema101.assert_called_once_with(PROFILE);schema103.assert_called_once_with(PROFILE);schema104.assert_called_once_with(PROFILE,len(names)==104)
 def test_fence_covers_tables_and_avoids_json_argument_limit(self):
  query=Mock(side_effect=[['audit_log','support_conversation','support_message'],{'safe':'fingerprint'}])
  with patch.object(M,'D',types.SimpleNamespace(query=query)):self.assertEqual(M.business_fence(PROFILE),{'safe':'fingerprint'})
  sql=query.call_args_list[-1].args[1]
  self.assertIn('jsonb_object_agg',sql);self.assertIn('UNION ALL',sql)
  for name in ['audit_log','support_conversation','support_message']:self.assertIn('FROM '+name+' t',sql)
  self.assertNotIn('DELETE',sql);self.assertNotIn('UPDATE',sql)
 def test_fence_refuses_untrusted_catalog_names(self):
  for names in [[],['foo; DROP TABLE member'],['schema_migration--'],None]:
   with self.subTest(names=names),patch.object(M,'D',types.SimpleNamespace(query=Mock(return_value=names))),self.assertRaises(M.Refused):M.business_fence(PROFILE)

class CutoverTests(unittest.TestCase):
 def run_cutover(self,fail=None):
  old,candidate,b,_,_=fixture();state=M.STATE_PARENT/('commit-'+'1'*12+'-123')
  plan={'profile':PROFILE,'config':{'APP_ENV':'staging'},'old':old,'candidate':candidate,'binding':b,'ownership':{'ownershipId':'synthetic'}}
  events=[]
  def track(name,result=None):
   def f(*a,**kw):
    events.append((name,a,kw))
    if fail==name:raise RuntimeError('synthetic '+name)
    return result
   return f
  def command(args,**kwargs):
   name='migrate' if args[-1]=='up' else 'stop' if args[1]=='stop' else 'start'
   return track(name)(args,**kwargs)
  d=types.SimpleNamespace(command=command,stopped=track('stopped'),switch=track('switch'),verify_units=track('verify_units'),healthy=track('healthy',{}),atomic_bytes=track('publish'),general=types.SimpleNamespace(store=track('store')))
  snapshot={'backupReference':'TRIAL-SNAPSHOT-synthetic'}
  s=types.SimpleNamespace(snapshot=track('snapshot',snapshot),validate_snapshot=track('validate_snapshot'),BASELINE_HEAD='historical-aad-only')
  patches={'D':d,'S':s,'verify_context':track('verify_context'),'journal':track('journal'),'backup_inputs':track('backup_inputs'),'business_fence':track('business_fence',{'support_conversation':'unchanged'}),'save_plan':track('save_plan','a'*64),'neutral_initial_fields':track('neutral_initial_fields'),'read':track('read',b'protected-receipt'),'verify_history':track('verify_history'),'public_contract':track('public_contract'),'active_record':track('active_record',b'published')}
  with unittest.mock.patch.multiple(M,**patches):
   if fail:
    with self.assertRaises(Exception):M.cutover(plan,state,'USER-AUTHORIZED-CISME-104')
   else:self.assertTrue(M.cutover(plan,state,'USER-AUTHORIZED-CISME-104')['deployed'])
  return events
 def test_snapshot_and_business_fence_precede_migration_then_switch_and_health(self):
  events=self.run_cutover();names=[e[0] for e in events]
  for before,after in [('stop','business_fence'),('business_fence','snapshot'),('snapshot','validate_snapshot'),('validate_snapshot','migrate'),('migrate','neutral_initial_fields'),('neutral_initial_fields','switch'),('switch','start'),('start','healthy'),('healthy','publish')]:self.assertLess(names.index(before),names.index(after))
  cmd=next(e for e in events if e[0]=='migrate');self.assertIn('cisme-trial',cmd[1][0]);self.assertEqual(cmd[2]['env']['CISME_PREDEPLOY_BACKUP_REF'],'TRIAL-SNAPSHOT-synthetic')
  self.assertFalse(any('restore' in str(e[1]).lower() for e in events if e[0] in ['migrate','start','stop']))
 def test_snapshot_or_migration_failure_never_switches_or_restores(self):
  for fail in ['snapshot','validate_snapshot','migrate','neutral_initial_fields']:
   events=self.run_cutover(fail);names=[e[0] for e in events]
   self.assertNotIn('switch',names);self.assertNotIn('start',names);self.assertGreaterEqual(names.count('stop'),2)
 def test_post_cutover_failure_fences_stops_with_no_automatic_rollback(self):
  events=self.run_cutover('healthy');names=[e[0] for e in events]
  self.assertEqual(names.count('switch'),1);self.assertNotIn('publish',names);self.assertGreaterEqual(names.count('stop'),2)
 def test_pre_stop_verification_failure_does_not_interrupt_live_services(self):
  events=self.run_cutover('verify_context');self.assertNotIn('stop',[e[0] for e in events])

class CollaborationSpecificTests(unittest.TestCase):
 def test_business_projection_excludes_only_exact_new_columns(self):
  query=Mock(side_effect=[['member','support_conversation','support_message'],{}])
  with patch.object(M,'D',types.SimpleNamespace(query=query)):M.business_fence(PROFILE)
  sql=query.call_args.args[1]
  self.assertIn("to_jsonb(t)-ARRAY['human_request_generation','human_request_anchor_sequence','human_request_context_version']",sql)
  self.assertIn("to_jsonb(t)-'reply_to_message_id'",sql)
  for key in ['status','current_handler_principal_id','body','version','updated_at']:
   self.assertNotIn("-'"+key+"'",sql)
  self.assertEqual(sql.count("-ARRAY["),2)
  self.assertEqual(sql.count("-'reply_to_message_id'"),2)
 def test_upgrade_never_invokes_return_to_ai_or_real_chat_actions(self):
  source=(HERE/'trial-support-ai-human-collaboration-upgrade.py').read_text()
  for forbidden in ['support_end_human_ai_transition','support_member_end_human','resume-ai','support-human-return-ai','/v1/me/support/messages','UPDATE support_conversation','DELETE FROM support_message']:
   self.assertNotIn(forbidden,source)
  self.assertIn("'liveChatProbePerformed': False",source)
  self.assertIn("'newCollaborationFieldsInitiallyNeutral': True",source)
 def test_business_fingerprint_mismatch_blocks_switch(self):
  old,candidate,b,_,_=fixture()
  plan={'profile':PROFILE,'config':{},'old':old,'candidate':candidate,'binding':b}
  d=types.SimpleNamespace(command=Mock(),stopped=Mock(),switch=Mock(),general=types.SimpleNamespace(store=Mock()))
  s=types.SimpleNamespace(snapshot=Mock(return_value={'backupReference':'snapshot'}),validate_snapshot=Mock(),BASELINE_HEAD='historic')
  with patch.multiple(M,D=d,S=s,verify_context=Mock(),journal=Mock(),backup_inputs=Mock(),business_fence=Mock(side_effect=[{'hash':'before'},{'hash':'changed'}]),neutral_initial_fields=Mock(),save_plan=Mock(return_value='hash'),read=Mock(return_value=b'receipt')):
   with self.assertRaises(M.Refused):M.cutover(plan,M.STATE_PARENT/'synthetic','USER-AUTHORIZED-CISME-104')
  d.switch.assert_not_called()
  self.assertTrue(any(call.args[0][1]=='stop' for call in d.command.call_args_list))

if __name__=='__main__':unittest.main()
