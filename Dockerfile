FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# The runtime needs only `node`. Removing npm/npx/corepack drops their bundled dependencies (a recurring source of
# scanner findings) and removes tools an attacker could use after a compromise.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn* \
 && apk upgrade --no-cache
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY infra/sql ./infra/sql
COPY scripts ./scripts
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["node", "src/server.js"]
