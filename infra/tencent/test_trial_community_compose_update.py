"""Offline exact6123/schema104 -> sole105 guards. No network, SSH or database."""
import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import ssl
import tempfile
import types
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SPEC = importlib.util.spec_from_file_location('community_compose_update', HERE / 'trial-community-compose-update.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
PROFILE = {'name': 'trial', 'root': str(M.ROOT), 'units': ('cisme-trial-api.service', 'cisme-trial-worker.service'),
           'domain': 'trial.synthetic.invalid', 'database': 'cisme_trial', 'user': 'cisme-trial'}
RUNNER = M.RUNNERS / ('1' * 12) / 'trial-community-compose-update.py'


# Historical deployment guards retain their approved dependency bytes.
# Today's dependency additions must not rewrite those immutable allowlists.
def fixture_source(name):
    base=REPO/'infra/tencent/fixtures/approved-dependencies-before-commerce-20261110' if str(name) in ('package.json','package-lock.json') else REPO
    return (base/name).read_bytes()


def fixtures():
    names = sorted(p.name for p in (REPO / 'db/migrations').glob('*.sql') if p.name <= '202610310001_support_ai_human_collaboration.sql')
    assert len(names) == 104 and names[-1] == '202610310001_support_ai_human_collaboration.sql'
    files = {name: fixture_source(path) for name, path in [('migrate.mjs', 'scripts/release-migrate.mjs'),
        ('package.json', 'package.json'), ('package-lock.json', 'package-lock.json')]}
    files.update({'db/migrations/' + name: (REPO / 'db/migrations' / name).read_bytes() for name in names})
    old = {'directory': str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12])), 'files': files,
           'dependenciesSha256': M.DEPENDENCIES, 'manifestSha256': M.BASELINE_MANIFEST,
           'manifest': {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'migrations': names}}
    candidate = copy.deepcopy(old)
    candidate.update(directory=str(M.ROOT / 'releases' / ('tencent-release-' + '1' * 12)), manifestSha256='a' * 64)
    candidate['manifest'].update(sourceHead='1' * 40, sourceTree='2' * 40, sourceLockSha256=M.SOURCE_LOCK,
        migrations=names + [M.MIGRATION],
        node='v24.14.0', buildPlatform={'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
        configurationIncluded=False, deployed=False, releaseReady=False)
    candidate['files']['db/migrations/' + M.MIGRATION] = (REPO / 'db/migrations' / M.MIGRATION).read_bytes()
    helper, archive = b'synthetic-closure-helper', b'synthetic-archive'
    binding = {'schemaVersion': 1, 'kind': 'trial-community-compose-update', 'baselineHead': M.BASELINE_HEAD,
        'baselineTree': M.BASELINE_TREE, 'sourceHead': '1' * 40, 'sourceTree': '2' * 40, 'ciRunId': 123, 'ciVerifyJobId': 456,
        'helperSha256': M.sha(helper), 'manifestSha256': 'a' * 64, 'archiveSha256': M.sha(archive),
        'archiveBytes': len(archive), 'archivePath': str(M.STAGES / ('community-compose-' + '1' * 12 + '-synthetic123') / 'archive.tar.gz'),
        'dependenciesSha256': M.DEPENDENCIES, 'migrations': 105, 'applicationRollbackAllowed': False,
        'migrationSha256': {name: M.sha(candidate['files']['db/migrations/' + name]) for name in names + [M.MIGRATION]}}
    return old, candidate, binding, helper, archive


def inherited_fixture():
    binding = {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE}
    active_path = M.ROOT / 'support-closure-updates' / 'active-release.json'
    state = active_path.parent / ('commit-' + M.BASELINE_HEAD[:12] + '-123')
    key = '/root/private/synthetic-original-deepseek-key'
    private = {key: b'synthetic-original-key', '/root/private/prior-plan': b'original-immutable-plan'}
    history = {str(M.ROOT / 'ownership.json'): b'original-ownership', '/opt/cisme-trial/older/active-release.json': b'prior-active'}
    prior = {'binding': binding, 'candidate': {'directory': str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12]))},
             'history': dict(history), 'protectedBaselineInputs': {p: {'limit': 256, 'sha256': M.sha(raw)} for p, raw in private.items()}}
    saved = b'{}'
    history[str(active_path)] = json.dumps({'upgradeState': str(state), 'privatePlanSha256': M.sha(saved)}).encode()
    helper, old_binding = b'original6c-helper', b'original6c-binding'
    private.update({str(state / 'protected-plan.json'): saved,
        str(M.BASELINE_RUNNER / 'trial-support-closure-update.py'): helper,
        str(M.BASELINE_RUNNER / 'application-binding.json'): old_binding})
    original_support = types.SimpleNamespace(BASELINE_RUNNER=M.ROOT / 'comment-support-runners' / 'synthetic', BASELINE_BINDING_SHA='d' * 64)
    h = types.SimpleNamespace(ACTIVE=active_path, STATE_PARENT=active_path.parent,
        B=types.SimpleNamespace(binding=Mock(return_value={'deepseekKeyFile': key})),
        P=types.SimpleNamespace(P=types.SimpleNamespace(P=types.SimpleNamespace(A=original_support))))
    return binding, history, prior, private, h, helper, old_binding


def guard_facts(upgraded=False):
    common = {'owner': 'cisme_trial', 'language': 'plpgsql', 'securityDefiner': False, 'config': None,
              'returnsTrigger': True, 'kind': 'f', 'volatile': 'v', 'strict': False, 'leakproof': False}
    trigger = {'enabled': 'O', 'functionMatches': True, 'internal': False, 'args': 0, 'when': None}
    return {'post': {**common, 'prosrcSha256': M.POST_GUARD_105_SHA if upgraded else M.POST_GUARD_104_SHA, 'definitionSha256': '1' * 64},
        'revision': {**common, 'prosrcSha256': M.REVISION_GUARD_SHA, 'definitionSha256': '2' * 64},
        'postTrigger': {**trigger, 'type': 23, 'columns': ['author_member_id', 'client_request_key', 'state', 'current_revision', 'published_revision'], 'definitionSha256': '3' * 64},
        'revisionTrigger': {**trigger, 'type': 27, 'columns': [], 'definitionSha256': '4' * 64}}


