import { describe, expect, it } from 'vitest';

import type { CreateOrderRequest } from '../src/domain/contracts.js';
import { ValidationError } from '../src/errors/application-error.js';
import { validateBulkOrders } from '../src/http/validation.js';

const sampleValidOrder: CreateOrderRequest = {
  order_id: 'BULK-ORD-101',
  courier_partner: 'urbanebolt',
  service_type: 'express',
  sender: {
    name: 'Sender Corp',
    phone: '+911111111111',
    street: '1 Hub Road',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400001'
  },
  recipient: {
    name: 'Recipient Corp',
    phone: '+919999999999',
    street: '10 Destination St',
    city: 'Bangalore',
    state: 'Karnataka',
    country: 'IN',
    postal_code: '560001'
  },
  package: {
    description: 'Gadgets',
    pieces: 1,
    weight: 1.5
  },
  payment: {
    mode: 'prepaid'
  }
};

describe('Bulk Order Request Validation (P8-T1)', () => {
  it('throws ValidationError when request body is not an array', () => {
    expect(() => validateBulkOrders({ not: 'an array' }, 'req-123')).toThrow(
      ValidationError
    );

    try {
      validateBulkOrders('string payload', 'req-123');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual([
        { field: 'request', message: 'Bulk request body must be an array of order items' }
      ]);
    }
  });

  it('throws ValidationError when request body is an empty array', () => {
    try {
      validateBulkOrders([], 'req-123');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual([
        { field: 'request', message: 'Bulk request body must contain at least 1 order item' }
      ]);
    }
  });

  it('throws ValidationError when request body exceeds 100 items', () => {
    const oversizedArray = Array.from({ length: 101 }, (_, index) => ({
      ...sampleValidOrder,
      order_id: `BULK-ORD-${index}`
    }));

    try {
      validateBulkOrders(oversizedArray, 'req-123');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual([
        { field: 'request', message: 'Bulk request cannot exceed 100 orders' }
      ]);
    }
  });

  it('validates each item in a valid batch of up to 100 orders', () => {
    const validBatch = Array.from({ length: 100 }, (_, index) => ({
      ...sampleValidOrder,
      order_id: `BULK-ORD-${index + 1}`
    }));

    const results = validateBulkOrders(validBatch, 'req-456');

    expect(results).toHaveLength(100);
    expect(results.every((res) => res.valid)).toBe(true);
    if (results[0].valid) {
      expect(results[0].item.order_id).toBe('BULK-ORD-1');
    }
  });

  it('reports per-order validation failures for invalid items while allowing a mixed batch to validate', () => {
    const mixedBatch = [
      sampleValidOrder,
      {
        order_id: 'BULK-ORD-INVALID',
        courier_partner: 'urbanebolt',
        // missing required sender, recipient, package, etc.
        service_type: 'express'
      },
      {
        // missing order_id entirely
        courier_partner: 'urbanebolt',
        service_type: 'express'
      }
    ];

    const results = validateBulkOrders(mixedBatch, 'req-789');

    expect(results).toHaveLength(3);

    // Item 0: valid
    expect(results[0].valid).toBe(true);
    if (results[0].valid) {
      expect(results[0].item.order_id).toBe('BULK-ORD-101');
    }

    // Item 1: invalid with explicit order_id
    expect(results[1].valid).toBe(false);
    if (!results[1].valid) {
      expect(results[1].order_id).toBe('BULK-ORD-INVALID');
      expect(results[1].failure.success).toBe(false);
      expect(results[1].failure.error.code).toBe('VALIDATION_ERROR');
      expect(results[1].failure.error.request_id).toBe('req-789');
      expect(results[1].failure.error.details.length).toBeGreaterThan(0);
    }

    // Item 2: invalid missing order_id (fallback to item_3)
    expect(results[2].valid).toBe(false);
    if (!results[2].valid) {
      expect(results[2].order_id).toBe('item_3');
      expect(results[2].failure.order_id).toBe('item_3');
      expect(results[2].failure.success).toBe(false);
      expect(results[2].failure.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
