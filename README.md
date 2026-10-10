# trayectoiq-api

API del MVP de TrayectoIQ. La especificación vive en `trayectoiq-docs`; este repositorio la implementa.

- Stack: Node.js 24 LTS, NestJS 12 + Fastify, TypeScript `strict` (ESM), Prisma 7, PostgreSQL 16, pnpm.
- Convenciones: `DEVELOPMENT_GUIDE.md` en `trayectoiq-docs`.
- Plan: `11_DEVELOPMENT_PLAN.md` en `trayectoiq-docs`.

## Requisitos

- Node.js 24 (`.nvmrc`) y pnpm 10 (`corepack enable`).
- Docker con Docker Compose.

## Arranque local

```bash
cp .env.example .env
cp .env.test.example .env.test
pnpm install
docker compose up -d postgres mailpit
pnpm db:migrate
pnpm start:dev
```

- API: <http://localhost:3000/health> y <http://localhost:3000/health/ready>
- Correos de desarrollo (Mailpit): <http://localhost:8025>
- PostgreSQL local: puerto **15432** (no el 5432, para no chocar con una instalación propia).

Todo en contenedores, incluidas las migraciones como job previo a la API:

```bash
docker compose up --build
```

## Scripts

| Script | Qué hace |
|---|---|
| `pnpm lint` | ESLint, incluida la regla de dependencias entre módulos |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test:unit` | Tests sin dependencias externas |
| `pnpm test:golden` | Los 9 fixtures golden y los 16 inválidos del Pricing Engine, con igualdad exacta |
| `pnpm fixtures:check` | Los fixtures contra el motor de referencia en Python (necesita Python 3) |
| `pnpm pricing:calc <archivo.json>` | Calcula una cotización desde un archivo con la forma de un fixture |
| `pnpm test:int` | Integración contra PostgreSQL real; crea y borra sus propias bases |
| `pnpm test:contract` | La API implementada contra `contract/openapi.yaml` (se llena en M3) |
| `pnpm test:e2e` | La aplicación completa por HTTP |
| `pnpm openapi:lint` | Valida `contract/openapi.yaml` |
| `pnpm db:migrate` | Aplica migraciones (`prisma migrate deploy`) |
| `pnpm db:check-schema` | Falla si las migraciones no producen `contract/db/schema.sql` |
| `pnpm contract:sync` | Copia el contrato desde `trayectoiq-docs` |
| `pnpm contract:check` | Falla si `contract/` difiere de `trayectoiq-docs` |
| `pnpm ci:local` | Los mismos pasos que el CI de un PR |

Los tests de integración y de extremo a extremo necesitan `docker compose up -d postgres`.

## Pricing Engine

`src/modules/pricing/domain` implementa `03_PRICING_ENGINE.md` v1.0.0 como una función pura:

```ts
calculate(input: PricingInput, config: EngineConfig): PricingResult // lanza PricingError(code)
```

Para cotizar a mano (por ejemplo en el concierge MVP):

```bash
pnpm -s pricing:calc caso.json
```

`caso.json` tiene `route`, `quote` y `vehicleCostProfile` con la forma de `contract/fixtures/pricing-engine-golden.json`. Sale con código 2 y el `code` en stderr si la entrada incumple una regla.

## Estructura

```text
contract/        Copia del contrato: openapi.yaml, db/schema.sql, fixtures/. No se edita aquí.
prisma/          schema.prisma (introspección) y migraciones SQL.
src/
  config/        Validación del entorno.
  health/        Endpoints operativos, fuera de /v1.
  modules/       Módulos de dominio (ver la tabla de dependencias en eslint.config.mjs).
  shared/        Código transversal; no importa nada de modules/.
  generated/     Cliente de Prisma generado; no se versiona.
test/
  unit/  golden/  integration/  contract/  e2e/  support/
```

## Reglas que el repositorio hace cumplir

- **Contrato:** `contract/` es una copia. Un cambio de API o de esquema se hace en `trayectoiq-docs` y se trae con `pnpm contract:sync`; `contract/SOURCE.json` registra el commit de origen.
- **Esquema:** `contract/db/schema.sql` es la referencia. Un cambio de modelo es una migración nueva en `prisma/migrations/` más el cambio en la referencia; `pnpm db:check-schema` compara ambos catálogos.
- **Módulos:** las dependencias permitidas están en `eslint.config.mjs` y reflejan `04_ARCHITECTURE.md` §2. `pricing` no puede importar framework, base de datos, red ni otros módulos.
- **Inyección:** las dependencias de constructor llevan `@Inject(...)` explícito, para no depender de la emisión de metadatos de decoradores del transpilador.
- **Dinero:** el dominio usa `Fraction` (`src/shared/fraction`), racional exacto sobre `BigInt`. Ni `number` ni decimales de precisión fija; el redondeo ocurre una sola vez, al serializar.
- **Fixtures:** `contract/fixtures/*.json` no se editan a mano; `pnpm fixtures:check` los compara con el motor de referencia.
- **Migraciones:** corren como job (`pnpm db:migrate`), nunca al arrancar la API.
