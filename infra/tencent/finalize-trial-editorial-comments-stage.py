#!/usr/bin/env python3
"""Local-only exact Git/blob/archive finalizer. Does not call SSH, npm or any server."""
import argparse
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import tempfile
from types import ModuleType
import zlib

HERE=Path(__file__).resolve().parent
PROJECT=next(parent for parent in HERE.parents if (parent/'scripts/release-migrate.mjs').is_file() and (parent/'.git').exists())
TEMPLATE_SHA='650a04a3f27c48ca2e1633e42c4fa887c8051061eb8fb99853f332f2cc8a7be1'
RUNNER_SHA='cecc243e0b745c309f8e0b840cd517d6eb727bb0943da8ebc7e206ef073bcf4b'
HELPER_SHA='9ac3e49d41cafd634d87b70963eecdc67ae1f425b0edc47509ec8a49c2ef408e'
PACKAGE_SHA='c70b97f3ec0e6c339c5c27b0e9067549f9256287cfbfdf32f39ae46fcf54e231'
LOCK_SHA='2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
BASELINE='45091a1259c2731eda21db7c367dff28513472bd'
DEPENDENCIES='d9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
IMAGE='sha256:43ffb442676c100df1e90d50b1d582c5af0b9dca1bdf7cbc9065dad0c5521044'
MIGRATION='202610280001_editorial_comments.sql'
COMPATIBILITY_SHA='2f23b820857ce98fcb916e6848adba796522b9a2c81333c069a50631000137ef'
MIGRATION_SHA='cd945b213a0c546d27ff2a1ef6e7d1a90a232ec25d680415d45aa7113c64f3c1'


def need(value,code='ACTUAL_ARTIFACT_BINDING_REQUIRED'):
    if not value:raise ValueError(code)


def sha(data):return hashlib.sha256(data).hexdigest()


def read_verified(path,limit,expected_sha256=None,expected_size=None):
    fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid in (0,os.geteuid()) and info.st_nlink==1
             and info.st_mode&0o022==0 and 0<info.st_size<=limit)
        need(expected_size is None or info.st_size==expected_size)
        data=bytearray()
        while chunk:=os.read(fd,min(65536,limit+1-len(data))):
            data.extend(chunk);need(len(data)<=limit)
        after=os.fstat(fd)
        need(len(data)==info.st_size and (after.st_size,after.st_mtime_ns,after.st_ctime_ns)
             ==(info.st_size,info.st_mtime_ns,info.st_ctime_ns))
        value=bytes(data);need(expected_sha256 is None or sha(value)==expected_sha256)
        return value
    finally:os.close(fd)


def git(*args):
    result=subprocess.run(['/usr/bin/git',*args],cwd=PROJECT,capture_output=True,
                          env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=15)
    need(result.returncode==0 and len(result.stdout)<=2*1024*1024,'EXACT_LOCAL_GIT_OBJECT_REQUIRED')
    return result.stdout


def source(head,path):return git('show',head+':'+path)


def render(template,fields):
    text=template.decode()
    for name,value in fields.items():
        marker=name+' = None  # FINALIZER_'+({'HELPER_B64_ZLIB':'HELPER','COMPATIBILITY_B64_ZLIB':'COMPATIBILITY'}.get(name,name))
        need(text.count(marker)==1,'REVIEWED_TEMPLATE_MARKER_REQUIRED')
        text=text.replace(marker,name+' = '+repr(value))
    return text.encode()


