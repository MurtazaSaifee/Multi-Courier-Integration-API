import type { CreateOrderRequest } from '../../src/domain/contracts.js';

export function createSampleOrderRequest(
  overrides?: Partial<CreateOrderRequest>
): CreateOrderRequest {
  return {
    order_id: 'ORDER-1001',
    courier_partner: 'urbanebolt',
    service_type: 'express',
    sender: {
      name: 'Warehouse Inc',
      phone: '+911111111111',
      email: 'warehouse@example.com',
      street: '1 Industrial Way',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'IN',
      postal_code: '400001'
    },
    recipient: {
      name: 'Jane Doe',
      phone: '+919999999999',
      street: '10 Residential Ave',
      city: 'Pune',
      state: 'Maharashtra',
      country: 'IN',
      postal_code: '411001'
    },
    package: {
      description: 'Tech Gadgets',
      pieces: 1,
      weight: 0.5
    },
    payment: {
      mode: 'PREPAID'
    },
    ...overrides
  };
}
