import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { Operation } from '../contract/contract.guard.js';
import { AppConfigService } from './app-config.service.js';

interface PublicAppConfig {
  maintenanceMode: boolean;
  trialQuoteLimit: number;
  minIosVersion: string;
  minAndroidVersion: string;
  publicFlags: Record<string, unknown>;
  costPresets: Record<string, unknown>;
}

/** Lo que la app consulta al iniciar, antes de tener sesion (02_PRD_MVP.md RF-16). */
@Controller('app-config')
export class AppConfigController {
  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  @Public()
  @Get()
  @Operation('getAppConfig')
  async get(): Promise<PublicAppConfig> {
    const settings = await this.config.load();
    return {
      maintenanceMode: settings.maintenanceMode,
      trialQuoteLimit: settings.trialQuoteLimit,
      minIosVersion: settings.minIosVersion,
      minAndroidVersion: settings.minAndroidVersion,
      publicFlags: {},
      costPresets: settings.costPresets,
    };
  }
}