class UpgradeContractTests(unittest.TestCase):
    def test_exact_frozen105_and_original_post_and_immutable_revision_bodies_are_pinned(self):
        old_sql = (REPO / 'db/migrations/202609120003_formal_ugc_editor.sql').read_text().split('-- migrate:down')[0]
        new_sql = (REPO / 'db/migrations' / M.MIGRATION).read_bytes()
        self.assertEqual(M.sha(new_sql), M.MIGRATION_SHA)
        for text, name, expected in ((old_sql, 'guard_ugc_post_update', M.POST_GUARD_104_SHA),
                (old_sql, 'guard_ugc_revision_mutation', M.REVISION_GUARD_SHA),
                (new_sql.decode().split('-- migrate:down')[0], 'guard_ugc_post_update', M.POST_GUARD_105_SHA)):
            body = re.search(r'CREATE OR REPLACE FUNCTION ' + name + r'\(\).*?AS \$\$(.*?)\$\$;', text, re.S).group(1)
            self.assertEqual(M.sha(body.encode()), expected)
        self.assertNotIn('guard_ugc_revision_mutation', new_sql.decode())

    def test_snapshot_primitive_must_be_the_exact_inherited_module_path_bytes_and_object(self):
        collaboration = b'pinned-collaboration'; snapshot = (HERE / 'trial-daily-day-upgrade.py').read_bytes()
        path = M.ROOT / 'support-ai-human-collaboration-runners/6c90079f25cf/trial-support-ai-human-collaboration-upgrade.py'
        for changed in ('none', 'identity', 'path', 'bytes', 'method'):
            s = types.SimpleNamespace(__file__=str(M.SNAPSHOT_RUNNER / 'trial-daily-day-upgrade.py'), snapshot=Mock(), validate_snapshot=Mock(), schema101=Mock())
            k = types.SimpleNamespace(__file__=str(path), S=s, B=types.SimpleNamespace(B=s, BASELINE_RUNNER=M.SNAPSHOT_RUNNER, BASELINE_HELPER_SHA=M.SNAPSHOT_HELPER_SHA))
            h = types.SimpleNamespace(H=k, BASELINE_RUNNER=path.parent, BASELINE_HELPER_SHA=M.sha(collaboration))
            if changed == 'identity': k.B.B = object()
            if changed == 'path': s.__file__ = '/tmp/untrusted.py'
            if changed == 'method': s.snapshot = None
            reader = lambda p, limit: collaboration if p == path else snapshot + (b'drift' if changed == 'bytes' else b'')
            with self.subTest(changed=changed), patch.object(M, 'H', h), patch.object(M, 'read', side_effect=reader):
                if changed == 'none': M.load_upgrade_primitives(); self.assertIs(M.S, s); self.assertIs(M.K, k)
                else:
                    with self.assertRaises(M.Refused): M.load_upgrade_primitives()

    def test_actual105_function_owner_and_both_enabled_trigger_contracts_are_checked(self):
        baseline = guard_facts()
        for upgraded in (False, True):
            facts = guard_facts(upgraded); query = Mock(return_value=facts)
            with patch.object(M, 'D', types.SimpleNamespace(query=query)):
                self.assertEqual(M.ugc_guards(PROFILE, upgraded, baseline), facts)
            self.assertIn('p.prosrc', query.call_args.args[1]); self.assertIn('pg_get_functiondef', query.call_args.args[1]); self.assertIn('pg_get_triggerdef', query.call_args.args[1])
        for change in ('old-post', 'owner', 'security', 'revision-body', 'revision-definition', 'disabled', 'function', 'trigger-columns', 'revision-trigger'):
            facts = guard_facts(True)
            if change == 'old-post': facts['post']['prosrcSha256'] = M.POST_GUARD_104_SHA
            elif change == 'owner': facts['post']['owner'] = 'postgres'
            elif change == 'security': facts['post']['securityDefiner'] = True
            elif change == 'revision-body': facts['revision']['prosrcSha256'] = 'f' * 64
            elif change == 'revision-definition': facts['revision']['definitionSha256'] = 'f' * 64
            elif change == 'disabled': facts['postTrigger']['enabled'] = 'D'
            elif change == 'function': facts['postTrigger']['functionMatches'] = False
            elif change == 'trigger-columns': facts['postTrigger']['columns'].remove('published_revision')
            else: facts['revisionTrigger']['definitionSha256'] = 'f' * 64
            with self.subTest(change=change), patch.object(M, 'D', types.SimpleNamespace(query=Mock(return_value=facts))), self.assertRaises(M.Refused):
                M.ugc_guards(PROFILE, True, baseline)

    def test_snapshot_authentication_and_actual6123_binding_are_rechecked_by_active_audit(self):
        old, _, b, _, _ = fixtures(); state = M.STATE_PARENT / ('commit-' + b['sourceHead'][:12] + '-123')
        backup = {'backupReference': 'TRIAL-SNAPSHOT-' + state.name, 'authenticated': True}; receipt = json.dumps(backup).encode()
        plan = {'old': old, 'binding': b, 'operationReference': 'SYNTHETIC-ONLY'}
        s = types.SimpleNamespace(BASELINE_HEAD='historical-aad-label', validate_snapshot=Mock())
        with patch.object(M, 'S', s), patch.object(M, 'read', return_value=receipt):
            value = M.snapshot_binding(plan, state, plan['operationReference'], backup)
        self.assertEqual(value['actualBaselineHead'], M.BASELINE_HEAD); self.assertEqual(value['actualBaselineTree'], M.BASELINE_TREE)
        self.assertEqual(value['actualBaselineManifestSha256'], M.BASELINE_MANIFEST); self.assertEqual(value['actualMigrationCount'], 104)
        self.assertFalse(value['aadClaimsCurrentBaseline']); self.assertNotEqual(value['cryptoAadBaselineLabel'], value['actualBaselineHead'])
        raw = (json.dumps(value, sort_keys=True) + '\n').encode(); plan['snapshotBindingSha256'] = M.sha(raw)
        def reader(path, limit): return receipt if path.name == 'snapshot-private.json' else raw
        with patch.object(M, 'S', s), patch.object(M, 'read', side_effect=reader): M.verify_snapshot(plan, state)
        s.validate_snapshot.assert_called_once_with(backup, state, 'SYNTHETIC-ONLY')
        with patch.object(M, 'S', s), patch.object(M, 'read', side_effect=lambda p, limit: receipt if p.name == 'snapshot-private.json' else raw + b' '), self.assertRaises(M.Refused): M.verify_snapshot(plan, state)
        s.validate_snapshot.side_effect = RuntimeError('synthetic authentication failure')
        with patch.object(M, 'S', s), patch.object(M, 'read', side_effect=reader), self.assertRaises(RuntimeError): M.verify_snapshot(plan, state)


