# CISME app

Native WeChat mini-program and Node API deployment snapshot.

Development review only. Production identity, public hosting, full visual acceptance and physical-device acceptance remain incomplete. Payments and unapproved capabilities remain disabled.

Build: `npm ci && npm run build`. Container: root Dockerfile. Secrets must be supplied by the hosting environment; no credentials are included. Database migrations require an explicit migration job.
