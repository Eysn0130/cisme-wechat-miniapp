#!/usr/bin/env python3
"""Install only four approved, content-addressed public campaign photographs.

Default is read-only. No API restart, database, credentials or member objects.
Existing nginx security headers remain inherited; only exact image URLs match.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile
import urllib.request

PROFILES = {
    'trial': ('/opt/cisme-trial', 'staging-api.cisme.cn', '/etc/nginx/sites-enabled/cisme-trial-api'),
    'release': ('/opt/cisme', 'api.cisme.cn', '/etc/nginx/sites-enabled/cisme-api'),
}
KEYS = {'brand', 'essence', 'set', 'selection'}
STATIC_ROOTS = {'trial': '/var/www/cisme-brand-trial', 'release': '/var/www/cisme-brand-release'}
MARKER = re.compile(r'^[ \t]*# CISME_HOME_CAMPAIGN_BEGIN\n[^\n]*\n[ \t]*# CISME_HOME_CAMPAIGN_END\n', re.MULTILINE)


def need(value, code):
    if not value:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode_bundle(raw):
    need(len(raw) < 1_000_000, 'BUNDLE_TOO_LARGE')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        for member in archive.getmembers():
            need(member.isfile() and not member.issym() and not member.islnk()
                 and member.name not in files and '/' not in member.name
                 and (member.name == 'manifest.json' or re.fullmatch(r'[a-f0-9]{64}\.jpg', member.name))
                 and 0 < member.size <= 200_000, 'BUNDLE_ENTRY_INVALID')
            files[member.name] = archive.extractfile(member).read()
    need('manifest.json' in files and len(files) == 5, 'FOUR_PHOTOS_REQUIRED')
    manifest = json.loads(files['manifest.json'])
    need(manifest.get('version') == 1 and manifest.get('kind') == 'owner-approved-public-home-campaign'
         and len(manifest.get('assets', [])) == 4
         and {a.get('key') for a in manifest['assets']} == KEYS, 'MANIFEST_INVALID')
    for asset in manifest['assets']:
        name = asset.get('file', '')
        need(re.fullmatch(r'[a-f0-9]{64}\.jpg', name) and name in files, 'ASSET_NAME_INVALID')
        data = files[name]
        need(asset.get('sha256') == sha(data) == name[:-4] and asset.get('bytes') == len(data)
             and data.startswith(b'\xff\xd8\xff') and data.endswith(b'\xff\xd9'), 'ASSET_HASH_INVALID')
    need(set(files) == {'manifest.json', *(a['file'] for a in manifest['assets'])}, 'EXTRA_ASSET_REFUSED')
    return manifest, files, sha(files['manifest.json'])[:16]


def render_routes(profile, bundle, assets):
    need(profile in PROFILES and re.fullmatch(r'[a-f0-9]{16}', bundle), 'PROFILE_INVALID')
    root = STATIC_ROOTS[profile]
    lines = ['# Exact approved image URLs only. No directory listing or member media.']
    for asset in assets:
        name = asset['file']
        need(re.fullmatch(r'[a-f0-9]{64}\.jpg', name), 'ASSET_NAME_INVALID')
        lines += [f'location = /v1/catalog/public-images/{name} {{',
                  f'    alias {root}/home-campaign/{bundle}/{name};',
                  '    default_type image/jpeg;', '    expires 365d;', '    etag on;',
                  '    sendfile on;', '    limit_except GET { deny all; }', '}']
    return ('\n'.join(lines) + '\n').encode()


def render_site(source, profile, bundle):
    need(profile in PROFILES and re.fullmatch(r'[a-f0-9]{16}', bundle), 'PROFILE_INVALID')
    root, domain, _ = PROFILES[profile]
    need(re.search(r'server_name\s+' + re.escape(domain) + r'\s*;', source)
         and 'ssl_certificate ' in source and len(re.findall(r'location\s+/\s*\{', source)) == 1,
         'EXISTING_HTTPS_SITE_REQUIRED')
    need(len(MARKER.findall(source)) <= 1, 'DUPLICATE_INCLUDE_REFUSED')
    source = MARKER.sub('', source)
    block = ('    # CISME_HOME_CAMPAIGN_BEGIN\n'
             f'    include {STATIC_ROOTS[profile]}/home-campaign/{bundle}/routes.conf;\n'
             '    # CISME_HOME_CAMPAIGN_END\n')
    return re.sub(r'(?=^[ \t]*location[ \t]+/[ \t]*\{)', lambda _: block, source, count=1, flags=re.MULTILINE)


def protected_read(path):
    need(path.is_absolute() and '..' not in path.parts, 'ABSOLUTE_PROTECTED_PATH_REQUIRED')
    for parent in [path.parent, *path.parents]:
        info = parent.stat()
        need(info.st_uid == 0 and not info.st_mode & 0o022, 'PROTECTED_PARENT_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
             and not info.st_mode & 0o022 and 0 < info.st_size < 2_000_000, 'PROTECTED_FILE_REQUIRED')
        data = os.read(fd, info.st_size + 1)
        after = os.fstat(fd)
        need(len(data) == info.st_size and (info.st_size, info.st_mtime_ns, info.st_ctime_ns)
             == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'SOURCE_CHANGED')
        return data
    finally:
        os.close(fd)


def atomic_write(path, data, mode=0o644):
    fd, name = tempfile.mkstemp(prefix='.campaign-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.chmod(name, mode); os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def immutable_write(path, data, mode=0o644):
    if path.exists():
        need(protected_read(path) == data, 'IMMUTABLE_FILE_MISMATCH')
        return
    atomic_write(path, data, mode)


def execute(args):
    need(os.geteuid() == 0 and re.fullmatch(r'[a-f0-9]{40}', args.source_head), 'ROOT_AND_SOURCE_HEAD_REQUIRED')
    with urllib.request.urlopen('http://metadata.tencentyun.com/latest/meta-data/public-ipv4', timeout=3) as response:
        need(response.read(128).decode().strip() == '124.223.74.198', 'EXACT_INSTANCE_REQUIRED')
    archive = Path(args.archive)
    need(str(archive).startswith('/opt/cisme-release-incoming/'), 'REVIEWED_INCOMING_PATH_REQUIRED')
    raw = protected_read(archive)
    need(sha(raw) == args.archive_sha256, 'ARCHIVE_HASH_MISMATCH')
    manifest, files, bundle = decode_bundle(raw)
    sites = {}
    for profile, (_root, _domain, filename) in PROFILES.items():
        path = Path(filename).resolve(strict=True)
        need(str(path).startswith('/etc/nginx/'), 'FIXED_NGINX_SITE_REQUIRED')
        before = protected_read(path)
        after = render_site(before.decode(), profile, bundle).encode()
        sites[profile] = {'path': path, 'before': before, 'after': after}
    plan = {'instance': 'lhins-61ikz4mi', 'publicIpv4': '124.223.74.198', 'bundle': bundle,
            'sourceHead': args.source_head, 'assets': [{'key': a['key'], 'sha256': a['sha256'], 'bytes': a['bytes']} for a in manifest['assets']],
            'configBefore': {k: sha(v['before']) for k, v in sites.items()},
            'configAfter': {k: sha(v['after']) for k, v in sites.items()}, 'databaseWrites': False, 'apiRestart': False}
    subprocess.run(['/usr/sbin/nginx', '-t'], check=True, capture_output=True)
    if not args.apply:
        return {**plan, 'deployed': False, 'readOnly': True}
    need(args.expected_trial_config == plan['configBefore']['trial']
         and args.expected_release_config == plan['configBefore']['release'], 'REVIEWED_CONFIG_BASELINE_REQUIRED')
    for profile, (root, _domain, _) in PROFILES.items():
        target = Path(STATIC_ROOTS[profile]) / 'home-campaign' / bundle
        target.mkdir(parents=True, exist_ok=True, mode=0o755)
        for name, data in files.items():
            immutable_write(target / name, data)
        immutable_write(target / 'routes.conf', render_routes(profile, bundle, manifest['assets']))
    if all(v['before'] == v['after'] for v in sites.values()):
        return {**plan, 'deployed': True, 'alreadyInstalled': True}
    changed = []
    try:
        for profile, site in sites.items():
            need(protected_read(site['path']) == site['before'], 'CONCURRENT_CONFIG_CHANGE')
            receipt = Path(PROFILES[profile][0]) / 'ops-receipts/home-campaign' / args.source_head
            receipt.mkdir(parents=True, exist_ok=True, mode=0o700)
            immutable_write(receipt / 'site.before.conf', site['before'], 0o600)
            atomic_write(site['path'], site['after']); changed.append(profile)
        subprocess.run(['/usr/sbin/nginx', '-t'], check=True, capture_output=True)
        subprocess.run(['/bin/systemctl', 'reload', 'nginx'], check=True, capture_output=True)
    except BaseException:
        for profile in reversed(changed):
            atomic_write(sites[profile]['path'], sites[profile]['before'])
        subprocess.run(['/usr/sbin/nginx', '-t'], check=True, capture_output=True)
        subprocess.run(['/bin/systemctl', 'reload', 'nginx'], check=True, capture_output=True)
        raise
    for profile in PROFILES:
        receipt = Path(PROFILES[profile][0]) / 'ops-receipts/home-campaign' / args.source_head / 'deployed.json'
        immutable_write(receipt, json.dumps({**plan, 'deployed': True}, sort_keys=True, indent=2).encode() + b'\n', 0o600)
    return {**plan, 'deployed': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--source-head', required=True)
    parser.add_argument('--expected-trial-config')
    parser.add_argument('--expected-release-config')
    parser.add_argument('--apply', action='store_true')
    try:
        print(json.dumps(execute(parser.parse_args()), sort_keys=True))
    except Exception as error:
        print(json.dumps({'deployed': False, 'error': str(error)})); raise SystemExit(1)
