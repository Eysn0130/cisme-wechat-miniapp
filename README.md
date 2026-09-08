# CISME app

Native WeChat mini-program and Node API deployment snapshot.

Development review only. Production identity, public hosting, full visual acceptance and physical-device acceptance remain incomplete. Payments and unapproved capabilities remain disabled.

Build: `npm ci && npm run build`. Container: root Dockerfile. Secrets must be supplied by the hosting environment; no credentials are included. Database migrations require an explicit migration job.

Supabase deployment uses `OBJECT_STORAGE_DRIVER=s3_gateway`: the API checks each upload token, expiry, size and image signature before writing to the private S3 bucket. Do not use direct `s3` multipart POST for this provider: live testing found that per-request content-length-range was not enforced. Configure S3 endpoint/region/bucket/access keys and UPLOAD_TOKEN_SECRET in the hosting secret store. The mini-program keeps POST /v1/uploads/:mediaId via wx.uploadFile; no filesystem persistence is used for this driver.
