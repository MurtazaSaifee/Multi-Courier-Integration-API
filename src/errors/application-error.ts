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

export class InternalError extends ApplicationError {
  constructor() {
    super('INTERNAL_ERROR', 'An unexpected error occurred');
    this.name = 'InternalError';
  }
}
