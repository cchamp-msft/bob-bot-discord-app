# Build stage — digest-pinned for reproducible builds
FROM node:20-alpine@sha256:09e2b3d9726018aecf269bd35325f46bf75046a643a66d28360ec71132750ec8 AS builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage — same digest pin
FROM node:20-alpine@sha256:09e2b3d9726018aecf269bd35325f46bf75046a643a66d28360ec71132750ec8

# Create a non-root user/group for least-privilege execution
RUN addgroup -S bobbot && adduser -S bobbot -G bobbot

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/src/public ./src/public
COPY PRIVACY_POLICY.md ./
COPY config/keywords.default.json ./config/

# Create writable directories and hand ownership to the non-root user
RUN mkdir -p outputs .config && chown -R bobbot:bobbot /app

ENV NODE_ENV=production

EXPOSE 3000 3003

# Switch to non-root user for runtime
USER bobbot

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3003/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
