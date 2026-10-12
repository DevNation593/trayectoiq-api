import { Module } from '@nestjs/common';
import { QuotesModule } from '../quotes/quotes.module.js';
import { DecisionsController } from './decisions.controller.js';
import { DecisionsService } from './decisions.service.js';

@Module({
  imports: [QuotesModule],
  controllers: [DecisionsController],
  providers: [DecisionsService],
})
export class DecisionsModule {}
