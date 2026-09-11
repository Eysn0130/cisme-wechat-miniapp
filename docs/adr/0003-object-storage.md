# ADR 0003 — replaceable object storage

Status: accepted for local adapter; production supplier unset.

Use an `ObjectStorage` port with authorize, verify, delete and readiness operations. The primary local adapter is SeaweedFS 4.29 using path-style SigV4 presigned multipart POST. On 2026-08-14 an actual form matching `wx.uploadFile` passed POST, HEAD, SHA-256 verification and deletion. SeaweedFS is Apache-2.0 and remains a local/test dependency.

A controlled API multipart gateway is retained as a portable fallback. MinIO is not selected. Production must supply HTTPS, encryption/key management, retention, audit, region, export and deletion evidence before an adapter is frozen. Object keys are server-generated and never client-authoritative.
