#!/usr/bin/env python3
"""Explicit operator execution only. Preparation never calls this trial-only SSH runner."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile
import zlib

HERE = Path(__file__).resolve().parent
HEAD = None  # FINALIZER_HEAD
TREE = None  # FINALIZER_TREE
COMPATIBILITY_SHA256 = '2f23b820857ce98fcb916e6848adba796522b9a2c81333c069a50631000137ef'
HELPER_SHA256 = '7a67c3b3c6d76b1b2f2ff23fc69f34081ad54b5e1e5e94d5f1b8f9ced28dc99b'
PUBLIC_ERROR_PREFIXES = ('STAGE_', 'COMMENTS_', 'NO_SCHEMA_', 'DEPENDENCY_', 'PRODUCTION_', 'GITHUB_')
PUBLIC_ERROR_EXACT = ('EXACT_MAIN_PUSH_CI_REQUIRED', 'LATEST_MAIN_CI_NOT_SUCCESSFUL')
PUBLIC_PHASES = ('binding', 'payload', 'target', 'baseline_guard', 'receive_archive', 'unpack',
                 'validate_extraction', 'candidate_source', 'recheck_target', 'recheck_baseline',
                 'recheck_candidate', 'copy_candidate', 'validate_candidate', 'install_helper',
                 'write_compatibility', 'final_fence', 'write_receipt', 'validate_binding', 'write_binding')
PUBLIC_FUNCTIONS = ('main', 'target', 'metadata', 'redirect_request', 'safe_directory', 'safe_parents',
                    'read_regular', 'private_write', 'receive_archive', 'member_path', 'tar_members',
                    'unpack', 'validated_release', 'dependency_digest', 'file_sha', 'helper_payload',
                    'compatibility_payload', 'baseline_guard', 'validate_release', 'candidate_contract',
                    'application_binding', 'unique')


def need(value):
    if not value:
        raise ValueError('LOCAL_STAGE_BINDING_REQUIRED')


def read_verified(path, limit, expected_sha256=None, expected_size=None):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.geteuid())
             and info.st_mode & 0o022 == 0 and 0 <= info.st_size <= limit)
        need(expected_size is None or info.st_size == expected_size)
        data = bytearray()
        while chunk := os.read(fd, min(65536, limit + 1 - len(data))):
            data.extend(chunk)
            need(len(data) <= limit)
        verified = bytes(data)
        need(len(verified) == info.st_size)
        need(expected_sha256 is None or hashlib.sha256(verified).hexdigest() == expected_sha256)
        return verified
    finally:
        os.close(fd)


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result)
        result[key] = value
    return result

def public_error_code(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{2,119}', value) and (
        value.startswith(PUBLIC_ERROR_PREFIXES) or value in PUBLIC_ERROR_EXACT) else None

def remote_failure(data):
    # stdout/stderr are already private on disk before any interpretation.
    result = {'code': 'SSH_STAGE_REVIEW_REQUIRED', 'failurePhase': 'unknown'}
    try:
        need(isinstance(data, bytes) and 0 < len(data) <= 65536)
        value = json.loads(data.decode('utf-8'), object_pairs_hook=unique)
        need(isinstance(value, dict) and value.get('ok') is False
             and value.get('deployed') is False and value.get('privateValuesExported') is False)
        code = public_error_code(value.get('code'))
        need(code is not None)
        result['code'] = code
        if value.get('failurePhase') in PUBLIC_PHASES:
            result['failurePhase'] = value['failurePhase']
        if value.get('stageFunction') in PUBLIC_FUNCTIONS and type(value.get('stageLine')) is int and 0 < value['stageLine'] < 10000:
            result.update(stageFunction=value['stageFunction'], stageLine=value['stageLine'])
    except Exception:
        pass
    return result

def private_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(fd)
    finally:
        os.close(fd)

def evidence_parent():
    parent = HERE.lstat()
    need(stat.S_ISDIR(parent.st_mode) and not HERE.is_symlink()
         and parent.st_uid in (0, os.geteuid()) and stat.S_IMODE(parent.st_mode) == 0o700)
    return HERE

def save_attempt(command, stdout, stderr, exit_code, *, timed_out=False, launch_failed=False):
    directory = Path(tempfile.mkdtemp(prefix='stage-attempt-', dir=evidence_parent()))
    directory.chmod(0o700)
    def raw(value):
        return value if isinstance(value, bytes) else value.encode('utf-8') if isinstance(value, str) else b''
    stdout, stderr = raw(stdout), raw(stderr)
    private_file(directory / 'stdout.bin', stdout)
    private_file(directory / 'stderr.bin', stderr)
    metadata = {'schemaVersion': 1, 'kind': 'trial-stage-ssh-attempt',
                'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'sourceHead': command['sourceHead'], 'sourceTree': command['sourceTree'],
                'stagerSha256': command['stagerSha256'], 'archiveSha256': command['archiveSha256'],
                'archiveBytes': command['archiveSize'], 'host': 'ubuntu@124.223.74.198',
                'sshReturnCode': exit_code, 'timedOut': timed_out, 'launchFailed': launch_failed,
                'stdoutBytes': len(stdout), 'stderrBytes': len(stderr),
                'stdoutSha256': hashlib.sha256(stdout).hexdigest(),
                'stderrSha256': hashlib.sha256(stderr).hexdigest(),
                'automaticReplay': False, 'responseNotYetValidated': True}
    private_file(directory / 'transport.json', (json.dumps(metadata, sort_keys=True) + '\n').encode())
    return directory

def failed(evidence, detail):
    print(json.dumps({'ok': False, **detail, 'deployed': False,
                      'localEvidenceDirectory': str(evidence), 'resultRequiresReview': True,
                      'automaticReplay': False, 'privateValuesExported': False}, sort_keys=True))
    return 1

def validate_receipt(receipt, command):
    need(isinstance(receipt, dict) and receipt.get('staged') is True and receipt.get('deployed') is False
         and receipt.get('sourceHead') == HEAD and receipt.get('sourceTree') == TREE
         and receipt.get('archiveSha256') == command['archiveSha256']
         and receipt.get('archiveSize') == command['archiveSize']
         and receipt.get('helperSha256') == HELPER_SHA256 and receipt.get('compatibilitySha256') == COMPATIBILITY_SHA256
         and receipt.get('candidateDirectories') == ['/opt/cisme-trial/releases/tencent-release-' + HEAD[:12]]
         and receipt.get('productionChanged') is False and receipt.get('peerFilesChanged') is False
         and receipt.get('manifestSha256') == command['releaseManifestSha256']
         and receipt.get('servicesChanged') is False and receipt.get('databaseChanged') is False
         and receipt.get('configurationChanged') is False
         and receipt.get('dependenciesSha256') == 'd9f03813fc808eced42eacb92db4530a2cd0e0824cab5d1beb9c3bdf08144bdd'
         and receipt.get('migrations') == 99
         and receipt.get('helperPath') == '/opt/cisme-trial/editorial-comment-runners/'+HEAD[:12]+'/trial-editorial-comments-upgrade.py'
         and receipt.get('applicationBindingPath') == '/opt/cisme-trial/editorial-comment-runners/'+HEAD[:12]+'/application-binding.json'
         and all(re.fullmatch(r'[a-f0-9]{64}', receipt.get(k,''))for k in ('applicationBindingSha256','stageReceiptSha256')))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True, help='Already authenticated formal-server SSH host/alias')
    parser.add_argument('--identity-file', required=True)
    parser.add_argument('--known-hosts', required=True)
    args = parser.parse_args()
    need(args.host == 'ubuntu@124.223.74.198')
    command = json.loads(read_verified(HERE / 'stage-command.json', 65536), object_pairs_hook=unique)
    need(isinstance(HEAD,str) and re.fullmatch(r'[a-f0-9]{40}',HEAD) and isinstance(TREE,str)
         and re.fullmatch(r'[a-f0-9]{40}',TREE) and command['sourceHead'] == HEAD and command['sourceTree'] == TREE
         and command['helperSha256'] == HELPER_SHA256 and command['compatibilitySha256'] == COMPATIBILITY_SHA256
         and command['serverWriteExecuted'] is False and command['deployed'] is False)
    need(re.fullmatch(r'[a-f0-9]{64}', command['archiveSha256']) is not None
         and type(command['archiveSize']) is int and 0 < command['archiveSize'] <= 512 * 1024 * 1024)
    need(Path(command['stagerPath']) == HERE / 'root-installer-final.py')
    stager = read_verified(HERE / 'root-installer-final.py', 128 * 1024, command['stagerSha256'])
    archive = read_verified(Path(command['archivePath']), 512 * 1024 * 1024,
                            command['archiveSha256'], command['archiveSize'])
    encoded = base64.b64encode(zlib.compress(stager, 9)).decode('ascii')
    bootstrap = "import base64,zlib;exec(compile(zlib.decompress(base64.b64decode(" + repr(encoded) + ")), '<reviewed-root-installer>', 'exec'))"
    remote = ('sudo -n /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 '
              '/usr/bin/python3 -I -B -c ' + shlex.quote(bootstrap))
    need(len(remote.encode()) < 100000)
    ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'ConnectTimeout=10', '-o', 'PasswordAuthentication=no',
           '-o', 'KbdInteractiveAuthentication=no', '-o', 'IdentitiesOnly=yes',
           '-i', str(Path(args.identity_file).absolute()),
           '-o', 'UserKnownHostsFile=' + str(Path(args.known_hosts).absolute()), args.host, remote]
    # Reuse the already verified buffer: never reopen archivePath for SSH stdin.
    evidence_parent()  # A private, writable evidence destination precedes SSH.
    try:
        result = subprocess.run(ssh, input=archive, capture_output=True, timeout=600)
    except subprocess.TimeoutExpired as error:
        evidence = save_attempt(command, error.stdout, error.stderr, None, timed_out=True)
        return failed(evidence, {'code': 'SSH_STAGE_TRANSPORT_TIMEOUT', 'failurePhase': 'ssh'})
    except OSError:
        evidence = save_attempt(command, b'', b'', None, launch_failed=True)
        return failed(evidence, {'code': 'SSH_STAGE_TRANSPORT_FAILED', 'failurePhase': 'ssh'})
    evidence = save_attempt(command, result.stdout, getattr(result, 'stderr', b''), result.returncode)
    if result.returncode != 0:
        return failed(evidence, remote_failure(result.stdout))
    try:
        need(0 < len(result.stdout) <= 65536)
        receipt = json.loads(result.stdout.decode('utf-8'), object_pairs_hook=unique)
        validate_receipt(receipt, command)
    except Exception:
        return failed(evidence, {'code': 'SSH_STAGE_RESPONSE_INVALID', 'failurePhase': 'response_validation'})
    print(json.dumps({**receipt, 'localEvidenceDirectory': str(evidence)}, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'ok': False, 'code': 'SSH_STAGE_REVIEW_REQUIRED', 'deployed': False}))
        raise SystemExit(1)
