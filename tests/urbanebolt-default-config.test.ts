import { describe, expect, it, vi } from 'vitest';

import type { ProviderHttpClient } from '../src/couriers/provider-http-client.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';

const createRequest: CreateOrderRequest = {
  order_id: 'default-config-order',
  courier_partner: 'urbanebolt',
  service_type: 'NDD',
  sender: {
    name: 'Warehouse',
    phone: '+911111111111',
    street: '1 Sender Street',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400001'
  },
  recipient: {
    name: 'Customer',
    phone: '+912222222222',
    street: '2 Recipient Street',
    city: 'Pune',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '411001'
  },
  package: {
    description: 'Default config test item',
    pieces: 1,
    weight: 1
  },
  payment: {
    mode: 'PREPAID'
  }
};

describe('UrbaneBolt default adapter configuration', () => {
  it('forwards the configured customer code to create requests', async () => {
    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => ({
      request: {
        method: options.method,
        url: options.url,
        ...(options.payload === undefined ? {} : { payload: options.payload })
      },
      response: {
        statusCode: 200,
        payload: options.operation === 'authenticate'
          ? { access_token: 'token', token_type: 'Bearer', expires_in: 60 }
          : { successResponse: [{ orderNumber: createRequest.order_id, awbNumber: 'AWB-DEFAULT' }] }
      }
    }));

    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: {
        databaseUrl: 'postgres://user:password@localhost:5432/multi_courier',
        port: 3000,
        urbanebolt: {
          baseUrl: 'https://courier.example',
          username: 'configured-user',
          password: 'configured-password',
          customerCode: 'configured-customer'
        },
        requestTimeoutMs: 100,
        retryCount: 0,
        retryDelayMs: 0,
        bulkConcurrency: 5
      }
    }));
    vi.doMock('../src/couriers/provider-http-client.js', () => ({ requestProviderJson: httpClient }));

    try {
      const { UrbaneBoltAdapter } = await import('../src/couriers/urbanebolt/urbanebolt-adapter.js');
      const adapter = new UrbaneBoltAdapter();

      await adapter.createShipment(createRequest);

      expect(httpClient.mock.calls[1][0].payload).toEqual([
        expect.objectContaining({ customerCode: 'configured-customer' })
      ]);
    } finally {
      vi.doUnmock('../src/config.js');
      vi.doUnmock('../src/couriers/provider-http-client.js');
      vi.resetModules();
    }
  });
});
