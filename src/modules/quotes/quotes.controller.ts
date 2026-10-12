import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type AuthContext, CurrentAuth } from '../../shared/auth/auth-context.js';
import { Operation } from '../../shared/contract/contract.guard.js';
import { RateLimit } from '../../shared/rate-limit/rate-limit.guard.js';
import type { PreviewRequest, PreviewResponse } from './quote.dto.js';
import { QuotesService } from './quotes.service.js';

@Controller('quotes')
export class QuotesController {
  constructor(@Inject(QuotesService) private readonly quotes: QuotesService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Operation('previewQuote')
  @RateLimit('preview')
  async preview(
    @CurrentAuth() auth: AuthContext,
    @Body() body: PreviewRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PreviewResponse> {
    const response = await this.quotes.preview(auth, body);
    void reply.header('x-quote-request-id', response.quoteRequestId);
    return response;
  }
}
