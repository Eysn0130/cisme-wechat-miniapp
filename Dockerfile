FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:24.14.0-bookworm-slim AS runtime
WORKDIR /app
# Keep the migration runner and workspace packages for explicit migration jobs.
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/tmp && chown node:node /app/tmp
ENV APP_ENV=staging
ENV ALLOW_DEV_ADAPTERS=false
ENV PORT=3100
ENV RUN_BACKGROUND_WORKER=true
USER node
EXPOSE 3100
CMD ["node", "dist/services/api/src/server.js"]
