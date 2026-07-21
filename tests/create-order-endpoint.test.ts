import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { CreateOrderRequest, CreateOrderResponse } from '../src/domain/contracts.js';
import {
  OrderIdConflictError,
  OrderInProgressError,
  UnknownCourierError
} from '../src/errors/application-error.js';
import type { createOrderService } from '../src/services/order-service.js';

type OrderService = ReturnType<typeof createOrderService>;

const validRequest: CreateOrderRequest = {
  order_id: 'ORD-3003',
  courier_partner: 'urbanebolt',
  service_type: 'express',
  sender: {
    name: 'Sender Enterprise',
    phone: '+911111111111',
    street: '1 Hub Road',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400001'
  },
  recipient: {
    name: 'Jane Smith',
    phone: '+919999999999',
    street: '10 Destination St',
    city: 'Bangalore',
    state: 'Karnataka',
    country: 'IN',
    postal_code: '560001'
  },
  package: {
    description: 'Electronics',
    pieces: 1,
    weight: 2.5
  },
  payment: {
    mode: 'PREPAID'
  }
};

const mockCreateResponse: CreateOrderResponse = {
  order_id: 'ORD-3003',
  courier_partner: 'urbanebolt',
  courier_order_id: 'UB-3003',
  tracking_number: 'AWB-3003',
  status: 'CREATED'
};

describe('POST /api/v1/orders endpoint (P4-T3)', () => {
  it('returns 201 Created with unified response fields on successful creation', async () => {
    const mockService: Partial<OrderService> = {
      createOrder: vi.fn().mockResolvedValue(mockCreateResponse)
    };

    const app = createApp({ orderService: mockService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders')
      .send(validRequest);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      order_id: 'ORD-3003',
      courier_partner: 'urbanebolt',
      courier_order_id: 'UB-3003',
      tracking_number: 'AWB-3003',
      status: 'CREATED'
    });
    expect(mockService.createOrder).toHaveBeenCalledWith(validRequest);
  });

  it('returns 400 Bad Request with field-level validation errors on invalid request payload', async () => {
    const mockService: Partial<OrderService> = {
      createOrder: vi.fn()
    };

    const app = createApp({ orderService: mockService as OrderService });

    const invalidRequest = {
      ...validRequest,
      sender: {
        ...validRequest.sender,
        phone: '' // invalid empty phone
      }
    };

    const response = await request(app)
      .post('/api/v1/orders')
      .send(invalidRequest);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'sender.phone' })
      ])
    });
    expect(mockService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 400 Bad Request with supported couriers list when courier partner is unknown', async () => {
    const mockService: Partial<OrderService> = {
      createOrder: vi.fn().mockRejectedValue(new UnknownCourierError(['delhivery', 'urbanebolt']))
    };

    const app = createApp({ orderService: mockService as OrderService });

    const unknownCourierRequest = {
      ...validRequest,
      courier_partner: 'unknown_express'
    };

    const response = await request(app)
      .post('/api/v1/orders')
      .send(unknownCourierRequest);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'UNKNOWN_COURIER',
      message: 'Courier partner is not supported',
      details: expect.arrayContaining([
        expect.objectContaining({
          field: 'courier_partner',
          supported_values: ['delhivery', 'urbanebolt']
        })
      ])
    });
  });

  it('returns unified response fields on idempotent repeat of an identical order request', async () => {
    const mockService: Partial<OrderService> = {
      createOrder: vi.fn().mockResolvedValue(mockCreateResponse)
    };

    const app = createApp({ orderService: mockService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders')
      .send(validRequest);

    expect(response.status).toBe(201);
    expect(response.body).toEqual(mockCreateResponse);
  });

  it('returns 409 Conflict when order_id is reused with conflicting parameters', async () => {
    const mockService: Partial<OrderService> = {
      createOrder: vi.fn().mockRejectedValue(new OrderIdConflictError('ORD-3003'))
    };

    const app = createApp({ orderService: mockService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders')
      .send(validRequest);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'ORDER_ID_CONFLICT',
      message: "Order ID 'ORD-3003' has already been used with different request parameters"
    });
  });

  it('returns 409 Conflict when order creation is still in progress', async () => {
    const mockService: Partial<OrderService> = {
      createOrder: vi.fn().mockRejectedValue(new OrderInProgressError('ORD-3003'))
    };

    const app = createApp({ orderService: mockService as OrderService });

    const response = await request(app)
      .post('/api/v1/orders')
      .send(validRequest);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'ORDER_IN_PROGRESS',
      message: "Order creation is already in progress for order ID 'ORD-3003'"
    });
  });
});
