#!/usr/bin/env python3
"""Native-only management release candidate; exact previous release and fresh owned database.
No production target, previous DB mutation, credentials or live money grant.
"""
import hashlib, importlib.util, json, pathlib, sys, urllib.parse
BASE=pathlib.Path(__file__).with_name('staging-candidate.py')
if hashlib.sha256(BASE.read_bytes()).hexdigest()!='bcecc4c0ef31e2c36a149e46030be3264bf8ec556de168fb83e218f6eb8d9741':
    raise SystemExit('STAGING_BASE_SCRIPT_DRIFT')
spec=importlib.util.spec_from_file_location('staging_base',BASE)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.SOURCE='f4c8df9e5be091b246e9893b1c357bc004d943b0'
m.ARCHIVE_SHA='1a075a3792b8035f3e0bcf8ca0de532311785a6e69bccf9a16ebe4573d360d49'
def target(hostname,config,old_hash):
    db=urllib.parse.urlsplit(config.get('DATABASE_URL',''))
    m.require(hostname=='VM-4-15-ubuntu','STAGING_HOST_REQUIRED')
    m.require(config.get('APP_ENV')=='staging','STAGING_LABEL_REQUIRED')
    m.require(db.hostname=='127.0.0.1' and db.path=='/cisme_accept_rc20260922_690f9382' and db.username=='cisme_staging','EXACT_PREVIOUS_ISOLATED_STAGING_REQUIRED')
    m.require(config.get('OBJECT_STORAGE_DRIVER')=='api_gateway','STAGING_LOCAL_STORAGE_REQUIRED')
    m.require(old_hash=='f66df6b53ab324a906fab824568522d15eb868c122ee1af26ee16416c2a96ce8','PREVIOUS_ARTIFACT_DRIFT')
    manifest=json.loads((m.CURRENT/'release-manifest.json').read_text())
    m.require(manifest.get('sourceHead')=='2df301818c550ae6d19649d44f785d02fb58b276','PREVIOUS_SOURCE_DRIFT')
    m.require(str(m.CURRENT.resolve())=='/opt/cisme/releases/rc20260922-690f9382-2df301818c55','PREVIOUS_PATH_DRIFT')
m.assert_target=target
_original_verify=m.verify_files
def full_verify(directory,manifest):
    _original_verify(directory,manifest)
    result=json.loads(m.run(['node',str(directory/'migrate.mjs'),'verify'],label='FULL_ARTIFACT_VERIFICATION_FAILED',cwd=directory))
    m.require(result.get('verified') is True and result.get('sourceHead')==m.SOURCE,'FULL_ARTIFACT_REQUIRED')
m.verify_files=full_verify
if __name__=='__main__':
    try: m.main()
    except Exception as error:
        print(json.dumps({'ok':False,'code':str(error) if isinstance(error,m.Refused) else 'STAGING_DEPLOY_FAILED_REVIEW_REQUIRED'}));sys.exit(1)
