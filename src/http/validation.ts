import { z } from 'zod';

import type {
  BulkOrderFailure,
  CreateOrderRequest,
  ErrorDetail
} from '../domain/contracts.js';
import { ValidationError } from '../errors/application-error.js';
import { createOrderRequestSchema } from './schemas.js';

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

export type BulkItemValidationResult =
  | { valid: true; item: CreateOrderRequest }
  | {
      valid: false;
      order_id: string;
      courier_partner?: string;
      failure: BulkOrderFailure;
    };

export function validateBulkOrders(
  body: unknown,
  requestId: string
): BulkItemValidationResult[] {
  if (!Array.isArray(body)) {
    throw new ValidationError([
      { field: 'request', message: 'Bulk request body must be an array of order items' }
    ]);
  }

  if (body.length === 0) {
    throw new ValidationError([
      { field: 'request', message: 'Bulk request body must contain at least 1 order item' }
    ]);
  }

  if (body.length > 100) {
    throw new ValidationError([
      { field: 'request', message: 'Bulk request cannot exceed 100 orders' }
    ]);
  }

  return body.map((item, index) => {
    const result = createOrderRequestSchema.safeParse(item);
    if (result.success) {
      return {
        valid: true,
        item: result.data as CreateOrderRequest
      };
    }

    const itemRecord =
      typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>)
        : null;

    const rawId =
      itemRecord &&
      typeof itemRecord.order_id === 'string' &&
      itemRecord.order_id.trim().length > 0
        ? itemRecord.order_id.trim()
        : `item_${index + 1}`;

    const rawCourierPartner =
      itemRecord &&
      typeof itemRecord.courier_partner === 'string' &&
      itemRecord.courier_partner.trim().length > 0
        ? itemRecord.courier_partner.trim()
        : undefined;

    return {
      valid: false,
      order_id: rawId,
      ...(rawCourierPartner === undefined ? {} : { courier_partner: rawCourierPartner }),
      failure: {
        order_id: rawId,
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: zodIssuesToDetails(result.error),
          request_id: requestId
        }
      }
    };
  });
}
