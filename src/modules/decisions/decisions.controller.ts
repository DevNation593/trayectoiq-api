import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { type AuthContext, CurrentAuth } from '../../shared/auth/auth-context.js';
import { Operation } from '../../shared/contract/contract.guard.js';
import { type DecisionDto, toDecisionDto } from '../quotes/saved-quote.dto.js';
import { type DecisionInput, DecisionsService } from './decisions.service.js';

@Controller('quotes/:quoteId/decision')
export class DecisionsController {
  constructor(@Inject(DecisionsService) private readonly decisions: DecisionsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Operation('recordQuoteDecision')
  async record(
    @CurrentAuth() auth: AuthContext,
    @Param('quoteId') quoteId: string,
    @Body() body: DecisionInput,
  ): Promise<DecisionDto> {
    const { decision } = await this.decisions.record(auth.userId, quoteId, body);
    return toDecisionDto(decision);
  }
}
