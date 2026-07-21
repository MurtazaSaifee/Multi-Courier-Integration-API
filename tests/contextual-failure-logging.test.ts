import { describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '../src/errors/application-error.js';
import { logFailure } from '../src/logging/logger.js';

describe('Contextual Failure Logging (P7-T4)', () => {
  it('logs failure with order ID, courier partner, request ID, error type, and error code', () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const error = new ApplicationError('COURIER_REJECTED', 'Courier rejected shipment');

      logFailure(error, {
        request_id: 'req-12345',
        order_id: 'ORD-999',
        courier_partner: 'urbanebolt'
      });

      expect(logSpy).toHaveBeenCalledTimes(1);

      const logEntry = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(logEntry).toEqual({
        level: 'error',
        event: 'request_failed',
        request_id: 'req-12345',
        order_id: 'ORD-999',
        courier_partner: 'urbanebolt',
        error_code: 'COURIER_REJECTED',
        error_type: 'ApplicationError'
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('includes stack trace for unexpected errors while omitting stack trace for operational ApplicationErrors', () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // Unexpected system error
      const unexpectedError = new TypeError('Cannot read properties of undefined');
      logFailure(unexpectedError, { request_id: 'req-unexp' });

      const unexpectedLog = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(unexpectedLog.error_type).toBe('TypeError');
      expect(unexpectedLog.stack).toBeDefined();
      expect(typeof unexpectedLog.stack).toBe('string');

      logSpy.mockClear();

      // Operational error
      const appError = new ApplicationError('ORDER_NOT_FOUND', 'Order not found');
      logFailure(appError, { request_id: 'req-app' });

      const appLog = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(appLog.error_type).toBe('ApplicationError');
      expect(appLog.stack).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('excludes raw personal data, credentials, and access tokens from logged fields', () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const error = new Error('Secret password=super-secret-token-12345');

      logFailure(error, {
        request_id: 'req-safe',
        order_id: 'ORD-SAFE-1',
        courier_partner: 'urbanebolt'
      });

      const loggedString = String(logSpy.mock.calls[0][0]);
      const logEntry = JSON.parse(loggedString);

      // Verify log entry contains only safe metadata keys
      const loggedKeys = Object.keys(logEntry).sort();
      expect(loggedKeys).toEqual([
        'courier_partner',
        'error_type',
        'event',
        'level',
        'order_id',
        'request_id',
        'stack'
      ]);

      expect(loggedString).not.toContain('super-secret-token');
      expect(logEntry).not.toHaveProperty('password');
      expect(logEntry).not.toHaveProperty('token');
      expect(logEntry).not.toHaveProperty('recipient');
    } finally {
      logSpy.mockRestore();
    }
  });
});
