import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import {
  ApplicationError,
  InternalError,
  ValidationError
} from '../errors/application-error.js';
import { logFailure } from '../logging/logger.js';
import { getRequestId } from './request-id.js';
import { zodIssuesToDetails } from './validation.js';

function isMalformedJsonError(error: unknown): error is SyntaxError {
  return error instanceof SyntaxError && 'body' in error;
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const requestId = getRequestId(request, response);

  const normalizedError = error instanceof ApplicationError
    ? error
    : error instanceof ZodError
      ? new ValidationError(zodIssuesToDetails(error))
      : isMalformedJsonError(error)
        ? new ValidationError([{ field: 'request', message: 'Request body contains invalid JSON' }])
        : new InternalError();

  logFailure(error, {
    request_id: requestId,
    error_code: normalizedError.code,
    ...(typeof request.params.order_id === 'string' ? { order_id: request.params.order_id } : {}),
    ...(typeof request.body?.courier_partner === 'string'
      ? { courier_partner: request.body.courier_partner }
      : {})
  });

  response.status(normalizedError.statusCode).json(normalizedError.toResponse(requestId));
};
