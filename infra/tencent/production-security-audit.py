#!/usr/bin/env python3
"""Read-only, allowlisted local-host audit. Never print raw config/logs/errors.

Run as root on the already authenticated production host. No secret is written,
hashed for export, passed on argv, or returned. This is not a rotation tool.
"""
import collections
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
from urllib.parse import urlsplit, unquote, parse_qs


def command(argv, env=None):
    result = subprocess.run(argv, env=env, capture_output=True, timeout=15)
    if result.returncode:
        raise ValueError('COMMAND_FAILED')
    return result.stdout.decode('utf-8', errors='strict')


def environment(text):
    result = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        if not re.fullmatch(r'[A-Z_][A-Z_0-9]*', key):
            raise ValueError('ENV_FORMAT_INVALID')
        tokens = shlex.split(value, comments=False)
        if len(tokens) > 1 or key in result:
            raise ValueError('ENV_FORMAT_INVALID')
        result[key] = tokens[0] if tokens else ''
    return result


def database(raw):
    value = urlsplit(raw)
    if value.scheme not in ('postgres', 'postgresql') or value.fragment:
        raise ValueError('DATABASE_URL_INVALID')
    name, user = unquote(value.path.removeprefix('/')), unquote(value.username or '')
    # Never fall back to URL.path: an incorrectly quoted URL can put the entire
    # credential in that field. Validate before exposing any derived value.
    if not re.fullmatch(r'[A-Za-z0-9_]{1,63}', name) or not re.fullmatch(r'[A-Za-z0-9_-]{1,63}', user):
        raise ValueError('DATABASE_ID_INVALID')
    host = str(ipaddress.ip_address(value.hostname or ''))
    options = parse_qs(value.query, strict_parsing=True)
    allowed = {'sslmode', 'sslrootcert', 'sslcert', 'sslkey'}
    if set(options) - allowed or any(len(v) != 1 for v in options.values()):
        raise ValueError('DATABASE_OPTIONS_UNSUPPORTED')
    settings = {'PGHOST': host, 'PGPORT': str(value.port or 5432), 'PGDATABASE': name,
                'PGUSER': user, 'PGPASSWORD': unquote(value.password or ''), 'PGCONNECT_TIMEOUT': '4'}
    for key, values in options.items():
        if key == 'sslmode' and values[0] not in ('disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'):
            raise ValueError('DATABASE_SSL_INVALID')
        if key != 'sslmode' and not re.fullmatch(r'/[A-Za-z0-9_./-]+', values[0]):
            raise ValueError('DATABASE_SSL_PATH_INVALID')
        settings['PG' + key.upper()] = values[0]
    safe = {'databaseName': name, 'role': user, 'host': host, 'port': value.port or 5432,
            'loopback': ipaddress.ip_address(host).is_loopback,
            'sslMode': settings.get('PGSSLMODE', 'libpq-default')}
    return safe, settings


