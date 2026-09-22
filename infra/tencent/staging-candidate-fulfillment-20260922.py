#!/usr/bin/env python3
"""Second staging candidate; exact previous release and fresh owned database.
No production target, previous DB mutation, credentials or live money grant.
"""
import hashlib, importlib.util, json, pathlib, sys, urllib.parse
BASE=pathlib.Path('/home/ubuntu/staging-candidate.py')
if hashlib.sha256(BASE.read_bytes()).hexdigest()!='bcecc4c0ef31e2c36a149e46030be3264bf8ec556de168fb83e218f6eb8d9741':
    raise SystemExit('STAGING_BASE_SCRIPT_DRIFT')
spec=importlib.util.spec_from_file_location('staging_base',BASE)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.SOURCE='0f1b4c346173ed26d6ffd3d6e3612ef893b14212'
m.ARCHIVE_SHA='2fa2d4167a4d03591a891fa78e75c4b7257a1b74bdc6089441417c20f95e576b'
def target(hostname,config,old_hash):
    db=urllib.parse.urlsplit(config.get('DATABASE_URL',''))
    m.require(hostname=='VM-4-15-ubuntu','STAGING_HOST_REQUIRED')
    m.require(config.get('APP_ENV')=='staging','STAGING_LABEL_REQUIRED')
    m.require(db.hostname=='127.0.0.1' and db.path=='/cisme_accept_rc20260922_8d13f6a2' and db.username=='cisme_staging','EXACT_PREVIOUS_ISOLATED_STAGING_REQUIRED')
    m.require(config.get('OBJECT_STORAGE_DRIVER')=='api_gateway','STAGING_LOCAL_STORAGE_REQUIRED')
    m.require(old_hash=='af0f835d072413add731f818b6fe9c71e93b7ff7ae6a283c992356c5e0b48cc0','PREVIOUS_ARTIFACT_DRIFT')
    manifest=json.loads((m.CURRENT/'release-manifest.json').read_text())
    m.require(manifest.get('sourceHead')=='ae31437652e2fe3fbb24e7ac493d3b60ad747d27','PREVIOUS_SOURCE_DRIFT')
    m.require(str(m.CURRENT.resolve())=='/opt/cisme/releases/rc20260922-8d13f6a2-ae31437652e2','PREVIOUS_PATH_DRIFT')
m.assert_target=target
if __name__=='__main__':
    try: m.main()
    except Exception as error:
        print(json.dumps({'ok':False,'code':str(error) if isinstance(error,m.Refused) else 'STAGING_DEPLOY_FAILED_REVIEW_REQUIRED'}));sys.exit(1)
