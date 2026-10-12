# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Dependencias completas. --ignore-scripts: "prepare" necesita el esquema, que se copia despues.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# Compilacion. Esta etapa tambien sirve como imagen del job de migraciones.
FROM deps AS build
COPY . .
RUN pnpm build

# Solo dependencias de produccion.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# La API valida sus peticiones contra el contrato en tiempo de ejecucion.
COPY contract ./contract
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
