# PAYDER backend — production image (NestJS + Prisma)
# Built for AWS App Runner / ECS Fargate. Multi-stage so the final image
# doesn't carry devDependencies, TypeScript sources, or build tooling.

# ---- deps + build ----
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma's query/schema engines need a real OpenSSL on Alpine (musl) or they
# fail at runtime with "Could not parse schema engine response" / crash-loop.
RUN apk add --no-cache openssl

# Install dependencies first (better layer caching on rebuilds)
COPY package.json package-lock.json ./
RUN npm ci

# Prisma needs the schema present before `generate` can run
COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Same reason as the builder stage: Prisma's migration engine shells out to
# openssl at runtime to negotiate TLS with Postgres and needs it installed.
RUN apk add --no-cache openssl

# Only production deps in the final image
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Prisma's generated client + schema (needed at runtime for migrate deploy)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main"]
