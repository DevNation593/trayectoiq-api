// Prueba de humo contra una API levantada con proveedores reales (Valhalla, Photon, Mailpit):
// registra una cuenta, verifica el correo, crea un vehiculo, busca dos lugares, cotiza, recalcula,
// guarda la cotizacion, la lee del historial, registra la decision real y envia un evento de la app.
//
//   docker compose --profile geo up -d
//   pnpm build && pnpm start        (con ROUTING_PROVIDER=valhalla en .env)
//   pnpm smoke
//
// Recorre el cableado real de produccion, que los tests sustituyen por proveedores deterministas.
import { randomUUID } from 'node:crypto';

const api = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3000';
const mailpit = process.env.MAILPIT_URL ?? 'http://localhost:8025';

async function call(method, path, { token, body, headers } = {}) {
  const response = await fetch(`${api}/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text === '' ? null : JSON.parse(text);
  return { status: response.status, data };
}

function expectStatus(step, result, expected) {
  if (result.status !== expected) {
    console.error(`FALLA en "${step}": ${result.status} ${JSON.stringify(result.data)}`);
    process.exit(1);
  }
  console.log(`ok  ${step}`);
}

async function verificationCode(email) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const { messages } = await search.json();
    if (messages[0]) {
      const detail = await (await fetch(`${mailpit}/api/v1/message/${messages[0].ID}`)).json();
      const code = /\b(\d{6})\b/.exec(detail.Text)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error('FALLA: el correo de verificacion no llego a Mailpit');
  process.exit(1);
}

const email = `humo-${Date.now()}@example.com`;

const registered = await call('POST', '/auth/register', {
  body: { email, password: `clave-${randomUUID()}` },
});
expectStatus('registro', registered, 201);
const token = registered.data.accessToken;

const verified = await call('POST', '/auth/email/verify', {
  token,
  body: { code: await verificationCode(email) },
});
expectStatus('verificacion de correo (codigo leido de Mailpit)', verified, 204);

const config = await call('GET', '/app-config');
expectStatus('configuracion publica', config, 200);
const preset = config.data.costPresets.MOTORCYCLE;

const vehicle = await call('POST', '/vehicles', {
  token,
  headers: { 'idempotency-key': randomUUID() },
  body: { type: 'MOTORCYCLE', ...preset },
});
expectStatus('vehiculo creado con los valores sugeridos', vehicle, 201);

const place = async (q) => {
  const result = await call('GET', `/places/autocomplete?q=${encodeURIComponent(q)}`, { token });
  expectStatus(
    `autocompletado de "${q}" (${result.data?.[0]?.label ?? 'sin resultados'})`,
    result,
    200,
  );
  if (!result.data[0]) {
    console.error(`FALLA: sin sugerencias para "${q}"`);
    process.exit(1);
  }
  return result.data[0].id;
};
const pickup = await place('plaza grande');
const destination = await place('parque la carolina');

const quoteInputs = {
  waitingSeconds: 300,
  emptyReturnProbability: '0.5',
  tollsAmount: '0',
  parkingAmount: '0',
  otherDirectCostAmount: '0',
};
const preview = await call('POST', '/quotes/preview', {
  token,
  body: {
    vehicleId: vehicle.data.id,
    pickupMode: 'AT_PICKUP',
    pickup: { placeId: pickup },
    destination: { placeId: destination },
    offeredPrice: '4.00',
    ...quoteInputs,
  },
});
expectStatus('cotizacion con ruta real', preview, 200);
const { route, pricing, recommendation, quota } = preview.data;
console.log(
  `    ${route.routingProvider}/${route.routingProfile}: ${route.tripDistanceMeters} m, ` +
    `${Math.round(route.tripDurationSeconds / 60)} min | piso ${pricing.floor}, minimo ${pricing.minimum}, ` +
    `recomendado ${pricing.recommended} | oferta 4.00 -> ${recommendation} | cuota restante ${quota.remaining}`,
);

const recalculated = await call('POST', '/quotes/preview', {
  token,
  body: {
    vehicleId: vehicle.data.id,
    routeToken: preview.data.routeToken,
    offeredPrice: pricing.recommended,
    ...quoteInputs,
  },
});
expectStatus('recalculo con routeToken', recalculated, 200);
if (
  recalculated.data.recommendation !== 'ACCEPT' ||
  recalculated.data.quota.remaining !== quota.remaining
) {
  console.error(`FALLA: recalculo inesperado ${JSON.stringify(recalculated.data)}`);
  process.exit(1);
}
console.log(`    oferta ${pricing.recommended} -> ACCEPT, cuota sin cambios`);

const saved = await call('POST', '/quotes', {
  token,
  headers: { 'idempotency-key': randomUUID() },
  body: { previewToken: preview.data.previewToken },
});
expectStatus('cotizacion guardada', saved, 201);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!same(saved.data.pricing, pricing) || !same(saved.data.costs, preview.data.costs)) {
  console.error(`FALLA: lo guardado difiere del preview ${JSON.stringify(saved.data)}`);
  process.exit(1);
}

const history = await call('GET', '/quotes?limit=5', { token });
expectStatus('historial', history, 200);
const detail = await call('GET', `/quotes/${saved.data.id}`, { token });
expectStatus('detalle de la cotizacion', detail, 200);
if (history.data.items[0]?.id !== saved.data.id || !same(detail.data, saved.data)) {
  console.error(`FALLA: el historial no devuelve lo guardado ${JSON.stringify(history.data)}`);
  process.exit(1);
}
console.log(
  `    ${detail.data.pickupLabel} -> ${detail.data.destinationLabel}, igual que el preview`,
);

const decision = await call('POST', `/quotes/${saved.data.id}/decision`, {
  token,
  headers: { 'idempotency-key': randomUUID() },
  body: { action: 'NEGOTIATED_AND_ACCEPTED', finalPrice: pricing.minimum, influence: 'YES' },
});
expectStatus('decision real registrada', decision, 200);

const events = await call('POST', '/events', {
  token,
  body: {
    anonymousId: `humo-${randomUUID()}`,
    events: [
      {
        name: 'app_opened',
        occurredAt: new Date().toISOString(),
        properties: { app_platform: 'ANDROID', app_version: '0.0.0-humo' },
      },
    ],
  },
});
expectStatus('evento de la app aceptado', events, 202);

console.log('\nPrueba de humo completa.');
