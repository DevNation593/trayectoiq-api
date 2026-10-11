/** Estado de un proveedor externo, para GET /admin/providers/health y las alertas. */
export interface ProviderHealth {
  provider: string;
  status: 'up' | 'down';
  latencyMs: number;
  detail?: string;
}
