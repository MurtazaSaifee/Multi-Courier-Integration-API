import { z } from 'zod';

import type { ErrorDetail } from '../domain/contracts.js';
import { ValidationError } from '../errors/application-error.js';

export function zodIssuesToDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'request',
    message: issue.message
  }));
}

export function validateBody(schema: z.ZodType): import('express').RequestHandler {
  return (request, _response, next) => {
    const result = schema.safeParse(request.body);

    if (!result.success) {
      next(new ValidationError(zodIssuesToDetails(result.error)));
      return;
    }

    request.body = result.data;
    next();
  };
}
