#!/usr/bin/env python3
"""Read-only public source metadata. Never install or execute upstream code.

Print a bounded provenance receipt to stdout. A missing license stays unknown;
metadataComplete is not a commercial/legal/compatibility approval. This script
has no upload, deployment, database, merchant or private-profile operations.
"""
import base64
import datetime
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request

REPOSITORIES = (
    "Appllama/appllama-skills", "greensock/gsap-skills",
    "Jakubantalik/transitions.dev", "wechat-miniprogram/miniprogram-demo",
    "wechat-miniprogram/recycle-view", "fastify/fastify", "brianc/node-postgres",
    "mcollina/autocannon", "grafana/k6", "open-telemetry/opentelemetry-js",
    "wechat-miniprogram/api-typings",
)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Do not forward authorization to a redirect destination.

OPENER = urllib.request.build_opener(NoRedirect())

def read(repo: str, suffix: str = ""):
    if repo not in REPOSITORIES or not (suffix == "" or suffix.startswith("/")):
        raise ValueError("Unapproved source")
    url = "https://api.github.com/repos/" + repo + suffix
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "CISME-readonly-source-audit",
               "X-GitHub-Api-Version": "2022-11-28"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    with OPENER.open(urllib.request.Request(url, headers=headers), timeout=15) as response:
        body = response.read(2_000_001)
        if len(body) > 2_000_000:
            raise ValueError("Source metadata response too large")
        return json.loads(body), {"url": url, "sha256": hashlib.sha256(body).hexdigest()}

def inspect(repo: str):
    result = {"repo": repo, "metadataComplete": False, "licenseCopyApproval": False}
    try:
        metadata, metadata_source = read(repo)
        branch = metadata["default_branch"]
        commit, commit_source = read(repo, "/commits/" + urllib.parse.quote(branch, safe=""))
        result.update(defaultBranch=branch, sha=commit["sha"], commitAt=commit["commit"]["committer"]["date"],
                      pushedAt=metadata["pushed_at"], archived=metadata["archived"],
                      licenseReported=(metadata.get("license") or {}).get("spdx_id"),
                      metadataComplete=True, sources=[metadata_source, commit_source])
        try:
            license_file, license_source = read(repo, "/license?ref=" + commit["sha"])
            content = base64.b64decode(license_file["content"])
            result.update(licenseFile=license_file["path"], licenseBlobSha=license_file["sha"],
                          licenseTextSha256=hashlib.sha256(content).hexdigest(), licenseSource=license_source)
        except urllib.error.HTTPError as error:
            result["licenseReadStatus"] = error.code  # No raw error body or credential.
        except (ValueError, KeyError, OSError):
            result["licenseReadStatus"] = "unavailable"
    except urllib.error.HTTPError as error:
        result["metadataReadStatus"] = error.code
    except (ValueError, KeyError, OSError):
        result["metadataReadStatus"] = "unavailable"
    return result

if __name__ == "__main__":
    resources = [inspect(repo) for repo in REPOSITORIES]
    print(json.dumps({"schemaVersion": 1, "retrievedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      "scope": "Public metadata and pinned root-license hashes only; no whole-code, paid-case, runtime-license or compatibility approval",
                      "metadataComplete": all(row["metadataComplete"] for row in resources),
                      "resourceCount": len(resources), "resources": resources}, ensure_ascii=False, indent=2))