def check_archive(raw,module,head,tree,manifest_sha):
    module.TOP='tencent-release-'+head[:12]
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
        members=module.tar_members(archive)
        key=PurePosixPath(module.TOP+'/release-manifest.json')
        need(key in members and members[key].isreg(),'EXACT_RELEASE_MANIFEST_REQUIRED')
        manifest_raw=archive.extractfile(members[key]).read(1024*1024+1)
    need(len(manifest_raw)<=1024*1024 and sha(manifest_raw)==manifest_sha,'ACTUAL_MANIFEST_HASH_REQUIRED')
    manifest=json.loads(manifest_raw,object_pairs_hook=module.unique)
    old=git('ls-tree','-r','--name-only',BASELINE,'db/migrations').decode().splitlines()
    new=git('ls-tree','-r','--name-only',head,'db/migrations').decode().splitlines()
    need(len(old)==98 and new==old+['db/migrations/'+MIGRATION] and new[-1]=='db/migrations/'+MIGRATION,'EXACT_98_PLUS_ONLY99_GIT_REQUIRED')
    need(manifest.get('schemaVersion')==1 and manifest.get('configurationIncluded')is False
         and manifest.get('sourceHead')==head and manifest.get('sourceTree')==tree
         and manifest.get('sourceLockSha256')==LOCK_SHA and manifest.get('node')=='v24.14.0'
         and manifest.get('deployed')is False and manifest.get('releaseReady')is False
         and manifest.get('buildPlatform')=={'os':'linux','arch':'x64','libc':'glibc'}
         and manifest.get('migrations')==[Path(name).name for name in new],'EXACT_RELEASE_SOURCE_REQUIRED')
    expected=set(module.ENTRIES)|{'package.json','package-lock.json'}|set(new)
    need(set(manifest.get('hashes',{}))==expected,'EXACT_RELEASE_HASH_SET_REQUIRED')
    contents={};seen=set()
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r|gz') as archive:
        for member in archive:
            path=module.member_path(member.name);need(path in members and path not in seen,'ARCHIVE_MEMBER_DRIFT')
            original=members[path]
            need((member.name,member.type,member.size,member.linkname,member.mode)==
                 (original.name,original.type,original.size,original.linkname,original.mode),'ARCHIVE_MEMBER_DRIFT')
            seen.add(path);relative='/'.join(path.parts[1:])
            if member.isreg() and relative in expected:
                need(member.size<=20*1024*1024,'RELEASE_FILE_TOO_LARGE')
                data=archive.extractfile(member).read(20*1024*1024+1)
                need(len(data)==member.size and sha(data)==manifest['hashes'][relative],'RELEASE_FILE_HASH_MISMATCH')
                contents[relative]=data
            elif len(path.parts)>1 and path.parts[1]!='node_modules':
                need(relative in expected|{'release-manifest.json','db','db/migrations'},'UNKNOWN_RELEASE_FILE')
    need(seen==set(members) and set(contents)==expected,'INCOMPLETE_RELEASE_ARCHIVE')
    for name in old:
        need(contents[name]==source(BASELINE,name)==source(head,name),'OLD_MIGRATION_BYTES_CHANGED')
    need(contents['migrate.mjs']==source(head,'scripts/release-migrate.mjs')==source(BASELINE,'scripts/release-migrate.mjs'),
         'MIGRATOR_BYTES_CHANGED')
    need(contents['db/migrations/'+MIGRATION]==source(head,'db/migrations/'+MIGRATION) and sha(contents['db/migrations/'+MIGRATION])==MIGRATION_SHA,'SQL99_SOURCE_BYTES_CHANGED')
    package_bytes=source(head,'package.json');lock_bytes=source(head,'package-lock.json')
    need(sha(package_bytes)==PACKAGE_SHA and sha(lock_bytes)==LOCK_SHA,'PACKAGE_LOCK_CHANGED')
    package=json.loads(package_bytes)
    release={'name':'cisme-tencent-release','version':package['version'],'private':True,'type':'module',
             'engines':package['engines'],'dependencies':package['dependencies']}
    need(json.loads(contents['package.json'])==release,'RELEASE_PACKAGE_MISMATCH')
    lock=json.loads(lock_bytes);lock['name']=release['name']
    lock['packages']['']={k:v for k,v in release.items()if k not in ('private','type')}
    lock['packages']={k:v for k,v in lock['packages'].items()if not k or(k.startswith('node_modules/')and not v.get('link'))}
    need(json.loads(contents['package-lock.json'])==lock,'RELEASE_LOCK_MISMATCH')
    return manifest


def unique(pairs):
    result={}
    for key,value in pairs:
        need(key not in result,'DUPLICATE_INPUT_KEY');result[key]=value
    return result


def checked_summary(path,expected):
    raw=read_verified(path,65536,expected)
    b=json.loads(raw,object_pairs_hook=unique)
    need(b.get('schemaVersion')==1 and b.get('kind')=='trial-application-build-not-activation'
         and all(re.fullmatch(r'[a-f0-9]{40}',b.get(k,'')) and b[k]!='0'*40 for k in ('sourceHead','sourceTree'))
         and b['sourceHead']!=BASELINE,'EXACT_NEW_BUILD_SUMMARY_REQUIRED')
    need(all(re.fullmatch(r'[a-f0-9]{64}',b.get(k,''))for k in ('archiveSha256','manifestSha256'))
         and type(b.get('archiveBytes'))is int and 0<b['archiveBytes']<=512*1024**2,'ACTUAL_ARTIFACT_BINDING_REQUIRED')
    need(b.get('migrations')==99 and b.get('runtimeDependencies')=={'fastify':'5.12.6','sharp':'0.35.5'}
         and b.get('builderImage')==IMAGE and b.get('network')=='none' and b.get('hostMounts')==[]
         and all(b.get(k)is False for k in ('secretsIncluded','serverMutations','deployed','activationAllowedByBuild')),
         'ISOLATED_LINUX_BUILD_SUMMARY_REQUIRED')
    return b


