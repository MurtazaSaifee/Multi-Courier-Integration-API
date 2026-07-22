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

export type PrivateLogContext = {
  order_id?: string;
  courier_partner?: string;
  request_id?: string;
};

export function attachErrorContext<T>(
  error: T,
  context: PrivateLogContext
): T {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') {
    return error;
  }

  const existing = (error as T & { context?: PrivateLogContext }).context || {};
  Object.defineProperty(error, 'context', {
    value: { ...existing, ...context },
    writable: true,
    enumerable: false,
    configurable: true
  });
  return error;
}

export class ApplicationError extends Error {
  readonly code: NormalizedErrorCode;
  readonly details: ErrorDetail[];
  readonly statusCode: number;
  context?: PrivateLogContext;

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
  let mapped: ApplicationError;
  switch (error.kind) {
    case 'client':
      mapped = new CourierRejectedError();
      break;
    case 'authentication':
      mapped = new CourierAuthFailedError();
      break;
    case 'server':
    case 'timeout':
    case 'network':
    case 'not_implemented':
    default:
      mapped = new CourierUnavailableError();
      break;
  }
  if ((error as any).context) {
    attachErrorContext(mapped, (error as any).context);
  }
  return mapped;
}

export class InternalError extends ApplicationError {
  constructor() {
    super('INTERNAL_ERROR', 'An unexpected error occurred');
    this.name = 'InternalError';
  }
}
