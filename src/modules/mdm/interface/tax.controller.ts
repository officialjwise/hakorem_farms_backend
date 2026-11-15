import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { TaxAdmin, type Page, type TaxApprovalPendingView, type TaxCategoryView, type TaxLevyView, type TaxSchemeVersionView } from '../application/tax-admin';
import { TaxService, type TaxCalculationResultView } from '../application/tax-calculation';
import { IdParam, PageQuery, TaxCalculationRequest, TaxCategoryCreate, TaxCellsReplace, TaxLevyCreate, TaxSchemeVersionCreate } from './schemas';

/**
 * Tax configuration and calculation (FR-MDM-012 to FR-MDM-014, ADR-0020). The controller parses and delegates; the
 * handlers authorise, do the work and decide the status: 201 on create, 200 on replace, 202 `ApprovalPending` on submit.
 */
@Controller('tax')
export class TaxController {
  constructor(
    @Inject(TaxAdmin) private readonly admin: TaxAdmin,
    @Inject(TaxService) private readonly tax: TaxService,
  ) {}

  @Get('levies')
  @Operation({ operationId: 'listTaxLevies', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.read', idempotent: false, csrf: false, rateLimit: 'console' })
  listTaxLevies(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<TaxLevyView>> {
    return this.admin.listLevies(actor, query.cursor, query.limit);
  }

  @Post('levies')
  @Operation({ operationId: 'createTaxLevy', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.manage', idempotent: true, csrf: true, rateLimit: 'console' })
  async createTaxLevy(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(TaxLevyCreate)) body: z.infer<typeof TaxLevyCreate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaxLevyView> {
    const response = await this.admin.createLevy(actor, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get('categories')
  @Operation({ operationId: 'listTaxCategories', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.read', idempotent: false, csrf: false, rateLimit: 'console' })
  listTaxCategories(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<TaxCategoryView>> {
    return this.admin.listCategories(actor, query.cursor, query.limit);
  }

  @Post('categories')
  @Operation({ operationId: 'createTaxCategory', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.manage', idempotent: true, csrf: true, rateLimit: 'console' })
  async createTaxCategory(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(TaxCategoryCreate)) body: z.infer<typeof TaxCategoryCreate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaxCategoryView> {
    const response = await this.admin.createCategory(actor, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get('scheme-versions')
  @Operation({ operationId: 'listTaxSchemeVersions', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.read', idempotent: false, csrf: false, rateLimit: 'console' })
  listTaxSchemeVersions(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(PageQuery)) query: z.infer<typeof PageQuery>): Promise<Page<TaxSchemeVersionView>> {
    return this.admin.listVersions(actor, query.cursor, query.limit);
  }

  @Post('scheme-versions')
  @Operation({ operationId: 'createTaxSchemeVersion', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.manage', idempotent: true, csrf: true, rateLimit: 'console' })
  async createTaxSchemeVersion(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(TaxSchemeVersionCreate)) body: z.infer<typeof TaxSchemeVersionCreate>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaxSchemeVersionView> {
    const response = await this.admin.createVersion(actor, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Get('scheme-versions/:id')
  @Operation({ operationId: 'getTaxSchemeVersion', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.read', idempotent: false, csrf: false, rateLimit: 'console' })
  getTaxSchemeVersion(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<TaxSchemeVersionView> {
    return this.admin.getVersion(actor, id);
  }

  @Put('scheme-versions/:id/cells')
  @Operation({ operationId: 'replaceTaxSchemeCells', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.manage', idempotent: true, csrf: true, rateLimit: 'console' })
  async replaceTaxSchemeCells(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(TaxCellsReplace)) body: z.infer<typeof TaxCellsReplace>,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaxSchemeVersionView> {
    const response = await this.admin.replaceCells(actor, id, body, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  @Post('scheme-versions/:id/submit')
  @Operation({ operationId: 'submitTaxSchemeVersion', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.manage', idempotent: true, csrf: true, rateLimit: 'console' })
  async submitTaxSchemeVersion(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaxApprovalPendingView> {
    const response = await this.admin.submit(actor, id, idempotencyKey);
    res.status(response.status);
    return response.body;
  }

  /** Read-only, so no idempotency key; a cookie-authenticated POST, so CSRF. */
  @Post('calculate')
  @HttpCode(200)
  @Operation({ operationId: 'calculateTax', access: 'SESSION', realms: ['STAFF'], permission: 'mdm.tax.calculate', idempotent: false, csrf: true, rateLimit: 'console' })
  calculateTax(@CurrentActor() actor: Actor | undefined, @Body(zodPipe(TaxCalculationRequest)) body: z.infer<typeof TaxCalculationRequest>): Promise<TaxCalculationResultView> {
    return this.tax.calculate(actor, body);
  }
}