class ResponseTests(unittest.TestCase):
    URL = 'https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/contents/package-lock.json?ref=' + '1' * 40

    @staticmethod
    def remote(body=b'complete', declared=None, status=200):
        response = types.SimpleNamespace(status=status, headers={} if declared is None else {'Content-Length': declared}, closed=False)
        response.read = Mock(side_effect=body) if isinstance(body, Exception) else Mock(return_value=body)
        class Context:
            def __enter__(self): return response
            def __exit__(self, *args): response.closed = True
        return Context(), response

    def test_retries_a_declared_short_read_at_the_same_endpoint_and_discards_partial_bytes(self):
        short, first = self.remote(b'part', '8'); complete, second = self.remote(b'complete', '8')
        opener = types.SimpleNamespace(open=Mock(side_effect=[short, complete]))
        with patch.object(M.urllib.request, 'build_opener', return_value=opener) as build:
            self.assertEqual(M.response(self.URL, 16), b'complete')
        self.assertEqual(opener.open.call_count, 2)
        request = opener.open.call_args_list[0].args[0]
        for call in opener.open.call_args_list:
            self.assertIs(call.args[0], request); self.assertEqual(request.full_url, self.URL); self.assertEqual(call.kwargs, {'timeout': 12})
        self.assertEqual(request.get_header('Accept'), 'application/vnd.github+json')
        self.assertEqual(request.get_header('Cache-control'), 'no-cache')
        self.assertEqual(build.call_args.args[0].proxies, {}); self.assertIsInstance(build.call_args.args[1], M.NoRedirect)
        for response in (first, second): response.read.assert_called_once_with(17); self.assertTrue(response.closed)

    def test_retries_an_incomplete_chunked_read_without_a_declared_size(self):
        truncated, first = self.remote(M.http.client.IncompleteRead(b'partial', None)); complete, second = self.remote(b'complete')
        opener = types.SimpleNamespace(open=Mock(side_effect=[truncated, complete]))
        with patch.object(M.urllib.request, 'build_opener', return_value=opener): self.assertEqual(M.response(self.URL, 16), b'complete')
        self.assertEqual(opener.open.call_count, 2); self.assertTrue(first.closed); self.assertTrue(second.closed)

    def test_only_the_exact_public_repository_commit_tree_and_package_endpoints_can_retry(self):
        base = 'https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/'
        paths = ['git/commits/' + '1' * 40, 'git/trees/' + '2' * 40 + '?recursive=1',
                 'contents/package.json?ref=' + '1' * 40, 'contents/package-lock.json?ref=' + '2' * 40]
        for path in paths:
            short, _ = self.remote(b'part', '8'); complete, _ = self.remote(b'complete', '8')
            opener = types.SimpleNamespace(open=Mock(side_effect=[short, complete]))
            with self.subTest(path=path), patch.object(M.urllib.request, 'build_opener', return_value=opener):
                self.assertEqual(M.response(base + path, 16), b'complete')
            self.assertEqual(opener.open.call_count, 2)

    def test_imds_and_similar_or_foreign_urls_never_retry_short_or_incomplete_reads(self):
        urls = ['http://metadata.tencentyun.com/latest/meta-data/instance-id',
                self.URL.replace('Eysn0130/cisme-wechat-miniapp', 'Other/project'),
                self.URL.replace('api.github.com/', 'api.github.com.evil.invalid/'),
                self.URL.replace('cisme-wechat-miniapp/', 'cisme-wechat-miniapp-other/'),
                self.URL.replace('https://', 'http://'), self.URL + '&extra=1', self.URL + '#fragment',
                self.URL.replace('/contents/package-lock.json', '/contents/runtime.env')]
        for url in urls:
            for body, declared in [(b'part', '8'), (M.http.client.IncompleteRead(b'part', None), None)]:
                context, response = self.remote(body, declared); opener = types.SimpleNamespace(open=Mock(return_value=context))
                with self.subTest(url=url, body=type(body).__name__), patch.object(M.urllib.request, 'build_opener', return_value=opener), \
                     self.assertRaisesRegex(M.Refused, '^COMMUNITY_COMPOSE_RESPONSE_TRUNCATED$'): M.response(url, 16)
                self.assertEqual(opener.open.call_count, 1); response.read.assert_called_once_with(17); self.assertTrue(response.closed)

    def test_three_truncated_attempts_fail_closed_with_each_body_bounded_and_closed(self):
        for body, declared in [(b'', '8'), (b'part', '8'), (M.http.client.IncompleteRead(b'part', None), None)]:
            responses = [self.remote(body, declared) for _ in range(3)]
            opener = types.SimpleNamespace(open=Mock(side_effect=[context for context, _ in responses]))
            with self.subTest(body=type(body).__name__, declared=declared), patch.object(M.urllib.request, 'build_opener', return_value=opener), \
                 self.assertRaisesRegex(M.Refused, '^COMMUNITY_COMPOSE_RESPONSE_TRUNCATED$'):
                M.response(self.URL, 16)
            self.assertEqual(opener.open.call_count, 3)
            for _, response in responses: response.read.assert_called_once_with(17); self.assertTrue(response.closed)

    def test_http_tls_redirect_and_unclassified_transport_errors_are_never_retried(self):
        errors = [urllib.error.HTTPError(self.URL, 429, 'rate limit', {}, None),
                  ssl.SSLCertVerificationError('synthetic TLS failure'), urllib.error.URLError(ssl.SSLCertVerificationError('synthetic TLS failure')),
                  M.Refused('COMMUNITY_COMPOSE_REDIRECT_REFUSED'), TimeoutError('synthetic timeout')]
        for error in errors:
            opener = types.SimpleNamespace(open=Mock(side_effect=error))
            with self.subTest(error=type(error).__name__), patch.object(M.urllib.request, 'build_opener', return_value=opener), self.assertRaises(type(error)):
                M.response(self.URL, 16)
            if isinstance(error, urllib.error.HTTPError): error.close()
            self.assertEqual(opener.open.call_count, 1)
        with self.assertRaisesRegex(M.Refused, '^COMMUNITY_COMPOSE_REDIRECT_REFUSED$'): M.NoRedirect().redirect_request()

    def test_invalid_status_or_declared_size_is_refused_before_reading_without_retry(self):
        for status, declared, code in [(302, None, 'SOURCE_UNAVAILABLE'), (503, None, 'SOURCE_UNAVAILABLE'),
                                      (200, '17', 'RESPONSE_SIZE_REQUIRED'), (200, '0', 'RESPONSE_SIZE_REQUIRED'),
                                      (200, '-1', 'RESPONSE_SIZE_REQUIRED'), (200, '8x', 'RESPONSE_SIZE_REQUIRED')]:
            context, response = self.remote(declared=declared, status=status); opener = types.SimpleNamespace(open=Mock(return_value=context))
            with self.subTest(status=status, declared=declared), patch.object(M.urllib.request, 'build_opener', return_value=opener), \
                 self.assertRaisesRegex(M.Refused, '^COMMUNITY_COMPOSE_' + code + '$'): M.response(self.URL, 16)
            self.assertEqual(opener.open.call_count, 1); response.read.assert_not_called(); self.assertTrue(response.closed)

    def test_oversize_extra_or_undeclared_empty_bodies_are_not_treated_as_retryable_truncation(self):
        cases = [(b'x' * 17, None), (b'extra', '4'), (b'', None),
                 (M.http.client.IncompleteRead(b'x' * 17, None), None), (M.http.client.IncompleteRead(b'equal', None), '5')]
        for body, declared in cases:
            context, response = self.remote(body, declared); opener = types.SimpleNamespace(open=Mock(return_value=context))
            with self.subTest(body=type(body).__name__, declared=declared), patch.object(M.urllib.request, 'build_opener', return_value=opener), \
                 self.assertRaisesRegex(M.Refused, '^COMMUNITY_COMPOSE_RESPONSE_TRUNCATED$'): M.response(self.URL, 16)
            self.assertEqual(opener.open.call_count, 1); self.assertTrue(response.closed)

    def test_complete_malformed_json_and_blob_hash_mismatch_are_not_retried_upstream(self):
        blob = b'synthetic-package'
        mismatch = json.dumps({'type': 'file', 'path': 'package.json', 'encoding': 'base64', 'size': len(blob),
                               'content': base64.b64encode(blob).decode(), 'sha': '0' * 40}).encode()
        for body, error in [(b'{', json.JSONDecodeError), (mismatch, M.Refused)]:
            context, _ = self.remote(body, str(len(body))); opener = types.SimpleNamespace(open=Mock(return_value=context))
            with self.subTest(error=error.__name__), patch.object(M.urllib.request, 'build_opener', return_value=opener), self.assertRaises(error):
                M.source_bytes('package.json', '1' * 40)
            self.assertEqual(opener.open.call_count, 1)

    def test_complete_source_identity_failure_does_not_retry_or_run_candidate_code(self):
        _, candidate, binding, _, _ = fixtures()
        body = json.dumps({'sha': '0' * 40, 'tree': {'sha': binding['sourceTree']}}).encode()
        context, _ = self.remote(body, str(len(body))); opener = types.SimpleNamespace(open=Mock(return_value=context)); command = Mock()
        with patch.object(M.urllib.request, 'build_opener', return_value=opener), patch.object(M, 'candidate_ci'), patch.object(M, 'D', types.SimpleNamespace(command=command)), \
             self.assertRaisesRegex(M.Refused, '^COMMUNITY_COMPOSE_COMMITTED_TREE_MISMATCH$'):
            M.source_permit(binding, candidate)
        self.assertEqual(opener.open.call_count, 1); command.assert_not_called()


