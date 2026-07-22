import { describe, expect, it } from 'vitest';

import { MockCourierAdapter, MOCK_COURIER_PARTNER } from '../src/couriers/mockcourier/mockcourier-adapter.js';
import { courierRegistry } from '../src/couriers/courier-registry.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';

const mockCreateRequest: CreateOrderRequest = {
  order_id: 'MOCK-TEST-001',
  courier_partner: 'mockcourier',
  service_type: 'standard',
  sender: {
    name: 'Sender Co',
    phone: '+919999999999',
    email: 'sender@example.com',
    street: '123 Main St',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400001'
  },
  recipient: {
    name: 'Recipient Person',
    phone: '+918888888888',
    email: 'recipient@example.com',
    street: '456 Cross Rd',
    city: 'Delhi',
    state: 'Delhi',
    country: 'IN',
    postal_code: '110001'
  },
  package: {
    description: 'Test Item',
    pieces: 1,
    weight: 0.5,
    length: 10,
    breadth: 10,
    height: 10
  },
  payment: {
    mode: 'PREPAID',
    amount_to_collect: 0
  }
};

describe('MockCourierAdapter Unit Tests (P11-T2)', () => {
  it('has the correct courierPartner identifier', () => {
    const adapter = new MockCourierAdapter();
    expect(adapter.courierPartner).toBe('mockcourier');
    expect(MOCK_COURIER_PARTNER).toBe('mockcourier');
  });

  it('creates shipment with normalized shape and raw payload capture', async () => {
    const adapter = new MockCourierAdapter();
    const result = await adapter.createShipment(mockCreateRequest);

    expect(result.response).toEqual({
      order_id: 'MOCK-TEST-001',
      courier_partner: 'mockcourier',
      courier_order_id: 'MOCK-ORD-MOCK-TEST-001',
      tracking_number: 'MOCK-TRK-MOCK-TEST-001',
      status: 'CREATED'
    });
    expect(result.raw_request).toBeDefined();
    expect(result.raw_response).toEqual({
      status: 'SUCCESS',
      tracking_number: 'MOCK-TRK-MOCK-TEST-001',
      courier_order_id: 'MOCK-ORD-MOCK-TEST-001'
    });
  });

  it('tracks shipment with normalized events and in-transit status', async () => {
    const adapter = new MockCourierAdapter();
    const result = await adapter.trackShipment({ tracking_number: 'MOCK-TRK-MOCK-TEST-001' });

    expect(result.response.courier_partner).toBe('mockcourier');
    expect(result.response.tracking_number).toBe('MOCK-TRK-MOCK-TEST-001');
    expect(result.response.status).toBe('IN_TRANSIT');
    expect(result.response.events).toHaveLength(2);
    expect(result.response.events[0].status).toBe('CREATED');
    expect(result.response.events[1].status).toBe('IN_TRANSIT');
    expect(result.raw_response).toEqual({
      status: 'SUCCESS',
      tracking_number: 'MOCK-TRK-MOCK-TEST-001'
    });
  });

  it('cancels shipment with normalized cancelled status', async () => {
    const adapter = new MockCourierAdapter();
    const result = await adapter.cancelShipment({ tracking_number: 'MOCK-TRK-MOCK-TEST-001' });

    expect(result.response).toEqual({
      order_id: 'MOCK-TEST-001',
      courier_partner: 'mockcourier',
      tracking_number: 'MOCK-TRK-MOCK-TEST-001',
      status: 'CANCELLED'
    });
    expect(result.raw_response).toEqual({
      status: 'SUCCESS',
      message: 'Cancelled'
    });
  });
});

describe('MockCourier Courier Registry Integration (P11-T1 & P11-T2)', () => {
  it('resolves MockCourierAdapter from the global courier registry', () => {
    const adapter = courierRegistry.resolve('mockcourier');
    expect(adapter).toBeInstanceOf(MockCourierAdapter);
    expect(adapter.courierPartner).toBe('mockcourier');
  });

  it('includes mockcourier in supported couriers list', () => {
    expect(courierRegistry.supportedCouriers()).toContain('mockcourier');
  });
});
