# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (layer-cached unless package*.json changes)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# Prune dev dependencies so we only carry prod deps into the runtime stage
RUN npm prune --production

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Install dumb-init for proper PID-1 signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001

# Copy only production artefacts from builder
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package*.json ./
COPY --from=builder --chown=nestjs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nestjs:nodejs /app/scripts ./scripts

USER nestjs

# PORT is supplied by Render at runtime — do NOT hardcode
EXPOSE 3010

# dumb-init reaps zombie processes and forwards signals correctly
ENTRYPOINT ["dumb-init", "--"]

# Run migrations then start the compiled NestJS app
CMD ["sh", "-c", "echo '==> Running DB migrations...' && node scripts/migrate.js && echo '==> Starting application...' && node dist/main.js"]