class CandidateCiTests(unittest.TestCase):
    def records(self):
        _, _, b, _, _ = fixtures()
        run = {'id': b['ciRunId'], 'head_sha': b['sourceHead'], 'head_branch': 'main', 'event': 'push',
               'path': '.github/workflows/ci.yml', 'repository': {'full_name': 'Eysn0130/cisme-wechat-miniapp'},
               'status': 'completed', 'conclusion': 'failure'}
        job = {'id': b['ciVerifyJobId'], 'run_id': b['ciRunId'], 'head_sha': b['sourceHead'],
               'name': 'verify', 'status': 'completed', 'conclusion': 'success'}
        return b, {'object': {'sha': b['sourceHead']}}, {'workflow_runs': [run]}, {'total_count': 1, 'jobs': [job]}

    def check(self, records):
        b, *bodies = records
        request = Mock(side_effect=[json.dumps(body).encode() for body in bodies])
        with patch.object(M, 'response', request): M.candidate_ci(b)
        self.assertEqual(request.call_count, 3)
        for args in request.call_args_list:
            self.assertTrue(args.args[0].startswith('https://api.github.com/repos/Eysn0130/cisme-wechat-miniapp/'))
        self.assertIn('filter=latest', request.call_args.args[0])

    def test_exact_main_latest_push_successful_verify_is_scoped_not_full_visual_acceptance(self):
        # An unrelated incomplete40-route design gate does not fabricate a
        # product PASS and does not erase an exact successful verify job.
        self.check(self.records())

    def test_wrong_main_branch_event_repository_run_or_unfinished_newer_run_refused(self):
        for change in ('main', 'branch', 'event', 'repo', 'path', 'head', 'id', 'unfinished', 'newer'):
            values = self.records(); b, main, runs, _ = values; run = runs['workflow_runs'][0]
            if change == 'main': main['object']['sha'] = 'f' * 40
            elif change == 'branch': run['head_branch'] = 'other'
            elif change == 'event': run['event'] = 'pull_request'
            elif change == 'repo': run['repository']['full_name'] = 'foreign/repo'
            elif change == 'path': run['path'] = '.github/workflows/other.yml'
            elif change == 'head': run['head_sha'] = 'f' * 40
            elif change == 'id': run['id'] += 1
            elif change == 'unfinished': run['status'] = 'in_progress'
            else: runs['workflow_runs'].append({**run, 'id': run['id'] + 1, 'status': 'in_progress'})
            with self.subTest(change=change), self.assertRaises(M.Refused): self.check(values)

    def test_wrong_or_incomplete_job_list_and_skipped_verify_are_refused(self):
        for change in ('id', 'run', 'head', 'name', 'failed', 'skipped', 'unfinished', 'duplicate', 'truncated', 'oversized'):
            values = self.records(); jobs = values[-1]; job = jobs['jobs'][0]
            if change == 'id': job['id'] += 1
            elif change == 'run': job['run_id'] += 1
            elif change == 'head': job['head_sha'] = 'f' * 40
            elif change == 'name': job['name'] = 'candidate-design-qa'
            elif change == 'failed': job['conclusion'] = 'failure'
            elif change == 'skipped': job['conclusion'] = 'skipped'
            elif change == 'unfinished': job['status'] = 'in_progress'
            elif change == 'duplicate': jobs['jobs'].append(dict(job)); jobs['total_count'] = 2
            elif change == 'truncated': jobs['total_count'] = 2
            else: jobs['total_count'] = 101
            with self.subTest(change=change), self.assertRaises(M.Refused): self.check(values)

    def test_source_validation_stops_before_candidate_execution_when_ci_refuses(self):
        _, candidate, b, _, _ = fixtures(); command = Mock()
        with patch.object(M, 'D', types.SimpleNamespace(command=command)), patch.object(M, 'response') as request, \
             patch.object(M, 'candidate_ci', side_effect=M.Refused('COMMUNITY_COMPOSE_EXACT_VERIFY_JOB_REQUIRED')), self.assertRaises(M.Refused):
            M.source_permit(b, candidate)
        command.assert_not_called(); request.assert_not_called()


