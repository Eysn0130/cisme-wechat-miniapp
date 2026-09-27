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
m.SOURCE='2df301818c550ae6d19649d44f785d02fb58b276'
m.ARCHIVE_SHA='6f6cc7cb51aad235282be0bb70d1fa18ee597860a07b43facd03ae910caf155a'
def target(hostname,config,old_hash):
    db=urllib.parse.urlsplit(config.get('DATABASE_URL',''))
    m.require(hostname=='VM-4-15-ubuntu','STAGING_HOST_REQUIRED')
    m.require(config.get('APP_ENV')=='staging','STAGING_LABEL_REQUIRED')
    m.require(db.hostname=='127.0.0.1' and db.path=='/cisme_accept_rc20260922_9ac72e41' and db.username=='cisme_staging','EXACT_PREVIOUS_ISOLATED_STAGING_REQUIRED')
    m.require(config.get('OBJECT_STORAGE_DRIVER')=='api_gateway','STAGING_LOCAL_STORAGE_REQUIRED')
    m.require(old_hash=='37d3fdbe92006a42e6d3b9a037e4cec55e1f433f78d0ee404096fb57d72dfe4f','PREVIOUS_ARTIFACT_DRIFT')
    manifest=json.loads((m.CURRENT/'release-manifest.json').read_text())
    m.require(manifest.get('sourceHead')=='0f1b4c346173ed26d6ffd3d6e3612ef893b14212','PREVIOUS_SOURCE_DRIFT')
    m.require(str(m.CURRENT.resolve())=='/opt/cisme/releases/rc20260922-9ac72e41-0f1b4c346173','PREVIOUS_PATH_DRIFT')
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
