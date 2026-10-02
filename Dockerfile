FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY apps ./apps
COPY packages ./packages
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system token && useradd --system --gid token --home-dir /app token \
  && mkdir -p /data && chown token:token /data
COPY --from=build --chown=token:token /app/package.json /app/package-lock.json ./
COPY --from=build --chown=token:token /app/node_modules ./node_modules
COPY --from=build --chown=token:token /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=token:token /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=token:token /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=token:token /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=token:token /app/packages/shared/dist ./packages/shared/dist
USER token
EXPOSE 4100
CMD ["node", "apps/api/dist/server.js"]
