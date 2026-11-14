import { Controller, Get, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ServiceUnavailableError } from '../errors/api-error';
import { translate } from '../i18n/messages';
import { HealthService, type HealthReport } from './health.service';

/** A dependency the health report found down, listed in the 503 envelope's details. */
export class DependencyDownError extends ServiceUnavailableError {}

/**
 * `GET /v1/health` (operationId `getHealth`). Its contract definition stays in the planned contract until
 * B3 adds the outbox, audit and reconciliation checks the definition describes (ADR-0030); the response
 * shape is checked against the committed contract by the contract test.
 */
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  async getHealth(): Promise<HealthReport> {
    const report = await this.health.report();
    if (report.status === 'DOWN') {
      const down = report.checks.filter((check) => check.status === 'DOWN');
      throw new DependencyDownError(
        'a dependency is down',
        down.map((check) => ({ field: null, code: `${check.name.toUpperCase()}_DOWN`, message: translate('error.dependency_down') })),
      );
    }
    return report;
  }
}
