#!/opt/cisme-maintenance/bin/python
"""Create an authenticated encrypted PostgreSQL archive and verify its COS copy."""
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import uuid

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from qcloud_cos import CosConfig, CosS3Client, CosServiceError

BUCKET = "lhcos-81ddf-1257392443"
MAGIC = b"CISMEBK1"
CHUNK = 1024 * 1024


def digest_file(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    os.umask(0o077)
    directory = Path("/var/backups/cisme-encrypted")
    directory.mkdir(mode=0o700, exist_ok=True)
    settings = json.loads(Path("/etc/cisme/maintenance.json").read_text())
    key = Path("/etc/cisme/backup-aes256.key").read_bytes()
    if len(key) != 32:
        raise RuntimeError("Expected a 32-byte encryption key")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"cisme-{stamp}-{uuid.uuid4().hex}.dump.aesgcm"
    encrypted = directory / filename
    with tempfile.TemporaryDirectory(prefix="cisme-backup-", dir=directory) as scratch:
        plain = Path(scratch) / "database.dump"
        with plain.open("wb") as output:
            subprocess.run(["runuser", "-u", "postgres", "--", "pg_dump", "-Fc", "cisme"], stdout=output, check=True)
        nonce = os.urandom(12)
        encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
        encryptor.authenticate_additional_data(MAGIC)
        with plain.open("rb") as source, encrypted.open("wb") as output:
            output.write(MAGIC + nonce)
            while chunk := source.read(CHUNK):
                output.write(encryptor.update(chunk))
            output.write(encryptor.finalize())
            output.write(encryptor.tag)
        expected = digest_file(encrypted)
        client = CosS3Client(CosConfig(Region="ap-shanghai", SecretId=settings["accessKeyId"], SecretKey=settings["secretAccessKey"], Scheme="https"))
        object_key = "backups/postgres/" + filename
        with encrypted.open("rb") as source:
            client.put_object(Bucket=BUCKET, Key=object_key, Body=source, ContentType="application/octet-stream")
        downloaded = Path(scratch) / "remote.aesgcm"
        client.get_object(Bucket=BUCKET, Key=object_key)["Body"].get_stream_to_file(str(downloaded))
        if digest_file(downloaded) != expected:
            raise RuntimeError("Remote encrypted backup checksum mismatch")
        decrypt_archive(downloaded, key, Path(scratch) / "verified.dump")
        subprocess.run(["pg_restore", "--list", str(Path(scratch) / "verified.dump")], stdout=subprocess.DEVNULL, check=True)
        removed = prune_remote(client, datetime.now(timezone.utc))
        evidence = {"at": stamp, "objectKey": object_key, "bytes": encrypted.stat().st_size, "sha256": expected, "remoteChecksumVerified": True, "authenticationVerified": True, "archiveReadable": True, "remoteRetentionDays": 30, "remoteDeleted": removed}
        (directory / "last-success.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence))
    # Keep seven complete local encrypted copies after remote verification succeeds.
    for old in sorted(directory.glob("cisme-*.dump.aesgcm"), reverse=True)[7:]:
        old.unlink()


def prune_remote(client, now):
    # A named manifest avoids granting bucket-wide enumeration to the maintenance account.
    manifest_key = "backups/postgres/manifest.json"
    try:
        response = client.get_object(Bucket=BUCKET, Key=manifest_key)
        objects = json.loads(response["Body"].get_raw_stream().read())
    except CosServiceError as error:
        if error.get_status_code() != 404:
            raise
        objects = []
    known = {item["Key"]: item for item in objects}
    for archive in Path("/var/backups/cisme-encrypted").glob("cisme-*.dump.aesgcm"):
        key = "backups/postgres/" + archive.name
        known.setdefault(key, {"Key": key, "LastModified": datetime.fromtimestamp(archive.stat().st_mtime, timezone.utc).isoformat()})
    objects = list(known.values())
    objects.sort(key=lambda item: item["LastModified"], reverse=True)
    removed = 0
    retained = objects[:7]
    for item in objects[7:]:
        modified = datetime.fromisoformat(item["LastModified"].replace("Z", "+00:00"))
        valid_name = re.fullmatch(r"backups/postgres/cisme-\d{8}T\d{6}Z-[0-9a-f]{32}\.dump\.aesgcm", item["Key"])
        if valid_name and modified < now - timedelta(days=30):
            client.delete_object(Bucket=BUCKET, Key=item["Key"])
            removed += 1
        else:
            retained.append(item)
    client.put_object(Bucket=BUCKET, Key=manifest_key, Body=json.dumps(retained).encode(), ContentType="application/json")
    return removed


def decrypt_archive(source, key, destination):
    with source.open("rb") as input_file:
        if input_file.read(len(MAGIC)) != MAGIC:
            raise RuntimeError("Unknown encrypted archive format")
        nonce = input_file.read(12)
        input_file.seek(-16, 2)
        tag = input_file.read(16)
        remaining = source.stat().st_size - len(MAGIC) - 12 - 16
        input_file.seek(len(MAGIC) + 12)
        decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
        decryptor.authenticate_additional_data(MAGIC)
        try:
            with destination.open("wb") as output:
                while remaining > 0:
                    chunk = input_file.read(min(CHUNK, remaining))
                    if not chunk:
                        raise RuntimeError("Truncated encrypted archive")
                    output.write(decryptor.update(chunk))
                    remaining -= len(chunk)
                output.write(decryptor.finalize())
        except BaseException:
            destination.unlink(missing_ok=True)
            raise


if __name__ == "__main__":
    main()