class ArtifactTests(unittest.TestCase):
    def test_pins_the_deployed104_helper_and_only_a_distinct_bound104_candidate(self):
        old, candidate, b, helper, _ = fixtures()
        self.assertEqual(M.BASELINE_HEAD, '6123a594cd673d8c72935e79d380320addcd127f')
        self.assertEqual(M.BASELINE_TREE, '87483c74161100d4bdb37bcdc19d620503da13f9')
        self.assertEqual(M.BASELINE_HELPER_SHA, M.sha((HERE / 'trial-support-closure-update.py').read_bytes()))
        with patch.object(M, '__file__', str(RUNNER)), patch.object(M, 'read', return_value=helper):
            self.assertEqual(M.validate_binding(b), b)
        M.artifact_contract(old, candidate, b)
        for change in [{'migrations': 103}, {'migrations': 104}, {'migrations': True}, {'sourceHead': M.BASELINE_HEAD}, {'applicationRollbackAllowed': True},
                       {'archivePath': '/tmp/archive.tar.gz'}, {'archiveBytes': True}, {'helperSha256': '0' * 64},
                       {'ciRunId': True}, {'ciRunId': 0}, {'ciVerifyJobId': True}, {'ciVerifyJobId': 0}]:
            with self.subTest(change=change), patch.object(M, '__file__', str(RUNNER)), patch.object(M, 'read', return_value=helper), self.assertRaises(M.Refused):
                M.validate_binding({**b, **change})

    def test_all104_sql_and_migrator_package_lock_dependency_bytes_stay_exact(self):
        old, candidate, b, _, _ = fixtures()
        self.assertEqual(len(old['files']), 107)
        for name in old['files']:
            changed = copy.deepcopy(candidate); changed['files'][name] += b'drift'
            with self.subTest(name=name), self.assertRaises(M.Refused): M.artifact_contract(old, changed, b)
        for change in ('sql-set', 'sql-binding', 'deps', 'platform', 'production-path'):
            changed, bound = copy.deepcopy(candidate), copy.deepcopy(b)
            if change == 'sql-set': changed['manifest']['migrations'].pop()
            elif change == 'sql-binding': bound['migrationSha256'][old['manifest']['migrations'][-1]] = '0' * 64
            elif change == 'deps': changed['dependenciesSha256'] = '0' * 64
            elif change == 'platform': changed['manifest']['buildPlatform']['os'] = 'darwin'
            else: changed['directory'] = '/opt/cisme/releases/tencent-release-' + '1' * 12
            with self.subTest(change=change), self.assertRaises(M.Refused): M.artifact_contract(old, changed, bound)

    def test_committed_tree_pins_helper_and_all_sql_before_verify_only(self):
        _, candidate, b, helper, _ = fixtures()
        files = {M.HELPER_SOURCE: helper, 'scripts/release-migrate.mjs': candidate['files']['migrate.mjs'],
                 **{p: raw for p, raw in candidate['files'].items() if p.startswith('db/migrations/')}}
        tree = {'sha': b['sourceTree'], 'truncated': False, 'tree': [{'path': p, 'type': 'blob', 'mode': '100644', 'sha': M.git_blob(raw)} for p, raw in files.items()]}
        commit = {'sha': b['sourceHead'], 'tree': {'sha': b['sourceTree']}}
        command = Mock(return_value=json.dumps({'verified': True, 'sourceHead': b['sourceHead'], 'sourceTree': b['sourceTree'], 'migrations': 105}).encode())
        def run(value):
            with patch.object(M, 'candidate_ci'), patch.object(M, 'response', side_effect=[json.dumps(commit).encode(), json.dumps(value).encode()]), patch.object(M, 'read', return_value=helper), \
                 patch.object(M, 'D', types.SimpleNamespace(command=command)), patch.object(M, 'source_bytes', side_effect=lambda p, head: fixture_source(p)):
                M.source_permit(b, candidate)
        run(tree); command.assert_called_once_with([M.NODE, candidate['directory'] + '/migrate.mjs', 'verify']); command.reset_mock()
        for change in ('truncated', 'missing', 'sql', 'symlink'):
            value = copy.deepcopy(tree)
            if change == 'truncated': value['truncated'] = True
            elif change == 'missing': value['tree'].pop(0)
            elif change == 'sql': value['tree'][-1]['sha'] = '0' * 40
            else: value['tree'][0]['mode'] = '120000'
            with self.subTest(change=change), self.assertRaises(M.Refused): run(value)
        command.assert_not_called()

    def test_exact_runner_binding_private_reader_and_no_secret_source_path(self):
        _, _, b, helper, _ = fixtures(); raw = json.dumps(b).encode()
        with patch.object(M, '__file__', str(RUNNER)), patch.object(M, 'read', side_effect=lambda p, limit: helper if p.name == RUNNER.name else raw):
            self.assertEqual(M.binding(RUNNER.parent / 'application-binding.json', M.sha(raw)), b)
            with self.assertRaises(M.Refused): M.binding(M.ROOT / 'application-binding.json', M.sha(raw))
        with patch.object(M, 'response') as request, self.assertRaises(M.Refused): M.source_bytes('runtime.env', '1' * 40)
        request.assert_not_called()
        with tempfile.TemporaryDirectory(dir=REPO / 'tmp') as directory, patch.object(M, 'OWNER', os.getuid()):
            root = Path(directory); root.chmod(0o700); p = root / 'private'; p.write_bytes(b'synthetic'); p.chmod(0o600)
            original = Path.lstat
            def parents(path):
                info = original(path)
                if path in p.parents:
                    fields = list(info); fields[4] = os.getuid(); return os.stat_result(fields)
                return info
            with patch.object(Path, 'lstat', parents):
                self.assertEqual(M.read(p), b'synthetic'); p.chmod(0o640)
                with self.assertRaises(M.Refused): M.read(p)
                p.chmod(0o600); (root / 'link').symlink_to(p)
                with self.assertRaises(OSError): M.read(root / 'link')
                os.link(p, root / 'hard')
                with self.assertRaises(M.Refused): M.read(p)


