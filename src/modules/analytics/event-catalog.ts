/** Valores que admite una propiedad de evento: nunca objetos ni listas. */
export type EventProperties = Record<string, string | number | boolean | null>;

/** Eventos que escribe la propia API al ocurrir el hecho (08_ANALYTICS_VALIDATION.md seccion 2). */
export type ServerEventName =
  | 'vehicle_setup_completed'
  | 'quote_preview_requested'
  | 'quote_preview_succeeded'
  | 'quote_preview_failed'
  | 'quote_saved'
  | 'quote_decision_recorded'
  | 'subscription_activated'
  | 'subscription_renewed'
  | 'subscription_cancelled'
  | 'subscription_refunded'
  | 'account_deleted';

/**
 * Eventos de operacion (errores, cuota, compras): se guardan aunque el usuario haya desactivado
 * analytics. Todos los demas son de producto y respetan esa eleccion (06_SECURITY_PRIVACY.md seccion 7).
 */
const ESSENTIAL_EVENTS: ReadonlySet<string> = new Set<ServerEventName>([
  'quote_preview_failed',
  'subscription_activated',
  'subscription_renewed',
  'subscription_cancelled',
  'subscription_refunded',
  'account_deleted',
]);

export const isEssential = (name: string): boolean => ESSENTIAL_EVENTS.has(name);

/** Eventos que la app puede enviar por POST /events, con las propiedades que admite cada uno. */
const CLIENT_EVENTS = new Map<string, readonly string[]>([
  ['app_opened', ['app_platform', 'app_version']],
  ['onboarding_started', ['acquisition_source', 'app_platform', 'app_version']],
  ['paywall_viewed', ['trigger', 'experiment_variant']],
  ['subscription_started', ['store', 'product_id', 'price_variant']],
]);

/** Una propiedad es una etiqueta corta, no un campo de texto libre. */
const MAX_TEXT_LENGTH = 64;

/** Esquema AnalyticsEvent de openapi.yaml. Llega ya validado en forma por ContractGuard. */
export interface ClientEvent {
  name: string;
  version?: number;
  occurredAt: string;
  properties?: EventProperties;
}

export interface AcceptedEvent {
  name: string;
  version: number;
  occurredAt: Date;
  properties: EventProperties;
}

/**
 * Lo que se guarda de un evento enviado por la app. Un nombre fuera de la lista descarta el evento
 * (null); de un evento permitido se descartan las propiedades que no le corresponden. Una fecha
 * futura (reloj del telefono adelantado) se guarda como la hora de llegada.
 */
export function sanitizeClientEvent(event: ClientEvent, now: Date): AcceptedEvent | null {
  const allowed = CLIENT_EVENTS.get(event.name);
  if (!allowed) {
    return null;
  }
  const properties: EventProperties = {};
  for (const key of allowed) {
    const value = event.properties?.[key];
    if (value === undefined || (typeof value === 'string' && value.length > MAX_TEXT_LENGTH)) {
      continue;
    }
    properties[key] = value;
  }
  const occurredAt = new Date(event.occurredAt);
  return {
    name: event.name,
    version: event.version ?? 1,
    occurredAt: occurredAt.getTime() > now.getTime() ? now : occurredAt,
    properties,
  };
}
