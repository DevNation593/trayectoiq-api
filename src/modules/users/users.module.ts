import { Module } from '@nestjs/common';
import { MeController } from './me.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [MeController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
