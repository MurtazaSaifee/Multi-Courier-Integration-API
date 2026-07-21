import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createOrderRequestSchema } from '../src/http/schemas.js';
import { errorHandler } from '../src/http/error-handler.js';
import { requestIdMiddleware } from '../src/http/request-id.js';
import { validateBody } from '../src/http/validation.js';
import { UnknownCourierError } from '../src/errors/application-error.js';

function createErrorTestApp() {
  const app = express();

  app.use(requestIdMiddleware);
  app.use(express.json());
  app.post('/validate', validateBody(createOrderRequestSchema), (_request, response) => {
    response.status(204).end();
  });
  app.get('/unknown-courier', (_request, _response, next) => {
    next(new UnknownCourierError(['urbanebolt', 'mockcourier']));
  });
  app.get('/unexpected', (_request, _response, next) => {
    next(new Error('password=should-not-be-logged'));
  });
  app.post('/unexpected-order', (_request, _response, next) => {
    next(new Error('provider failure'));
  });
  app.use(errorHandler);

  return app;
}

const validOrderWithInvalidRecipient = {
  order_id: 'order-1',
  courier_partner: 'urbanebolt',
  service_type: 'standard',
  sender: {
    name: 'Sender',
    phone: '1234567890',
    street: '1 Sender Street',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400001'
  },
  recipient: {
    name: 'Recipient',
    phone: '',
    street: '2 Recipient Street',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400002'
  },
  package: {
    description: 'Parcel',
    pieces: 1,
    weight: 1
  },
  payment: {
    mode: 'PREPAID'
  }
};

describe('request validation and normalized errors', () => {
  it('returns field-level validation details with a request ID', async () => {
    const response = await request(createErrorTestApp())
      .post('/validate')
      .send(validOrderWithInvalidRecipient);

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error).sort()).toEqual([
      'code',
      'details',
      'message',
      'request_id'
    ]);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toContainEqual({
      field: 'recipient.phone',
      message: 'Too small: expected string to have >=1 characters'
    });
    expect(response.body.error.request_id).toBe(response.headers['x-request-id']);
  });

  it('returns supported couriers in the same normalized error envelope', async () => {
    const response = await request(createErrorTestApp())
      .get('/unknown-courier')
      .set('x-request-id', 'request-from-test');

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error).sort()).toEqual([
      'code',
      'details',
      'message',
      'request_id'
    ]);
    expect(response.body.error.code).toBe('UNKNOWN_COURIER');
    expect(response.body.error.details).toEqual([
      {
        field: 'courier_partner',
        message: 'Use one of the supported courier partners',
        supported_values: ['urbanebolt', 'mockcourier']
      }
    ]);
    expect(response.body.error.request_id).toBe('request-from-test');
    expect(response.headers['x-request-id']).toBe('request-from-test');
  });

  it('does not log an unexpected error message or token-like value', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await request(createErrorTestApp()).get('/unexpected');

      expect(response.status).toBe(500);
      expect(response.body.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred'
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).not.toContain('password=should-not-be-logged');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('includes the create request order ID in failure logs', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await request(createErrorTestApp())
        .post('/unexpected-order')
        .send({ order_id: 'order-log-1', courier_partner: 'urbanebolt' });

      expect(response.status).toBe(500);
      expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
        order_id: 'order-log-1',
        courier_partner: 'urbanebolt'
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});
