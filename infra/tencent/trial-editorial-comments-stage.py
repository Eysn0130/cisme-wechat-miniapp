#!/usr/bin/env python3
"""Unactivated schema99 editorial-comments trial-only stager. No DB/service mutations."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import socket
import stat
import sys
import tarfile
import tempfile
import types
from types import SimpleNamespace
import urllib.request
import zlib

HEAD = None  # FINALIZER_HEAD
TREE = None  # FINALIZER_TREE
TOP = 'tencent-release-' + HEAD[:12] if isinstance(HEAD, str) else None
INSTANCE = 'lhins-61ikz4mi'
IP = '124.223.74.198'
BINDING = {'instance-id':'ins-l9utqwxv','local-ipv4':'10.0.0.10','public-ipv4':IP}
ARCHIVE_SHA256 = None  # FINALIZER_ARCHIVE_SHA256
ARCHIVE_SIZE = None  # FINALIZER_ARCHIVE_SIZE
RELEASE_MANIFEST_SHA256 = None  # FINALIZER_RELEASE_MANIFEST_SHA256
CI_RUN_ID = None  # FINALIZER_CI_RUN_ID
HELPER_B64_ZLIB = None  # FINALIZER_HELPER
COMPATIBILITY_B64_ZLIB = None  # FINALIZER_COMPATIBILITY
REVIEWED_HELPER_SHA256 = '9ac3e49d41cafd634d87b70963eecdc67ae1f425b0edc47509ec8a49c2ef408e'
DEPENDENCIES = 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
BASELINE_HEAD = '45091a1259c2731eda21db7c367dff28513472bd'
BASELINE_TREE = 'e367fb91ca0f0442226271e055bb37af8b8b38e7'
ROOT = Path('/opt/cisme-trial')
ROOTS = (ROOT,)
STAGE_BASE = Path('/var/lib/cisme-dependency-stage')
OPERATIONS = ROOT / 'editorial-comment-runners' / HEAD[:12] if isinstance(HEAD,str) else None
MAX_ARCHIVE = 512*1024*1024
MAX_EXPANDED = 1024*1024*1024
MAX_MEMBERS = 35000
OWNER = 0
ENTRIES = ('index.js','worker.js','worker-once.js','migrate.mjs')
LOCK_PERMIT = '2a14af4f1bfdd86d0108015b43df14d62b2cc6e8eedcd3831446970a26d7d32a'
MIGRATION = '202610280001_editorial_comments.sql'
MIGRATION_SHA256 = 'cd945b213a0c546d27ff2a1ef6e7d1a90a232ec25d680415d45aa7113c64f3c1'
COMPATIBILITY_SHA256 = '2f23b820857ce98fcb916e6848adba796522b9a2c81333c069a50631000137ef'

class Refused(Exception):
    pass

def need(value, code):
    if not value:
        raise Refused(code)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def unique(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, 'STAGE_DUPLICATE_JSON_KEY')
        value[key] = item
    return value

def safe_directory(path, private=False):
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER
         and info.st_mode & (0o077 if private else 0o022) == 0, 'STAGE_UNSAFE_DIRECTORY')

def safe_parents(path, include=True):
    need(path.is_absolute() and '..' not in path.parts, 'STAGE_FIXED_PATH_REQUIRED')
    for parent in reversed(path.parents):
        safe_directory(parent)
    if include:
        safe_directory(path)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Refused('STAGE_METADATA_REDIRECT_REFUSED')

def metadata(field):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open('http://metadata.tencentyun.com/latest/meta-data/' + field, timeout=3) as response:
        need(response.status == 200, 'STAGE_METADATA_RESPONSE_REQUIRED')
        data = response.read(129)
    need(len(data) <= 128, 'STAGE_METADATA_TOO_LARGE')
    return data.decode('ascii').strip()

def target():
    need(os.geteuid() == 0, 'STAGE_ROOT_REQUIRED')
    need({name: metadata(name) for name in BINDING} == BINDING
         and socket.gethostname() == 'VM-0-10-ubuntu', 'STAGE_WRONG_INSTANCE')
    # Lighthouse ID is bound to the already authenticated instance/IMDS mapping.
    # No caller-supplied identity, DNS change or historical JSON authorizes writes.
    for root in ROOTS:
        safe_parents(root / 'releases')
    safe_parents(STAGE_BASE, include=False)
    if STAGE_BASE.exists() or STAGE_BASE.is_symlink():
        safe_directory(STAGE_BASE, private=True)
    operations_parent = OPERATIONS.parent
    safe_parents(operations_parent, include=operations_parent.exists() or operations_parent.is_symlink())
    for destination in (*[root / 'releases' / TOP for root in ROOTS], OPERATIONS):
        need(not destination.exists() and not destination.is_symlink(), 'STAGE_DESTINATION_ALREADY_EXISTS')

def read_regular(path, limit=20 * 1024 * 1024, expected_sha256=None):
    # One no-follow descriptor supplies the bounded bytes later parsed/compared.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER
             and info.st_mode & 0o022 == 0 and 0 <= info.st_size <= limit,
             'STAGE_FILE_UNSAFE')
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit, 'STAGE_FILE_TOO_LARGE')
        need(len(data) == info.st_size, 'STAGE_FILE_CHANGED')
        verified = bytes(data)
        need(expected_sha256 is None or sha(verified) == expected_sha256,
             'STAGE_FILE_HASH_MISMATCH')
        return verified
    finally:
        os.close(fd)

def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)

def receive_archive(path, source):
    need(isinstance(ARCHIVE_SIZE, int) and 0 < ARCHIVE_SIZE <= MAX_ARCHIVE
         and isinstance(ARCHIVE_SHA256, str) and len(ARCHIVE_SHA256) == 64,
         'STAGE_FINAL_ARCHIVE_BINDING_REQUIRED')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    total = 0
    fingerprint = hashlib.sha256()
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            while chunk := source.read(min(1024 * 1024, ARCHIVE_SIZE + 1 - total)):
                total += len(chunk)
                need(total <= ARCHIVE_SIZE, 'STAGE_ARCHIVE_SIZE_MISMATCH')
                fingerprint.update(chunk)
                stream.write(chunk)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    need(total == ARCHIVE_SIZE and fingerprint.hexdigest() == ARCHIVE_SHA256, 'STAGE_ARCHIVE_HASH_MISMATCH')

def member_path(name):
    need(isinstance(name, str) and name and '\x00' not in name and '\\' not in name
         and not name.startswith('/') and '..' not in name.split('/'), 'STAGE_TAR_PATH_REFUSED')
    path = PurePosixPath(name)
    need(path.parts and path.parts[0] == TOP and all(part != '.' for part in name.split('/')),
         'STAGE_TAR_TOP_REQUIRED')
    return path

def tar_members(archive):
    paths = {}
    expanded = 0
    for member in archive:
        need(len(paths) < MAX_MEMBERS, 'STAGE_TAR_COUNT_REFUSED')
        path = member_path(member.name)
        need(path not in paths and (member.isdir() or member.isreg() or member.issym() or member.islnk()),
             'STAGE_TAR_TYPE_OR_DUPLICATE_REFUSED')
        paths[path] = member
        expanded += member.size
        need(0 <= member.size <= MAX_EXPANDED and expanded <= MAX_EXPANDED,
             'STAGE_TAR_EXPANDED_SIZE_REFUSED')
        if member.issym():
            need(len(path.parts) >= 3 and path.parts[1] == 'node_modules'
                 and member.linkname and '\x00' not in member.linkname and '\\' not in member.linkname
                 and not member.linkname.startswith('/'), 'STAGE_TAR_EXTERNAL_LINK_REFUSED')
            destination = posixpath.normpath(str(path.parent / member.linkname))
            need(destination == TOP + '/node_modules' or destination.startswith(TOP + '/node_modules/'),
                 'STAGE_TAR_EXTERNAL_LINK_REFUSED')
        if member.islnk():
            link = member_path(member.linkname)
            need(len(path.parts) >= 3 and path.parts[1] == 'node_modules'
                 and len(link.parts) >= 3 and link.parts[1] == 'node_modules', 'STAGE_TAR_EXTERNAL_LINK_REFUSED')
    need(paths, 'STAGE_TAR_COUNT_REFUSED')
    need(PurePosixPath(TOP) in paths and paths[PurePosixPath(TOP)].isdir(), 'STAGE_TAR_TOP_REQUIRED')
    for path, member in paths.items():
        for parent in path.parents:
            if parent in paths:
                need(paths[parent].isdir(), 'STAGE_TAR_LINK_PARENT_REFUSED')
        if member.islnk():
            link = PurePosixPath(member.linkname)
            need(link in paths and paths[link].isreg(), 'STAGE_TAR_HARDLINK_TARGET_REFUSED')
    return paths

def unpack(archive_path, output):
    # extractall is intentionally unused; do not trust tar owners, modes or links.
    with tarfile.open(archive_path, 'r:gz') as archive:
        paths = tar_members(archive)
    seen = set()
    # Prevalidate the complete tar first, then inflate once in archive order.
    # Random extractfile seeks on gzip restart inflation from its beginning.
    with tarfile.open(archive_path, 'r|gz') as archive:
        for member in archive:
            path = member_path(member.name)
            need(path in paths and path not in seen, 'STAGE_TAR_SECOND_PASS_MEMBER_REFUSED')
            original = paths[path]
            need((member.name, member.type, member.size, member.linkname, member.mode) ==
                 (original.name, original.type, original.size, original.linkname, original.mode),
                 'STAGE_TAR_SECOND_PASS_HEADER_DRIFT')
            seen.add(path)
            destination = output.joinpath(*path.parts)
            destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            if member.isdir():
                destination.mkdir(mode=0o755, exist_ok=True)
            elif member.isreg():
                fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0),
                             0o644 | (member.mode & 0o111))
                try:
                    os.fchmod(fd, 0o644 | (member.mode & 0o111))
                    source = archive.extractfile(member)
                    need(source is not None, 'STAGE_TAR_FILE_REQUIRED')
                    with source, os.fdopen(fd, 'wb', closefd=False) as stream:
                        shutil.copyfileobj(source, stream, length=1024 * 1024)
                        stream.flush()
                        need(os.fstat(fd).st_size == member.size, 'STAGE_TAR_FILE_SIZE_MISMATCH')
                finally:
                    os.close(fd)
    need(seen == set(paths), 'STAGE_TAR_SECOND_PASS_INCOMPLETE')
    for path, member in paths.items():
        destination = output.joinpath(*path.parts)
        if member.issym():
            destination.symlink_to(member.linkname)
        elif member.islnk():
            destination.hardlink_to(output.joinpath(*PurePosixPath(member.linkname).parts))
    release = output / TOP
    # Stage has umask 0077; runtime contents must retain service-readable,
    # nonwritable modes after validation, while the stage parent stays 0700.
    for parent, names, files in os.walk(release, followlinks=False):
        os.chmod(parent, 0o755)
    for path, member in paths.items():
        destination = output.joinpath(*path.parts)
        info = destination.lstat()
        need(info.st_uid == OWNER and (stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022 == 0), 'STAGE_EXTRACTED_OWNER_REFUSED')
        if member.issym():
            need(destination.resolve().is_relative_to((release / 'node_modules').resolve()),
                 'STAGE_TAR_EXTERNAL_LINK_REFUSED')
    return release

def validated_release(release, dependency_tool):
    data = read_regular(release / 'release-manifest.json', expected_sha256=RELEASE_MANIFEST_SHA256)
    manifest = json.loads(data, object_pairs_hook=unique)
    need(manifest.get('schemaVersion') == 1 and manifest.get('configurationIncluded') is False
         and manifest.get('sourceHead') == HEAD and manifest.get('sourceTree') == TREE
         and manifest.get('sourceLockSha256') == dependency_tool.LOCK_PERMIT
         and manifest.get('buildPlatform') == {'os': 'linux', 'arch': 'x64', 'libc': 'glibc'},
         'STAGE_FINAL_RELEASE_BINDING_REQUIRED')
    migrations = manifest.get('migrations')
    need(isinstance(migrations, list) and migrations and migrations == sorted(set(migrations))
         and all(isinstance(name, str) and dependency_tool.re.fullmatch(r'\d+_[A-Za-z0-9_-]+\.sql', name)
                 for name in migrations), 'STAGE_SQL_SET_REFUSED')
    expected = set(dependency_tool.ENTRIES) | {'package.json', 'package-lock.json'} | {
        'db/migrations/' + name for name in migrations}
    need(set(manifest.get('hashes', {})) == expected
         and {path.name for path in release.iterdir()} == {'node_modules', 'db', 'release-manifest.json',
                                                         'package.json', 'package-lock.json', *dependency_tool.ENTRIES}
         and {path.name for path in (release / 'db').iterdir()} == {'migrations'}
         and {path.name for path in (release / 'db/migrations').iterdir()} == set(migrations),
         'STAGE_RELEASE_CONTENT_REFUSED')
    for name in expected:
        path = release / name
        need(stat.S_ISREG(path.lstat().st_mode) and not path.is_symlink()
             and sha(read_regular(path, expected_sha256=manifest['hashes'][name])) == manifest['hashes'][name], 'STAGE_RELEASE_HASH_MISMATCH')
    fingerprint = dependency_tool.trial.dependency_digest(release / 'node_modules')
    return {'manifestSha256': sha(data), 'dependenciesSha256': fingerprint, 'migrations': len(migrations)}

require = need
checked_directory = safe_directory

def file_sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.digest()

def dependency_digest(directory, required_uid=0):
    """Bind every copied dependency; reject links escaping node_modules."""
    checked_directory(directory)
    digest = hashlib.sha256()
    count = 0
    total = 0
    for parent, names, files in os.walk(directory, followlinks=False):
        names.sort()
        for name in sorted(names + files):
            path = Path(parent) / name
            relative = path.relative_to(directory).as_posix()
            info = path.lstat()
            require(info.st_uid == required_uid and (stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022 == 0), 'TRIAL_DEPENDENCY_UNSAFE')
            if stat.S_ISLNK(info.st_mode):
                require(not Path(os.readlink(path)).is_absolute() and path.resolve().is_relative_to(directory),
                        'TRIAL_DEPENDENCY_LINK_UNSAFE')
                value = b'link:' + os.readlink(path).encode()
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                require(total <= 1024 ** 3, 'TRIAL_DEPENDENCY_SIZE_EXCEEDED')
                value = b'file:' + file_sha(path)
            else:
                require(stat.S_ISDIR(info.st_mode), 'TRIAL_DEPENDENCY_UNSAFE')
                value = b'directory'
            digest.update(relative.encode() + b'\0' + value + b'\0')
            count += 1
            require(count <= 30000, 'TRIAL_DEPENDENCY_SIZE_EXCEEDED')
    return digest.hexdigest()


def helper_payload():
    need(isinstance(HELPER_B64_ZLIB,str) and len(HELPER_B64_ZLIB)<=256*1024,'STAGE_FINAL_HELPER_BINDING_REQUIRED')
    data=zlib.decompress(base64.b64decode(HELPER_B64_ZLIB,validate=True))
    need(len(data)<=128*1024 and sha(data)==REVIEWED_HELPER_SHA256,'STAGE_REVIEWED_HELPER_REQUIRED')
    return data


def validate_release(release):
    facade=SimpleNamespace(LOCK_PERMIT=LOCK_PERMIT,ENTRIES=ENTRIES,re=re,
                           trial=SimpleNamespace(dependency_digest=dependency_digest))
    result=validated_release(release,facade)
    manifest=json.loads(read_regular(release/'release-manifest.json',expected_sha256=RELEASE_MANIFEST_SHA256),object_pairs_hook=unique)
    need(len(manifest['migrations'])==99 and manifest['migrations'][-1]==MIGRATION
         and result['dependenciesSha256']==DEPENDENCIES,'STAGE_ONLY_SCHEMA99_DEPENDENCIES_REQUIRED')
    return result


def compatibility_payload():
    need(isinstance(COMPATIBILITY_B64_ZLIB,str) and len(COMPATIBILITY_B64_ZLIB)<=128*1024,'STAGE_FINAL_COMPATIBILITY_BINDING_REQUIRED')
    data=zlib.decompress(base64.b64decode(COMPATIBILITY_B64_ZLIB,validate=True))
    need(0<len(data)<=65536 and sha(data)==COMPATIBILITY_SHA256,'STAGE_ACTUAL_COMPATIBILITY_REQUIRED')
    return data


def baseline_guard(helper, source=True):
    # Only the new reviewed helper may load the exact45091/schema98 context.
    # Its preflight/apply/active are deliberately not called by the stager.
    module=types.ModuleType('reviewed_editorial_comments_stage_guard')
    module.__file__=str(OPERATIONS/'trial-editorial-comments-upgrade.py')
    exec(compile(helper,module.__file__,'exec'),module.__dict__)
    context=module.load_primitives(True)
    profile,config=context['profile'],context['config'];module.fixed_profile(profile)
    need(config.get('APP_ENV')=='staging' and config.get('WECHAT_APP_ID')==module.APP_ID
         and module.D.closed_context(profile,config)
         and config.get('WECHAT_PHONE_BINDING_ENABLED','false')=='false'
         and config.get('COS_DIRECT_UPLOAD_ENABLED','false')=='false','STAGE_CLOSED_TRIAL_REQUIRED')
    production=module.production_capture();module.six_keys(config,production['config'])
    old=module.D.artifact(str(context['release']),ROOT)
    need(old['manifest'].get('sourceHead')==BASELINE_HEAD and old['manifest'].get('sourceTree')==BASELINE_TREE
         and old['manifestSha256']==module.BASELINE_MANIFEST and old['dependenciesSha256']==DEPENDENCIES
         and len(old['manifest']['migrations'])==98,'STAGE_45091_SCHEMA98_BASELINE_REQUIRED')
    facts=module.D.database_facts(profile)
    need(facts.get('database')==facts.get('owner')=='cisme_trial'
         and facts.get('journal')==old['manifest']['migrations'],'STAGE_SCHEMA98_DATABASE_REQUIRED')
    fence=module.article_fence(profile);need(fence.get('publishedCount')==20,'STAGE_EXISTING20_REQUIRED')
    if source:
        main=module.D.general.reviewed_main()
        need(main.get('sha')==HEAD and main.get('tree')==TREE and main.get('ciRunId')==CI_RUN_ID,'STAGE_EXACT_MAIN_PUSH_CI_REQUIRED')
    return module,old,{'profile':profile,'config':config,'production':production,'articleFence':fence}


def candidate_contract(release,guard,source=False):
    module,old,proof=guard
    manifest=json.loads(read_regular(release/'release-manifest.json',expected_sha256=RELEASE_MANIFEST_SHA256),object_pairs_hook=unique)
    candidate={'directory':str(ROOT/'releases'/TOP),'manifest':manifest,
               'manifestSha256':RELEASE_MANIFEST_SHA256,'dependenciesSha256':DEPENDENCIES,
               'files':{name:read_regular(release/name)for name in manifest['hashes']}}
    b={'sourceHead':HEAD,'sourceTree':TREE,'ciRunId':CI_RUN_ID,'manifestSha256':RELEASE_MANIFEST_SHA256}
    module.artifact_contract(old,candidate,b)
    if source:
        # verify runs against the validated extraction, before activation.
        module.source_permit(b,{**candidate,'directory':str(release)},module.D.general.reviewed_main())
    module.production_preserved(proof['production'])
    need(module.article_fence(proof['profile'])==proof['articleFence'],'STAGE_EXISTING20_ACTOR_OR_MEDIA_DRIFT')
    return candidate


def application_binding(receipt,raw):
    # Receipt is immutable and precedes its binding. There is no circular hash.
    return {'schemaVersion':1,'kind':'trial-editorial-comments-upgrade',
        'baselineHead':BASELINE_HEAD,'baselineTree':BASELINE_TREE,'sourceHead':HEAD,'sourceTree':TREE,
        'ciRunId':CI_RUN_ID,'archiveSha256':ARCHIVE_SHA256,'archiveBytes':ARCHIVE_SIZE,
        'manifestSha256':RELEASE_MANIFEST_SHA256,'stageReceipt':str(Path(receipt['privateStage'])/'stage-receipt.json'),
        'stageReceiptSha256':sha(raw),'helperSha256':REVIEWED_HELPER_SHA256,
        'dependenciesSha256':DEPENDENCIES,'migrations':99,'migrationSha256':MIGRATION_SHA256,
        'compatibilityReceipt':str(Path(receipt['privateStage'])/'rollback-compatibility.json'),
        'compatibilitySha256':COMPATIBILITY_SHA256}


def main():
    try:
        need(isinstance(HEAD,str) and re.fullmatch(r'[a-f0-9]{40}',HEAD) and HEAD!='0'*40
             and isinstance(TREE,str) and re.fullmatch(r'[a-f0-9]{40}',TREE) and TREE!='0'*40
             and HEAD!=BASELINE_HEAD and TOP=='tencent-release-'+HEAD[:12]
             and type(CI_RUN_ID)is int and CI_RUN_ID>0
             and type(ARCHIVE_SIZE)is int and 0<ARCHIVE_SIZE<=MAX_ARCHIVE
             and isinstance(ARCHIVE_SHA256,str) and re.fullmatch(r'[a-f0-9]{64}',ARCHIVE_SHA256)
             and isinstance(RELEASE_MANIFEST_SHA256,str) and re.fullmatch(r'[a-f0-9]{64}',RELEASE_MANIFEST_SHA256),
             'STAGE_FINAL_ARCHIVE_BINDING_REQUIRED')
        helper=helper_payload();compatibility=compatibility_payload()
        target()  # Root, IMDS and every protected parent are checked before writes.
        guard=baseline_guard(helper)
        os.umask(0o077)
        STAGE_BASE.mkdir(mode=0o700,exist_ok=True)
        stage=Path(tempfile.mkdtemp(prefix=HEAD[:12]+'-',dir=STAGE_BASE))
        safe_directory(stage,private=True)
        receive_archive(stage/'archive.tar.gz',sys.stdin.buffer)
        output=stage/'extracted';output.mkdir(mode=0o700)
        release=unpack(stage/'archive.tar.gz',output)
        artifact=validate_release(release)
        candidate_contract(release,guard,source=True)
        target()  # Never overwrite an unknown or partial prior destination.
        candidate_contract(release,baseline_guard(helper))
        candidate_contract(release,guard)
        destination=ROOT/'releases'/TOP
        destination.mkdir(mode=0o755);os.chmod(destination,0o755)
        shutil.copytree(release,destination,dirs_exist_ok=True,symlinks=True)
        os.chmod(destination,0o755)
        actual=validate_release(destination)
        need(actual==artifact,'STAGE_COPIED_RELEASE_DRIFT')
        OPERATIONS.parent.mkdir(mode=0o755,exist_ok=True)
        OPERATIONS.mkdir(mode=0o700)
        helper_path=OPERATIONS/'trial-editorial-comments-upgrade.py'
        private_write(helper_path,helper)
        need(read_regular(helper_path,expected_sha256=REVIEWED_HELPER_SHA256)==helper,'STAGE_INSTALLED_HELPER_DRIFT')
        private_write(stage/'rollback-compatibility.json',compatibility)
        candidate=candidate_contract(destination,guard)
        receipt={'staged':True,'deployed':False,'instanceId':INSTANCE,'publicIpv4':IP,'sourceHead':HEAD,'sourceTree':TREE,
                 'archiveSha256':ARCHIVE_SHA256,'archiveSize':ARCHIVE_SIZE,**artifact,
                 'candidateDirectories':[str(destination)],'operationsDirectory':str(OPERATIONS),
                 'helperPath':str(helper_path),'helperSha256':REVIEWED_HELPER_SHA256,'privateStage':str(stage),
                 'compatibilitySha256':COMPATIBILITY_SHA256,'migrationSha256':MIGRATION_SHA256,
                 'servicesChanged':False,'databaseChanged':False,'configurationChanged':False,
                 'productionChanged':False,'peerFilesChanged':False}
        raw=(json.dumps(receipt,sort_keys=True)+'\n').encode()
        private_write(stage/'stage-receipt.json',raw)
        b=application_binding(receipt,raw)
        guard[0].validate_binding(b);guard[0].stage_binding(b,candidate);guard[0].compatibility(b,guard[1])
        binding_raw=(json.dumps(b,sort_keys=True)+'\n').encode()
        binding_path=OPERATIONS/'application-binding.json'
        private_write(binding_path,binding_raw)
        need(read_regular(binding_path,expected_sha256=sha(binding_raw))==binding_raw,'STAGE_INSTALLED_BINDING_DRIFT')
        print(json.dumps({**receipt,'applicationBindingPath':str(binding_path),
                          'applicationBindingSha256':sha(binding_raw),'stageReceiptSha256':sha(raw)},sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'ok':False,'code':str(error) if isinstance(error,Refused) else 'STAGE_REVIEW_REQUIRED',
                          'deployed':False,'privateValuesExported':False}))
        return 1


if __name__=='__main__':raise SystemExit(main())
