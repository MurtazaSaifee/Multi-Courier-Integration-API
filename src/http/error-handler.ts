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
  const errContext = (error as any)?.context;
  const orderId = errContext?.order_id || (
    typeof request.params.order_id === 'string'
      ? request.params.order_id
      : typeof request.body?.order_id === 'string'
        ? request.body.order_id
        : undefined
  );
  const courierPartner = errContext?.courier_partner || (
    typeof request.body?.courier_partner === 'string'
      ? request.body.courier_partner
      : undefined
  );

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
    ...(orderId === undefined ? {} : { order_id: orderId }),
    ...(courierPartner === undefined ? {} : { courier_partner: courierPartner })
  });

  response.status(normalizedError.statusCode).json(normalizedError.toResponse(requestId));
};