class BaselineTests(unittest.TestCase):
    def test_preflight_is_read_only_and_uses_the_exact_current_profile_env_and_both_native_gates(self):
        old, candidate, b, _, archive = fixtures()
        config = {'APP_ENV': 'staging', 'WECHAT_APP_ID': 'synthetic-app', 'SUPPORT_AI_ENABLED': 'true',
            'DEEPSEEK_API_KEY': 'synthetic-private-key', 'DEEPSEEK_MODEL': 'deepseek-flash', 'SUPPORT_AI_TIMEOUT_MS': '4000'}
        env = b'# unchanged private bytes\r\nSUPPORT_AI_ENABLED=true\r\n'
        history = {str(M.ROOT / name): b'{"ownershipId":"synthetic"}' for name in M.HISTORY_ROOT}
        d = types.SimpleNamespace(artifact=lambda p, root: old if p == old['directory'] else candidate,
            closed_context=lambda *a: True, read_owned=lambda p, **kw: env if p.name == 'runtime.env' else b'existing-unit',
            unit_path=lambda u: Path('/etc/systemd/system') / u, dropin_inputs=lambda u: {'files': {}}, unit_definition=lambda *a: {'original': True},
            native_smoke=Mock(return_value={'native': 'exact'}), environment_metadata=lambda p: {'mode': 0o640}, private_inputs=lambda *a: {'original': True},
            command=Mock(side_effect=AssertionError('preflight mutation command')), general=types.SimpleNamespace(store=Mock()))
        c = types.SimpleNamespace(APP_ID='synthetic-app', fixed_profile=Mock(), production_capture=lambda: {'config': {}}, six_keys=Mock())
        with patch.object(M, 'D', d), patch.object(M, 'C', c), patch.object(M, 'load_baseline', return_value=({'profile': PROFILE, 'config': config, 'release': Path(old['directory'])}, {})) as loader, \
             patch.object(M, 'optional_active', return_value=None), patch.object(M, 'read', return_value=archive), patch.object(M, 'source_permit'), \
             patch.object(M, 'capture_history', return_value=history), patch.object(M, 'protected_baseline_inputs', return_value={}), \
             patch.object(M, 'verify_context'), patch.object(M, 'journal'), patch.object(M, 'ugc_guards', return_value={'original': True}), \
             patch.object(M, 'S', types.SimpleNamespace(snapshot=Mock(side_effect=AssertionError('preflight snapshot')))), patch.object(Path, 'mkdir', side_effect=AssertionError('preflight mkdir')):
            value = M.preflight(b)
        loader.assert_called_once_with(True); self.assertEqual(value['profile'], PROFILE); self.assertEqual(value['config'], config); self.assertEqual(value['env'], env)
        self.assertEqual(d.native_smoke.call_args_list[0].args, (PROFILE, candidate['directory'], True))
        self.assertEqual(d.native_smoke.call_args_list[1].args, (PROFILE, old['directory'], True))
        d.command.assert_not_called(); d.general.store.assert_not_called()

    def test_active_recheck_binds_saved_full_fence_and_allows_later_production_restart_only(self):
        old, candidate, b, _, _ = fixtures(); state = M.STATE_PARENT / ('commit-' + b['sourceHead'][:12] + '-123')
        facts = {'schema_migration': {'count': 104, 'sha256': 'e' * 64}}
        plan = {'binding': b, 'old': old, 'candidate': candidate, 'profile': PROFILE, 'config': {}, 'ownership': {'ownershipId': 'synthetic'}, 'drainedBusinessFence': facts, 'snapshotBindingSha256': 'c' * 64}
        saved = b'{}'; raw = M.active_record(plan, state, M.sha(saved)); fence = (json.dumps(facts, sort_keys=True) + '\n').encode()
        d = types.SimpleNamespace(artifact=lambda p, root: old if p == old['directory'] else candidate, unit_path=lambda u: Path('/synthetic') / u,
            read_owned=lambda *a: b'unit', unit_entry=lambda *a: Path(candidate['directory']), running=Mock())
        def run(fence_bytes):
            def reader(p, limit): return raw if p == M.ACTIVE else fence_bytes if p.name == 'drained-business-fence.json' else saved
            with patch.object(M, 'D', d), patch.object(M, 'C', types.SimpleNamespace(decode_private=lambda p: plan)), patch.object(M, 'validate_binding'), \
                 patch.object(M, 'load_baseline') as loader, patch.object(M, 'target'), patch.object(M, 'read', side_effect=reader), \
                 patch.object(M, 'source_permit', side_effect=AssertionError('active must not re-run source/main/CI gate')), patch.object(M, 'verify_context') as context, patch.object(M, 'journal') as journal, patch.object(M, 'public_contract') as public, patch.object(M, 'verify_snapshot') as snapshot:
                result = M.active_context(b)
            loader.assert_called_once_with(False); context.assert_called_once_with(plan, candidate_allowed=True, allowed=(raw,), exact_pids=False)
            journal.assert_called_once_with(plan, [candidate['manifest']['migrations']]); snapshot.assert_called_once_with(plan, state); public.assert_called_once_with(plan); return result
        self.assertEqual(run(fence)['release'], Path(candidate['directory']))
        with self.assertRaisesRegex(M.Refused, 'ACTIVE_DRAINED_FACT_FENCE_DRIFT'): run(b'{}')

    def test_public_contract_only_delegates_the_pinned_reviewed_get_probe(self):
        check = Mock(); plan = {'profile': PROFILE}
        with patch.object(M, 'H', types.SimpleNamespace(public_contract=check)): M.public_contract(plan)
        check.assert_called_once_with(plan)

    def test_target_refuses_any_changed_instance_fact_or_non_root_without_accessing_a_server(self):
        for name in M.IMDS:
            actual = {**M.IMDS, name: 'foreign'}
            with self.subTest(name=name), patch.object(M.os, 'geteuid', return_value=0), patch.object(M, 'D', None), \
                 patch.object(M, 'response', side_effect=lambda url, limit: actual[url.rsplit('/', 1)[-1]].encode()), self.assertRaises(M.Refused): M.target()
        with patch.object(M.os, 'geteuid', return_value=1), patch.object(M, 'response') as request, self.assertRaises(M.Refused): M.target()
        request.assert_not_called()

    def test_active104_guard_before_cutover_primitives_only_afterwards(self):
        values = {'sourceHead': M.BASELINE_HEAD, 'sourceTree': M.BASELINE_TREE, 'manifestSha256': M.BASELINE_MANIFEST, 'migrations': 104}
        raw = ("from pathlib import Path\nC=object()\nD=object()\ncalled=[]\ndef binding(path, expected):\n called.append('binding')\n return " + repr(values) +
            "\ndef active_context(b):\n called.append('active104')\n return {'release':Path('" + str(M.ROOT / 'releases' / ('tencent-release-' + M.BASELINE_HEAD[:12])) +
            "')}\ndef load_baseline(value):\n called.append(('primitives',value))\n").encode()
        with patch.object(M, 'target'), patch.object(M, 'read', return_value=raw), patch.object(M, 'BASELINE_HELPER_SHA', M.sha(raw)), patch.object(M, 'load_upgrade_primitives') as primitives:
            M.load_baseline(True); self.assertEqual(M.H.called, ['binding', 'active104']); self.assertIs(M.C, M.H.C); self.assertIs(M.D, M.H.D)
            M.load_baseline(False); self.assertEqual(M.H.called, ['binding', ('primitives', False)])
            self.assertEqual(primitives.call_count, 2)

    def test_full_original_private_key_chain_is_preserved_and_current_layer_added(self):
        b, history, prior, private, h, helper, binding = inherited_fixture(); before = copy.deepcopy(prior)
        with patch.object(M, 'H', h), patch.object(M, 'C', types.SimpleNamespace(decode_private=lambda p: prior)), \
             patch.object(M, 'BASELINE_HELPER_SHA', M.sha(helper)), patch.object(M, 'BASELINE_BINDING_SHA', M.sha(binding)), \
             patch.object(M, 'read', side_effect=lambda p, limit: private[str(p)]):
            result = M.protected_baseline_inputs(b, history)
        self.assertEqual(prior, before); self.assertEqual(len(result), len(prior['protectedBaselineInputs']) + 3)
        for p, value in prior['protectedBaselineInputs'].items(): self.assertEqual(result[p], value)
        self.assertIn('/root/private/synthetic-original-deepseek-key', result)

    def test_key_plan_binding_history_and_recaptured_helper_drift_fail_closed(self):
        for change in ('key', 'plan', 'binding', 'history', 'missing-chain', 'helper', 'invalid-limit'):
            b, history, prior, private, h, helper, binding = inherited_fixture(); key = h.B.binding.return_value['deepseekKeyFile']
            if change == 'key': private[key] += b'drift'
            elif change == 'plan': history[str(h.ACTIVE)] = json.dumps({'upgradeState': '/tmp/foreign', 'privatePlanSha256': '0' * 64}).encode()
            elif change == 'binding': prior['binding'] = {}
            elif change == 'history': history[str(M.ROOT / 'ownership.json')] = b'drift'
            elif change == 'missing-chain': prior['protectedBaselineInputs'] = {}
            elif change == 'helper': private[str(M.BASELINE_RUNNER / 'trial-support-closure-update.py')] += b'drift'
            else: prior['protectedBaselineInputs'][key]['limit'] = True
            with self.subTest(change=change), patch.object(M, 'H', h), patch.object(M, 'C', types.SimpleNamespace(decode_private=lambda p: prior)), \
                 patch.object(M, 'BASELINE_HELPER_SHA', M.sha(helper)), patch.object(M, 'BASELINE_BINDING_SHA', M.sha(binding)), \
                 patch.object(M, 'read', side_effect=lambda p, limit: private[str(p)]), self.assertRaises(M.Refused):
                M.protected_baseline_inputs(b, history)

    def test_journal_keeps_schema101_103_and104_at_both104_and105_counts(self):
        old, candidate, _, _, _ = fixtures(); plan = {'old': old, 'candidate': candidate, 'profile': PROFILE, 'config': {}, 'ownership': {}, 'ugcGuardBaseline': {'baseline': True}}
        for upgraded, sql in ((False, old['manifest']['migrations']), (True, candidate['manifest']['migrations'])):
            c = types.SimpleNamespace(database_guard=Mock(return_value=sql)); s = types.SimpleNamespace(schema101=Mock())
            k = types.SimpleNamespace(schema104=Mock(), B=types.SimpleNamespace(schema103=Mock()))
            with patch.multiple(M, C=c, S=s, K=k), patch.object(M, 'ugc_guards') as guard:
                self.assertEqual(M.journal(plan, [sql], True), sql)
            c.database_guard.assert_called_once_with(PROFILE, {}, {}, [sql], True)
            s.schema101.assert_called_once_with(PROFILE); k.B.schema103.assert_called_once_with(PROFILE); k.schema104.assert_called_once_with(PROFILE, True)
            guard.assert_called_once_with(PROFILE, upgraded, plan['ugcGuardBaseline'])

    def test_stopped_fence_contains_every104_column_and_entire_migration_journal(self):
        names = ['schema_migration', 'support_conversation', 'support_message']
        facts = {p: {'count': 1, 'sha256': 'a' * 64} for p in names}; query = Mock(side_effect=[names, facts])
        with patch.object(M, 'D', types.SimpleNamespace(query=query)): self.assertEqual(M.business_fence(PROFILE), facts)
        sql = query.call_args.args[1]; self.assertIn('to_jsonb(t)', sql); self.assertIn('schema_migration t', sql)
        self.assertNotIn('-ARRAY', sql); self.assertNotIn("-'reply_to_message_id'", sql)
        self.assertEqual(sql.count("WHERE version<>'" + M.MIGRATION + "'"), 1)
        for bad in ([], ['support_message'], ['schema_migration', 'bad;select']):
            with patch.object(M, 'D', types.SimpleNamespace(query=Mock(return_value=bad))), self.assertRaises(M.Refused): M.business_fence(PROFILE)

    def test_exact_context_requires_original_production_pids_six_keys_archive_and_closed_trial(self):
        old, candidate, b, _, archive = fixtures()
        plan = {'profile': PROFILE, 'production': {'config': {}}, 'config': {'APP_ENV': 'staging'}, 'old': old, 'candidate': candidate, 'binding': b}
        c = types.SimpleNamespace(fixed_profile=Mock(), production_preserved=Mock(), six_keys=Mock())
        d = types.SimpleNamespace(verify_context=Mock(), closed_context=Mock(return_value=True), artifact=lambda p, root: old if p == old['directory'] else candidate)
        with patch.object(M, 'C', c), patch.object(M, 'D', d), patch.object(M, 'target'), patch.object(M, 'verify_history'), patch.object(M, 'read', return_value=archive): M.verify_context(plan)
        c.production_preserved.assert_called_once_with(plan['production'], True); c.six_keys.assert_called_once_with(plan['config'], plan['production']['config'])
        with patch.object(M, 'C', c), patch.object(M, 'D', d), patch.object(M, 'target'), patch.object(M, 'verify_history'), patch.object(M, 'read', return_value=b'drift'), self.assertRaises(M.Refused): M.verify_context(plan)


