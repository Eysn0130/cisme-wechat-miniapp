#!/opt/cisme-maintenance/bin/python
"""Certbot DNS hooks scoped to api.cisme.cn; credentials remain root-only."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from tencentcloud.common import credential
from tencentcloud.dnspod.v20210323 import dnspod_client, models

DOMAIN = "cisme.cn"
DOMAIN_ID = 99932402
HOST = "_acme-challenge.api"


def main():
    if os.environ.get("CERTBOT_DOMAIN") != "api.cisme.cn":
        raise RuntimeError("Unsupported certificate domain")
    validation = os.environ["CERTBOT_VALIDATION"]
    settings = json.loads(Path("/etc/cisme/maintenance.json").read_text())
    client = dnspod_client.DnspodClient(
        credential.Credential(settings["accessKeyId"], settings["secretAccessKey"]), ""
    )
    state_dir = Path("/var/lib/cisme-acme")
    state_dir.mkdir(mode=0o700, exist_ok=True)
    state = state_dir / (hashlib.sha256(validation.encode()).hexdigest() + ".json")

    def cleanup():
        if state.exists():
            record = json.loads(state.read_text())
            request = models.DeleteRecordRequest()
            request.from_json_string(json.dumps({"Domain": DOMAIN, "DomainId": DOMAIN_ID, "RecordId": record["id"]}))
            client.DeleteRecord(request)
            state.unlink()

    if sys.argv[1] == "cleanup":
        cleanup()
        return
    if sys.argv[1] != "auth":
        raise RuntimeError("Expected auth or cleanup")
    if not state.exists():
        request = models.CreateRecordRequest()
        request.from_json_string(json.dumps({"Domain": DOMAIN, "DomainId": DOMAIN_ID, "SubDomain": HOST, "RecordType": "TXT", "RecordLine": "默认", "Value": validation, "TTL": 600}))
        record_id = client.CreateRecord(request).RecordId
        state.write_text(json.dumps({"id": record_id}))
        state.chmod(0o600)
    try:
        for _ in range(60):
            propagated = True
            for server in ("wood.dnspod.net", "bee.dnspod.net"):
                result = subprocess.run(["dig", "+time=3", "+tries=1", "+short", "@" + server, HOST + "." + DOMAIN, "TXT"], capture_output=True, text=True, timeout=5)
                propagated &= result.returncode == 0 and ('"' + validation + '"') in result.stdout.splitlines()
            if propagated:
                return
            time.sleep(10)
        raise RuntimeError("DNS validation did not propagate to both authoritative servers")
    except BaseException:
        cleanup()
        raise


if __name__ == "__main__":
    main()
