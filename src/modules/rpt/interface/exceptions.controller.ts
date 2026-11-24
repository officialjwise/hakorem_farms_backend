import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { EXCEPTIONS_READ, EXCEPTIONS_REVIEW, ExceptionReports, type DailyExceptionReportView, type ExceptionItemView, type Page } from '../application/exception-reports';
import { DailyExceptionQuery, ExceptionIdParam, ExceptionListQuery, ExceptionReviewCreate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

/** The daily exception report (FR-RPT-007, FR-RPT-008, CR-059): parses and delegates; the handler authorises. */
@Controller('exceptions')
export class ExceptionsController {
  constructor(@Inject(ExceptionReports) private readonly reports: ExceptionReports) {}

  @Get()
  @Operation({ operationId: 'listExceptions', ...READ, permission: EXCEPTIONS_READ })
  listExceptions(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ExceptionListQuery)) q: z.infer<typeof ExceptionListQuery>): Promise<Page<ExceptionItemView>> {
    return this.reports.list(actor, q);
  }

  @Get('daily-report')
  @Operation({ operationId: 'getDailyExceptionReport', ...READ, permission: EXCEPTIONS_READ })
  getDailyExceptionReport(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(DailyExceptionQuery)) q: z.infer<typeof DailyExceptionQuery>): Promise<DailyExceptionReportView> {
    return this.reports.getDailyReport(actor, q);
  }

  @Post(':id/review')
  @Operation({ operationId: 'reviewException', ...WRITE, permission: EXCEPTIONS_REVIEW })
  async reviewException(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(ExceptionIdParam)) id: string,
    @Body(zodPipe(ExceptionReviewCreate)) body: z.infer<typeof ExceptionReviewCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExceptionItemView> {
    const response = await this.reports.review(actor, id, body.note, key);
    res.status(response.status);
    return response.body;
  }
}
