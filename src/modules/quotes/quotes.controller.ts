import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { type AuthContext, CurrentAuth } from '../../shared/auth/auth-context.js';
import { Operation } from '../../shared/contract/contract.guard.js';
import { RateLimit } from '../../shared/rate-limit/rate-limit.guard.js';
import type { PreviewRequest, PreviewResponse } from './quote.dto.js';
import { QuotesService } from './quotes.service.js';
import { type SavedQuoteDto, toSavedQuoteDto } from './saved-quote.dto.js';
import { SavedQuotesService } from './saved-quotes.service.js';

@Controller('quotes')
export class QuotesController {
  constructor(
    @Inject(QuotesService) private readonly quotes: QuotesService,
    @Inject(SavedQuotesService) private readonly saved: SavedQuotesService,
  ) {}

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

  @Post()
  @Operation('saveQuote')
  async save(
    @CurrentAuth() auth: AuthContext,
    @Body() body: { previewToken: string },
  ): Promise<SavedQuoteDto> {
    const { quote } = await this.saved.save(auth.userId, body.previewToken);
    return toSavedQuoteDto(quote);
  }

  @Get()
  @Operation('listQuotes')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: { cursor?: string; limit?: string },
  ): Promise<{ items: SavedQuoteDto[]; nextCursor: string | null }> {
    const { items, nextCursor } = await this.saved.list(auth.userId, {
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    });
    return { items: items.map(toSavedQuoteDto), nextCursor };
  }

  @Get(':quoteId')
  @Operation('getQuote')
  async get(
    @CurrentAuth() auth: AuthContext,
    @Param('quoteId') quoteId: string,
  ): Promise<SavedQuoteDto> {
    return toSavedQuoteDto(await this.saved.find(auth.userId, quoteId));
  }
}