def postgres(sql):
    text = command(['runuser', '-u', 'postgres', '--', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c', sql])
    return json.loads(text)


def main():
    result = {'schemaVersion': 1, 'observedAtUtc': datetime.now(timezone.utc).isoformat(),
              'readOnly': True, 'credentialsRotated': False, 'networkChanged': False}
    credentials = []
    result['services'] = {}
    for unit in ('cisme-api', 'cisme-worker'):
        try:
            pid = command(['systemctl', 'show', unit, '--property=MainPID', '--value']).strip()
            if not re.fullmatch(r'[1-9][0-9]*', pid):
                raise ValueError('SERVICE_NOT_RUNNING')
            # Actual running process environment, not a guessed configuration.
            raw = dict(item.split('=', 1) for item in Path('/proc/' + pid + '/environ').read_text().split('\0') if '=' in item)
            safe, settings = database(raw.get('DATABASE_URL', ''))
            authenticated = command(['psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT true'],
                                    {'PATH': '/usr/bin:/bin', **settings}).strip() == 't'
            files = command(['systemctl', 'show', unit, '--property=EnvironmentFiles', '--value']).strip()
            file_names = re.findall(r'(/[A-Za-z0-9_./-]+) \(ignore_errors=(?:yes|no)\)', files)
            credentials.append(settings)
            result['services'][unit] = {**safe, 'currentCredentialAuthenticates': authenticated,
                                        'environmentFiles': file_names,
                                        'appEnv': raw.get('APP_ENV') if raw.get('APP_ENV') in ('production', 'staging', 'test') else 'UNKNOWN'}
        except Exception:
            result['services'][unit] = {'status': 'UNVERIFIED_PROBE_FAILED'}
    result['apiWorkerSameDatabaseCredentials'] = credentials[0] == credentials[1] if len(credentials) == 2 else None
    try:
        result['postgres'] = postgres("SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN ('listen_addresses','port','ssl','ssl_min_protocol_version','password_encryption','log_connections','log_disconnections','logging_collector','log_destination','log_line_prefix','log_directory','log_filename')")
        result['hbaRules'] = postgres("SELECT coalesce(json_agg(json_build_object('line',line_number,'type',type,'database',database,'user',user_name,'address',address,'netmask',netmask,'method',auth_method,'clientCertVerifyFull',coalesce('clientcert=verify-full'=ANY(options),false),'clientCertVerifyCA',coalesce('clientcert=verify-ca'=ANY(options),false),'hasParseError',error IS NOT NULL)),'[]') FROM pg_hba_file_rules")
        result['activeConnections'] = postgres("SELECT coalesce(json_agg(x),'[]') FROM (SELECT a.usename,a.datname,a.client_addr,coalesce(s.ssl,false) tls,(s.client_dn IS NOT NULL) client_certificate,count(*) FROM pg_stat_activity a LEFT JOIN pg_stat_ssl s USING(pid) WHERE a.backend_type='client backend' GROUP BY 1,2,3,4,5) x")
        result['rolePasswordFormat'] = postgres("SELECT coalesce(json_object_agg(rolname,CASE WHEN rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'SCRAM-SHA-256' WHEN rolpassword IS NULL THEN 'NONE' ELSE 'OTHER' END),'{}') FROM pg_authid WHERE rolname IN (SELECT usename FROM pg_stat_activity WHERE datname='cisme')")
    except Exception:
        result['postgresAuditStatus'] = 'UNVERIFIED_PROBE_FAILED'
    # Aggregate connection/auth events only; never emit query text/log messages.
    counts = collections.Counter()
    files_scanned, bytes_scanned = 0, 0
    for path in sorted(Path('/var/log/postgresql').glob('postgresql-*.log'))[-7:]:
        try:
            with path.open('rb') as stream:
                size = path.stat().st_size
                stream.seek(max(0, size - 4 * 1024 * 1024))
                payload = stream.read(4 * 1024 * 1024)
            files_scanned += 1
            bytes_scanned += len(payload)
            for line in payload.decode('utf-8', errors='replace').splitlines():
                kind = next((s for s in ('password authentication failed', 'no pg_hba.conf entry', 'connection received', 'connection authorized', 'certificate authentication failed') if s in line), None)
                if not kind:
                    continue
                match = re.search(r'(?:host=|host \")([0-9a-fA-F:.]+)', line)
                try:
                    source = str(ipaddress.ip_address(match[1])) if match else 'NOT_RECORDED'
                except ValueError:
                    source = 'NOT_RECORDED'
                counts[(kind, source)] += 1
        except Exception:
            pass
    result['recentLogSample'] = {'files': files_scanned, 'bytes': bytes_scanned,
                                'scope': 'last seven current .log files, at most last 4 MiB each; not a complete intrusion investigation',
                                'events': [{'kind': k, 'source': s, 'count': n} for (k, s), n in sorted(counts.items())],
                                'absenceOfEvidenceDoesNotProveNoMisuse': True}
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"status":"UNVERIFIED_PROBE_FAILED","readOnly":true}')
