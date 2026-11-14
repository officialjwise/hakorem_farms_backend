import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { currentRequestContext } from '../context/request-context';
import { toErrorEnvelope } from './error-envelope';

/** Catches everything a route or the router raises and answers with the one error envelope. */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = currentRequestContext()?.correlationId ?? String(response.getHeader('X-Correlation-Id'));
    const { status, envelope } = toErrorEnvelope(exception, correlationId, this.logger);
    response.status(status).json(envelope);
  }
}