class CutoverTests(unittest.TestCase):
    def exercise(self, failure=None):
        old, candidate, b, _, _ = fixtures()
        plan = {'profile': PROFILE, 'old': old, 'candidate': candidate, 'binding': b, 'ownership': {'ownershipId': 'synthetic'}, 'env': b'original-private', 'config': {}}
        original = copy.deepcopy(plan); events, records = [], {}; switched = migrated = False
        def hit(name):
            events.append(name)
            if failure == name:
                if name in ('backup', 'context-old', 'journal', 'source'): raise M.Refused('COMMUNITY_COMPOSE_PRE_STOP_SYNTHETIC')
                raise RuntimeError('synthetic-private-error')
        def command(args, **kw):
            nonlocal migrated
            if args[0] == 'systemctl':
                self.assertEqual(tuple(args[2:]), PROFILE['units']); hit(args[1]); return b''
            self.assertEqual(args, ['/usr/sbin/runuser', '-u', 'cisme-trial', '--', M.NODE, candidate['directory'] + '/migrate.mjs', 'up'])
            self.assertEqual(kw, {'env': {**M.CLEAN, 'CISME_MIGRATION_APPROVAL_REF': 'SYNTHETIC-ONLY', 'CISME_PREDEPLOY_BACKUP_REF': 'TRIAL-SNAPSHOT-synthetic'}, 'cwd': M.ROOT, 'timeout': 180})
            hit('migrate'); migrated = True; return b''
        def switch(p, directory):
            nonlocal switched
            self.assertEqual(directory, candidate['directory']); switched = True; hit('switch-new')
        def context(*a, **kw): hit('context-new' if switched else 'context-old')
        def store(path, raw): hit('deployed' if path.name == 'deployed.json' else 'store'); records[str(path)] = raw
        facts = {'schema_migration': {'count': 104, 'sha256': 'f' * 64}}
        def fence(p):
            hit('fence-after' if switched else 'fence-migrated' if migrated else 'fence-before')
            return {} if failure == 'fact-drift' and migrated else facts
        d = types.SimpleNamespace(command=command, stopped=lambda p: hit('stopped'), switch=switch, verify_units=lambda *a, **kw: hit('units'),
            healthy=lambda *a: (hit('healthy'), {'native': 'exact'})[1], atomic_bytes=lambda p, raw: (hit('publish'), records.__setitem__(str(p), raw)), general=types.SimpleNamespace(store=store))
        def protect(value, state):
            self.assertEqual(value['drainedBusinessFence'], facts); self.assertEqual(value['operationReference'], 'SYNTHETIC-ONLY')
            self.assertEqual(len(value['snapshotBindingSha256']), 64); hit('protect'); return 'b' * 64
        def journal(p, allowed, drain=False):
            self.assertEqual(allowed, [candidate['manifest']['migrations'] if migrated else old['manifest']['migrations']])
            hit('drain' if drain else 'journal')
        s = types.SimpleNamespace(BASELINE_HEAD='historical-aad-only',
            snapshot=lambda *args: (hit('snapshot'), {'backupReference': 'TRIAL-SNAPSHOT-synthetic'})[1],
            validate_snapshot=lambda *args: hit('validate-snapshot'))
        with patch.object(M, 'D', d), patch.object(M, 'save_plan', side_effect=protect), patch.object(M, 'backup_inputs', side_effect=lambda *a: hit('backup')), \
             patch.object(M, 'source_permit', side_effect=lambda *a: hit('source')), patch.object(M, 'verify_context', side_effect=context), patch.object(M, 'verify_history', side_effect=lambda *a: hit('history')), \
             patch.object(M, 'journal', side_effect=journal), patch.object(M, 'business_fence', side_effect=fence), patch.object(M, 'S', s), \
             patch.object(M, 'read', return_value=b'protected-snapshot-receipt'), patch.object(M, 'public_contract', side_effect=lambda *a: hit('public')):
            try: result = M.cutover(plan, M.STATE_PARENT / 'commit-synthetic-123', 'SYNTHETIC-ONLY')
            except M.Refused as error: result = str(error)
        self.assertEqual(plan, original)
        self.assertFalse(any('runtime.env' in p or 'collaboration-updates' in p for p in records))
        return events, records, result

    def test_only_two_trial_units_switch_after_full_drained_fact_fence(self):
        events, records, result = self.exercise()
        self.assertTrue(result['deployed']); self.assertTrue(result['drainedFull104FactsPreserved'])
        self.assertLess(events.index('stop'), events.index('drain')); self.assertLess(events.index('drain'), events.index('fence-before'))
        self.assertLess(events.index('fence-before'), events.index('snapshot')); self.assertLess(events.index('validate-snapshot'), events.index('migrate'))
        self.assertLess(events.index('migrate'), events.index('fence-migrated')); self.assertLess(events.index('fence-migrated'), events.index('switch-new')); self.assertLess(events.index('fence-after'), events.index('start'))
        self.assertLess(events.index('source'), events.index('stop'))
        active = json.loads(records[str(M.ACTIVE)]); self.assertEqual(active['migrationCount'], 105); self.assertTrue(active['schemaChanged'])
        self.assertEqual(active['drainedBusinessFenceSha256'], M.sha(records[str(M.STATE_PARENT / 'commit-synthetic-123' / 'drained-business-fence.json')]))
        snapshot = next(json.loads(raw) for path, raw in records.items() if path.endswith('snapshot-current-release.json'))
        self.assertEqual(snapshot['actualBaselineHead'], M.BASELINE_HEAD); self.assertEqual(snapshot['actualMigrationCount'], 104)
        self.assertFalse(snapshot['aadClaimsCurrentBaseline']); self.assertEqual(snapshot['cryptoAadBaselineLabel'], 'historical-aad-only')
        self.assertTrue(result['snapshotAuthenticated']); self.assertTrue(result['databaseSnapshotCreated'])
        for flag in ('databaseRestored', 'configurationChanged', 'credentialsChanged', 'authorityGranted', 'businessDataSeeded', 'productionChanged', 'applicationRollbackExecuted'):
            self.assertIs(result[flag], False)
        self.assertEqual(events.count('start'), 1); self.assertEqual(result['liveChatProbePerformed'], False)

    def test_every_cutover_failure_fences_services_and_preserves_for_manual_review(self):
        for failure in ('stop', 'drain', 'fence-before', 'snapshot', 'validate-snapshot', 'protect', 'migrate', 'fence-migrated', 'switch-new', 'units', 'history', 'fence-after', 'fact-drift', 'start', 'healthy', 'public', 'context-new', 'publish', 'deployed'):
            with self.subTest(failure=failure):
                events, records, result = self.exercise(failure)
                self.assertEqual(result, 'COMMUNITY_COMPOSE_FAILED_FENCED_FORWARD_REVIEW_REQUIRED')
                recovery = next(json.loads(raw) for p, raw in records.items() if p.endswith('manual-recovery-required.json'))
                self.assertTrue(recovery['forwardRecoveryRequired']); self.assertFalse(recovery['databaseRestored']); self.assertFalse(recovery['applicationRollbackExecuted'])
                self.assertLessEqual(events.count('start'), 1); self.assertNotIn('synthetic-private', json.dumps(recovery))
                if failure in ('snapshot', 'validate-snapshot', 'migrate', 'fence-migrated', 'fact-drift'):
                    self.assertNotIn('switch-new', events); self.assertNotIn('start', events)

    def test_pre_stop_backup_context_and_journal_refusals_leave_running_old_services_alone(self):
        for failure in ('backup', 'context-old', 'journal', 'source'):
            with self.subTest(failure=failure):
                events, records, result = self.exercise(failure)
                self.assertEqual(result, 'COMMUNITY_COMPOSE_PRE_STOP_SYNTHETIC')
                self.assertNotIn('stop', events); self.assertNotIn('stopped', events); self.assertNotIn('start', events)
                self.assertFalse(any(p.endswith('manual-recovery-required.json') for p in records))

    def test_failed_initial_stop_still_attempts_a_fence_and_records_unconfirmed_shutdown(self):
        events, records, result = self.exercise('stop')
        self.assertEqual(result, 'COMMUNITY_COMPOSE_FAILED_FENCED_FORWARD_REVIEW_REQUIRED')
        self.assertEqual(events.count('stop'), 2); self.assertNotIn('start', events)
        recovery = next(json.loads(raw) for p, raw in records.items() if p.endswith('manual-recovery-required.json'))
        self.assertFalse(recovery['servicesStopped']); self.assertTrue(recovery['forwardRecoveryRequired'])

    def test_safe_default_cli_and_errors_never_export_secrets_or_apply(self):
        self.assertEqual(M.safe_error_code(RuntimeError('synthetic-private')), 'COMMUNITY_COMPOSE_REVIEW_REQUIRED')
        self.assertEqual(M.safe_error_code(M.Refused('COMMUNITY_COMPOSE_EXPECTED')), 'COMMUNITY_COMPOSE_EXPECTED')
        with patch.object(M.sys, 'argv', ['helper', '--binding', '/synthetic/binding.json', '--binding-sha256', 'f' * 64]), \
             patch.object(M, 'binding', return_value={}), patch.object(M, 'preflight', side_effect=RuntimeError('synthetic-private')), patch.object(M, 'apply') as apply, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(M.main(), 1)
        apply.assert_not_called(); self.assertNotIn('synthetic-private', output.getvalue())

    def test_source_only_uses_pinned_snapshot_and_candidate_up_without_restore_config_rewrite_or_chat_probe(self):
        source = (HERE / 'trial-community-compose-update.py').read_text()
        for forbidden in ('SNAPSHOT_JS', 'neutral_initial_fields(', "'down'", 'pg_dump', 'pg_restore', 'psql', 'npm install', 'npm ci', 'authority_grant', 'replaySupport', 'liveChatProbePerformed\': True'):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__': unittest.main()
