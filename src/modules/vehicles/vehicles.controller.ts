import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { type AuthContext, CurrentAuth } from '../../shared/auth/auth-context.js';
import { Operation } from '../../shared/contract/contract.guard.js';
import type { VehicleDto, VehicleInput } from './vehicle.dto.js';
import { VehiclesService } from './vehicles.service.js';

@Controller('vehicles')
export class VehiclesController {
  constructor(@Inject(VehiclesService) private readonly vehicles: VehiclesService) {}

  @Get()
  @Operation('listVehicles')
  list(@CurrentAuth() auth: AuthContext): Promise<VehicleDto[]> {
    return this.vehicles.list(auth.userId);
  }

  @Post()
  @Operation('createVehicle')
  create(@CurrentAuth() auth: AuthContext, @Body() body: VehicleInput): Promise<VehicleDto> {
    return this.vehicles.create(auth.userId, body);
  }

  @Get(':vehicleId')
  @Operation('getVehicle')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('vehicleId') vehicleId: string,
  ): Promise<VehicleDto> {
    return this.vehicles.get(auth.userId, vehicleId);
  }

  @Put(':vehicleId')
  @Operation('updateVehicle')
  replace(
    @CurrentAuth() auth: AuthContext,
    @Param('vehicleId') vehicleId: string,
    @Body() body: VehicleInput,
  ): Promise<VehicleDto> {
    return this.vehicles.replace(auth.userId, vehicleId, body);
  }

  @Delete(':vehicleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Operation('archiveVehicle')
  archive(@CurrentAuth() auth: AuthContext, @Param('vehicleId') vehicleId: string): Promise<void> {
    return this.vehicles.archive(auth.userId, vehicleId);
  }
}
