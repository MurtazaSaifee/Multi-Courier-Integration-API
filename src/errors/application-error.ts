import type {
  ErrorDetail,
  ErrorResponse,
  NormalizedErrorCode
} from '../domain/contracts.js';

const HTTP_STATUS_BY_CODE: Record<NormalizedErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNKNOWN_COURIER: 400,
  ORDER_NOT_FOUND: 404,
  ORDER_ID_CONFLICT: 409,
  ORDER_IN_PROGRESS: 409,
  COURIER_REJECTED: 422,
  COURIER_AUTH_FAILED: 502,
  COURIER_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500
};

export class ApplicationError extends Error {
  readonly code: NormalizedErrorCode;
  readonly details: ErrorDetail[];
  readonly statusCode: number;

  constructor(code: NormalizedErrorCode, message: string, details: ErrorDetail[] = []) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.details = details;
    this.statusCode = HTTP_STATUS_BY_CODE[code];
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toResponse(requestId: string): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        request_id: requestId
      }
    };
  }
}

export class ValidationError extends ApplicationError {
  constructor(details: ErrorDetail[]) {
    super('VALIDATION_ERROR', 'Request validation failed', details);
    this.name = 'ValidationError';
  }
}

export class OrderNotFoundError extends ApplicationError {
  constructor(orderId: string) {
    super('ORDER_NOT_FOUND', `Order '${orderId}' was not found`);
    this.name = 'OrderNotFoundError';
  }
}

export class UnknownCourierError extends ApplicationError {
  constructor(supportedCouriers: readonly string[]) {
    super('UNKNOWN_COURIER', 'Courier partner is not supported', [
      {
        field: 'courier_partner',
        message: 'Use one of the supported courier partners',
        supported_values: [...supportedCouriers]
      }
    ]);
    this.name = 'UnknownCourierError';
  }
}

export class OrderIdConflictError extends ApplicationError {
  constructor(orderId: string) {
    super(
      'ORDER_ID_CONFLICT',
      `Order ID '${orderId}' has already been used with different request parameters`
    );
    this.name = 'OrderIdConflictError';
  }
}

export class OrderInProgressError extends ApplicationError {
  constructor(orderId: string) {
    super(
      'ORDER_IN_PROGRESS',
      `Order creation is already in progress for order ID '${orderId}'`
    );
    this.name = 'OrderInProgressError';
  }
}

export class CourierRejectedError extends ApplicationError {
  constructor(message = 'The courier partner rejected the order request') {
    super('COURIER_REJECTED', message);
    this.name = 'CourierRejectedError';
  }
}

export class CourierAuthFailedError extends ApplicationError {
  constructor(message = 'Courier partner authentication failed') {
    super('COURIER_AUTH_FAILED', message);
    this.name = 'CourierAuthFailedError';
  }
}

export class CourierUnavailableError extends ApplicationError {
  constructor(message = 'Courier partner is temporarily unavailable') {
    super('COURIER_UNAVAILABLE', message);
    this.name = 'CourierUnavailableError';
  }
}

export function mapCourierProviderError(error: { kind: string }): ApplicationError {
  switch (error.kind) {
    case 'client':
      return new CourierRejectedError();
    case 'authentication':
      return new CourierAuthFailedError();
    case 'server':
    case 'timeout':
    case 'network':
    case 'not_implemented':
    default:
      return new CourierUnavailableError();
  }
}

export class InternalError extends ApplicationError {
  constructor() {
    super('INTERNAL_ERROR', 'An unexpected error occurred');
    this.name = 'InternalError';
  }
}

