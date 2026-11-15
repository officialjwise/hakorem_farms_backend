import { Body, Controller, Get, Inject, Param, Post, Res, UploadedFile, UseInterceptors, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { PayloadTooLargeError, ValidationFailedError } from '../../../platform/errors/api-error';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { translate } from '../../../platform/i18n/messages';
import { Files, type SignedUrlView, type StoredFileView } from '../application/files';
import { FILE_PURPOSES, LARGEST_CAP_BYTES } from '../domain/file-use';

/** The multipart envelope around the file: boundaries, part headers and the purpose field. */
const MULTIPART_OVERHEAD_BYTES = 16_384;

/** The file part multer hands over, read into memory under the largest cap. */
interface UploadedPart {
  readonly buffer: Buffer;
  readonly originalname: string;
}

const UploadFields = z.strictObject({ purpose: z.enum(FILE_PURPOSES) });
const IdParam = z.uuid();

/**
 * Refuses a declared body over the largest cap before a byte of it is read (SC-12). A body that does not declare
 * its length, or lies about it, is cut off by multer's limit while it streams, still before it is read in full.
 */
class DeclaredLengthCap implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const declared = Number(context.switchToHttp().getRequest<Request>().header('content-length') ?? '0');
    if (declared > LARGEST_CAP_BYTES + MULTIPART_OVERHEAD_BYTES) {
      throw new PayloadTooLargeError(`declared body of ${declared} bytes is over the upload cap`);
    }
    return next.handle();
  }
}

/** The file store's routes (FR-DOC-006, FR-DOC-007, ADR-0044). The controller parses and delegates; Files authorises. */
@Controller('files')
export class FilesController {
  constructor(@Inject(Files) private readonly files: Files) {}

  @Post()
  @Operation({ operationId: 'uploadFile', access: 'SESSION', realms: ['STAFF', 'CUSTOMER', 'INVESTOR'], permission: 'platform.file.upload', idempotent: true, csrf: true, rateLimit: 'console' })
  @UseInterceptors(DeclaredLengthCap, FileInterceptor('file', { limits: { fileSize: LARGEST_CAP_BYTES, files: 1, fields: 1, parts: 2 } }))
  async uploadFile(
    @CurrentActor() actor: Actor | undefined,
    @UploadedFile() file: UploadedPart | undefined,
    @Body(zodPipe(UploadFields)) body: z.infer<typeof UploadFields>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StoredFileView> {
    if (file === undefined) {
      throw new ValidationFailedError('no file part', [{ field: '/file', code: 'REQUIRED', message: translate('error.field_required') }]);
    }
    const response = await this.files.uploadFile(actor, body.purpose, { content: file.buffer, originalName: file.originalname }, key);
    res.status(response.status);
    return response.body;
  }

  @Get(':id')
  @Operation({ operationId: 'getFile', access: 'SESSION', realms: ['STAFF', 'CUSTOMER', 'INVESTOR'], permission: 'platform.file.read', idempotent: false, csrf: false, rateLimit: 'console' })
  getFile(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<StoredFileView> {
    return this.files.getFile(actor, id);
  }

  @Post(':id/signed-url')
  @Operation({ operationId: 'createFileSignedUrl', access: 'SESSION', realms: ['STAFF', 'CUSTOMER', 'INVESTOR'], permission: 'platform.file.read', idempotent: false, csrf: true, rateLimit: 'console' })
  async createFileSignedUrl(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Res({ passthrough: true }) res: Response): Promise<SignedUrlView> {
    const link = await this.files.createFileSignedUrl(actor, id);
    res.status(200);
    return link;
  }
}
