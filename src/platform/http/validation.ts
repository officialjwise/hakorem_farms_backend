import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ValidationFailedError, type ErrorDetail } from '../errors/api-error';
import { translate } from '../i18n/messages';

/** A JSON pointer (RFC 6901) to the offending input, as the error envelope's `details[].field` carries it. */
function pointer(path: readonly PropertyKey[]): string | null {
  if (path.length === 0) {
    return null;
  }
  return `/${path.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function detailsOf(error: z.ZodError, prefix: readonly PropertyKey[]): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        details.push({ field: pointer([...prefix, ...issue.path, key]), code: 'UNKNOWN_FIELD', message: translate('error.field_unknown') });
      }
      continue;
    }
    const missing = issue.code === 'invalid_type' && issue.input === undefined;
    details.push({
      field: pointer([...prefix, ...issue.path]),
      code: missing ? 'REQUIRED' : issue.code.toUpperCase(),
      message: translate(missing ? 'error.field_required' : 'error.field_invalid'),
    });
  }
  return details;
}

/**
 * Parses a value against a schema at the boundary (SC-01): every offending field is listed at once, unknown fields
 * are refused when the schema is strict, and only the parsed, typed value travels inward.
 */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, prefix: readonly PropertyKey[] = []): z.infer<S> {
  const parsed = schema.safeParse(value, { reportInput: true });
  if (!parsed.success) {
    throw new ValidationFailedError('request failed validation', detailsOf(parsed.error, prefix));
  }
  return parsed.data;
}

/** A Nest pipe for `@Body()` and `@Query()`. Body schemas are `z.strictObject`, so unknown fields are refused. */
export function zodPipe<S extends z.ZodType>(schema: S): PipeTransform<unknown, z.infer<S>> {
  return { transform: (value: unknown) => parseOrThrow(schema, value) };
}