def local_full_dependencies(raw,module,head,tree,manifest_sha):
    # Same safe extraction and tree digest as server. Owner substitution permits
    # local non-root validation only; no extracted code is executed.
    module.HEAD=head;module.TREE=tree;module.TOP='tencent-release-'+head[:12]
    module.RELEASE_MANIFEST_SHA256=manifest_sha;module.OWNER=os.geteuid()
    with tempfile.TemporaryDirectory(prefix='validate-comments-stage-',dir=PROJECT/'tmp')as directory:
        private=Path(directory);private.chmod(0o700)
        archive=private/'archive.tar.gz';archive.write_bytes(raw);archive.chmod(0o600)
        output=private/'output';output.mkdir(mode=0o700)
        release=module.unpack(archive,output)
        need(module.dependency_digest(release/'node_modules',required_uid=os.geteuid())==DEPENDENCIES,
             'FULL_D9F0_DEPENDENCY_TREE_REQUIRED')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-summary',required=True)
    parser.add_argument('--expected-summary-sha256',required=True)
    parser.add_argument('--ci-run-id',type=int,required=True)
    parser.add_argument('--output-dir',required=True)
    parser.add_argument('--compatibility-receipt',required=True)
    args=parser.parse_args()
    need(re.fullmatch(r'[a-f0-9]{64}',args.expected_summary_sha256 or '') and args.ci_run_id>0)
    output=Path(args.output_dir).absolute()
    need(output.parent.is_dir() and output.parent.resolve().is_relative_to((PROJECT/'tmp').resolve()) and not output.exists() and not output.is_symlink(),
         'NEW_LOCAL_OUTPUT_DIRECTORY_REQUIRED')
    b=checked_summary(Path(args.artifact_summary),args.expected_summary_sha256)
    head,tree=b['sourceHead'],b['sourceTree']
    template=read_verified(HERE/'trial-editorial-comments-stage.py',128*1024,TEMPLATE_SHA)
    runner=read_verified(HERE/'run-trial-editorial-comments-stage.py',128*1024,RUNNER_SHA)
    archive=read_verified(Path(b['archive']),512*1024*1024,b['archiveSha256'],b['archiveBytes'])
    need(git('rev-parse',head+'^{tree}').decode().strip()==tree,'EXACT_SOURCE_TREE_REQUIRED')
    helper=source(head,'infra/tencent/trial-editorial-comments-upgrade.py')
    need(sha(helper)==HELPER_SHA,'REVIEWED_COMMITTED_HELPER_REQUIRED')
    module=ModuleType('local_reviewed_trial_stager');module.__file__=str(HERE/'trial-editorial-comments-stage.py')
    exec(compile(template,module.__file__,'exec'),module.__dict__)
    check_archive(archive,module,head,tree,b['manifestSha256'])
    local_full_dependencies(archive,module,head,tree,b['manifestSha256'])
    values={'HEAD':head,'TREE':tree,'ARCHIVE_SHA256':b['archiveSha256'],
            'ARCHIVE_SIZE':b['archiveBytes'],'RELEASE_MANIFEST_SHA256':b['manifestSha256'],
            'CI_RUN_ID':args.ci_run_id,'HELPER_B64_ZLIB':base64.b64encode(zlib.compress(helper,9)).decode()}
    compatibility=read_verified(Path(args.compatibility_receipt),65536,COMPATIBILITY_SHA)
    values['COMPATIBILITY_B64_ZLIB']=base64.b64encode(zlib.compress(compatibility,9)).decode()
    final=render(template,values)
    final_runner=render(runner,{'HEAD':head,'TREE':tree})
    command={'sourceHead':head,'sourceTree':tree,'ciRunId':args.ci_run_id,'archivePath':str(Path(b['archive']).resolve()),
             'archiveSha256':b['archiveSha256'],'archiveSize':b['archiveBytes'],
             'releaseManifestSha256':b['manifestSha256'],'helperSha256':HELPER_SHA,
             'stagerPath':str(output/'root-installer-final.py'),'stagerSha256':sha(final),
             'runnerSha256':sha(final_runner),'fullDependenciesSha256':DEPENDENCIES,'migrations':99,'migrationSha256':MIGRATION_SHA,'compatibilitySha256':COMPATIBILITY_SHA,
             'artifactSummarySha256':args.expected_summary_sha256,'serverWriteExecuted':False,'deployed':False}
    output.mkdir(mode=0o700)
    for name,data in [('root-installer-final.py',final),('run-stage.py',final_runner),('stage-command.json',(json.dumps(command,sort_keys=True)+'\n').encode())]:
        fd=os.open(output/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb')as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
    print(json.dumps(command,sort_keys=True))
    return 0


if __name__=='__main__':raise SystemExit(main())
