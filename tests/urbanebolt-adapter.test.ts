import { describe, expect, it, vi } from 'vitest';

import {
  CourierProviderError,
  type CourierProviderErrorOptions
} from '../src/couriers/courier-adapter.js';
import {
  type ProviderHttpClient,
  type ProviderHttpRequestOptions
} from '../src/couriers/provider-http-client.js';
import type {
  CancelShipmentInput,
  CreateOrderRequest,
  TrackShipmentInput
} from '../src/domain/contracts.js';
import {
  mapUrbaneBoltStatus,
  UrbaneBoltAdapter,
  type UrbaneBoltAdapterConfig
} from '../src/couriers/urbanebolt/urbanebolt-adapter.js';

const urbaneBoltTestConfig: UrbaneBoltAdapterConfig = {
  baseUrl: 'https://courier.example',
  username: 'configured-user',
  password: 'configured-password',
  requestTimeoutMs: 100
};

const createRequest: CreateOrderRequest = {
  order_id: 'order-123',
  courier_partner: 'urbanebolt',
  service_type: 'express',
  sender: {
    name: 'Warehouse',
    phone: '+911111111111',
    email: 'warehouse@example.com',
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
  return_address: {
    name: 'Returns',
    phone: '+913333333333',
    street: '3 Return Street',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'IN',
    postal_code: '400002'
  },
  package: {
    description: 'Blue shirt',
    pieces: 2,
    weight: 1.25,
    length: 20,
    breadth: 15,
    height: 5
  },
  payment: {
    mode: 'COD',
    amount_to_collect: 799
  },
  invoice: {
    invoice_number: 'INV-123',
    invoice_date: '2026-07-21',
    value: 799
  }
};

function requestResult(options: ProviderHttpRequestOptions, payload: unknown, statusCode = 200) {
  return {
    request: {
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload })
    },
    response: {
      statusCode,
      payload
    }
  };
}

function authRejectionError(options: CourierProviderErrorOptions): CourierProviderError {
  return new CourierProviderError(options);
}

describe('UrbaneBoltAdapter comprehensive suite', () => {
  describe('Authentication and Token Management', () => {
    it('caches valid token across subsequent requests without re-authenticating', async () => {
      const calls: ProviderHttpRequestOptions[] = [];
      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => {
        calls.push(options);
        if (options.operation === 'authenticate') {
          return requestResult(options, { access_token: 'valid-token', token_type: 'Bearer', expires_in: 3600 });
        }
        return requestResult(options, {
          status: 'Success',
          successResponse: [{ orderNumber: 'UB-1', awbNumber: 'AWB-1' }]
        });
      });

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });

      await adapter.createShipment(createRequest);
      await adapter.createShipment(createRequest);

      // Total 3 calls: 1 authenticate + 2 create calls using cached token
      expect(calls).toHaveLength(3);
      expect(calls[0].operation).toBe('authenticate');
      expect(calls[1].operation).toBe('create');
      expect(calls[2].operation).toBe('create');
      expect(calls[1].headers?.authorization).toBe('Bearer valid-token');
      expect(calls[2].headers?.authorization).toBe('Bearer valid-token');
    });

    it('refreshes token and retries once when provider rejects request due to auth failure', async () => {
      const calls: ProviderHttpRequestOptions[] = [];
      let authCallCount = 0;

      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => {
        calls.push(options);
        if (options.operation === 'authenticate') {
          authCallCount++;
          return requestResult(options, {
            access_token: `token-v${authCallCount}`,
            token_type: 'Bearer',
            expires_in: 3600
          });
        }

        // On first create call, simulate token expiration rejection
        if (options.operation === 'create' && calls.filter((c) => c.operation === 'create').length === 1) {
          throw authRejectionError({
            operation: 'create',
            kind: 'authentication',
            message: 'Bearer token expired',
            retryable: false,
            statusCode: 401
          });
        }

        return requestResult(options, {
          status: 'Success',
          successResponse: [{ orderNumber: 'UB-REFRESH', awbNumber: 'AWB-REFRESH' }]
        });
      });

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });

      const result = await adapter.createShipment(createRequest);

      // Call sequence: auth (v1) -> create (rejected 401) -> auth (v2) -> create (succeeded with token-v2)
      expect(calls).toHaveLength(4);
      expect(calls[0].operation).toBe('authenticate');
      expect(calls[1].operation).toBe('create');
      expect(calls[1].headers?.authorization).toBe('Bearer token-v1');
      expect(calls[2].operation).toBe('authenticate');
      expect(calls[3].operation).toBe('create');
      expect(calls[3].headers?.authorization).toBe('Bearer token-v2');

      expect(result.response.tracking_number).toBe('AWB-REFRESH');
    });

    it('throws error when authentication response is invalid', async () => {
      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(options, { invalid_payload: true })
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });

      await expect(adapter.createShipment(createRequest)).rejects.toMatchObject({
        name: 'CourierProviderError',
        operation: 'authenticate',
        kind: 'authentication'
      });
    });

    it('does not leak authentication credentials or access tokens in adapter results', async () => {
      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(
          options,
          options.operation === 'authenticate'
            ? { access_token: 'secret-token', token_type: 'Bearer', expires_in: 3600 }
            : { successResponse: [{ orderNumber: 'UB-SEC', awbNumber: 'AWB-SEC' }] }
        )
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });
      const result = await adapter.createShipment(createRequest);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('secret-token');
      expect(serialized).not.toContain('configured-password');
    });
  });

  describe('Create Shipment Mapping and Raw Payload Capture', () => {
    it('maps normalized request to manifest payload and captures raw request and response', async () => {
      const rawResponse = {
        status: 'Success',
        successResponse: [{ orderNumber: 'UB-123', awbNumber: 'AWB-123' }],
        errorResponse: []
      };

      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(
          options,
          options.operation === 'authenticate'
            ? { access_token: 'token', token_type: 'Bearer', expires_in: 3600 }
            : rawResponse
        )
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });
      const result = await adapter.createShipment(createRequest);

      expect(result.raw_request).toEqual([
        expect.objectContaining({
          orderNumber: 'order-123',
          serviceType: 'express',
          shprName: 'Warehouse',
          consName: 'Customer'
        })
      ]);
      expect(result.raw_response).toEqual(rawResponse);
      expect(result.response).toEqual({
        order_id: 'order-123',
        courier_partner: 'urbanebolt',
        courier_order_id: 'UB-123',
        tracking_number: 'AWB-123',
        status: 'CREATED'
      });
    });

    it('requires service_type before making HTTP request', async () => {
      const httpClient = vi.fn<ProviderHttpClient>();
      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });

      const invalidReq = { ...createRequest, service_type: '' };
      await expect(adapter.createShipment(invalidReq)).rejects.toMatchObject({
        name: 'CourierProviderError',
        operation: 'create',
        kind: 'client'
      });
      expect(httpClient).not.toHaveBeenCalled();
    });

    it('fails closed when provider manifest response lacks shipment identifiers', async () => {
      const rawResponse = { status: 'Success', successResponse: [] };
      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(
          options,
          options.operation === 'authenticate'
            ? { access_token: 'token', token_type: 'Bearer', expires_in: 3600 }
            : rawResponse
        )
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });
      await expect(adapter.createShipment(createRequest)).rejects.toMatchObject({
        name: 'CourierProviderError',
        operation: 'create',
        rawResponsePayload: rawResponse
      });
    });

    it('maps numeric orderNumber and awbNumber from provider into string values', async () => {
      const rawResponse = {
        status: 'Success',
        successResponse: [{ orderNumber: 998877, awbNumber: 11223344 }]
      };

      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(
          options,
          options.operation === 'authenticate'
            ? { access_token: 'token', token_type: 'Bearer', expires_in: 3600 }
            : rawResponse
        )
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });
      const result = await adapter.createShipment(createRequest);

      expect(result.response.courier_order_id).toBe('998877');
      expect(result.response.tracking_number).toBe('11223344');
    });
  });

  describe('Track Shipment Mapping and Raw Payload Capture', () => {
    it('maps tracking details, scan events, and captures raw response', async () => {
      const rawResponse = {
        status: 'Success',
        data: {
          orderNumber: 'UB-TRACK',
          awbNumber: 'AWB-TRACK',
          status: 'In_Transit',
          status_updated_at: '2026-07-21T10:00:00.000Z',
          scans: [
            { status: 'Manifested', date: '2026-07-21T08:00:00.000Z', location: 'Hub 1', description: 'Manifested' },
            { status: 'In_Transit', date: '2026-07-21T10:00:00.000Z', location: 'Hub 2', description: 'In transit' }
          ]
        }
      };

      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(
          options,
          options.operation === 'authenticate'
            ? { access_token: 'token', token_type: 'Bearer', expires_in: 3600 }
            : rawResponse
        )
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });
      const input: TrackShipmentInput = { courier_order_id: 'UB-TRACK', tracking_number: 'AWB-TRACK' };

      const result = await adapter.trackShipment(input);

      expect(result.raw_response).toEqual(rawResponse);
      expect(result.response.status).toBe('IN_TRANSIT');
      expect(result.response.events).toHaveLength(2);
      expect(result.response.events[0]).toEqual({
        status: 'CREATED',
        status_at: '2026-07-21T08:00:00.000Z',
        location: 'Hub 1',
        description: 'Manifested'
      });
    });

    it('requires tracking_number before sending track request', async () => {
      const httpClient = vi.fn<ProviderHttpClient>();
      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });

      await expect(adapter.trackShipment({ courier_order_id: 'UB-1', tracking_number: '' })).rejects.toMatchObject({
        name: 'CourierProviderError',
        operation: 'track',
        kind: 'client'
      });
      expect(httpClient).not.toHaveBeenCalled();
    });

    it('maps unrecognized provider status to UNKNOWN', async () => {
      const rawResponse = { status: 'Success', data: { status: 'UNKNOWN_PROVIDER_CODE' } };
      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(
          options,
          options.operation === 'authenticate'
            ? { access_token: 'token', token_type: 'Bearer', expires_in: 3600 }
            : rawResponse
        )
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });
      const result = await adapter.trackShipment({ courier_order_id: null, tracking_number: 'AWB-X' });

      expect(result.response.status).toBe('UNKNOWN');
    });

    it('correctly normalizes standard status values', () => {
      expect(mapUrbaneBoltStatus('MANIFESTED')).toBe('CREATED');
      expect(mapUrbaneBoltStatus('PICKED_UP')).toBe('PICKED_UP');
      expect(mapUrbaneBoltStatus('IN_TRANSIT')).toBe('IN_TRANSIT');
      expect(mapUrbaneBoltStatus('DELIVERED')).toBe('DELIVERED');
      expect(mapUrbaneBoltStatus('CANCELLED')).toBe('CANCELLED');
      expect(mapUrbaneBoltStatus('FAILED')).toBe('FAILED');
      expect(mapUrbaneBoltStatus('UNKNOWN_VALUE')).toBe('UNKNOWN');
    });
  });

  describe('Cancel Shipment Mapping and Raw Payload Capture', () => {
    it('maps successful cancellation and captures raw request and response', async () => {
      const rawResponse = {
        status: 'Success',
        successResponse: [{ orderNumber: 'UB-CANCEL', awbNumber: 'AWB-CANCEL', message: 'Cancelled' }]
      };

      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(
          options,
          options.operation === 'authenticate'
            ? { access_token: 'token', token_type: 'Bearer', expires_in: 3600 }
            : rawResponse
        )
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });
      const input: CancelShipmentInput = { courier_order_id: 'UB-CANCEL', tracking_number: 'AWB-CANCEL' };

      const result = await adapter.cancelShipment(input);

      expect(result.raw_response).toEqual(rawResponse);
      expect(result.response).toEqual({
        order_id: 'UB-CANCEL',
        courier_partner: 'urbanebolt',
        tracking_number: 'AWB-CANCEL',
        status: 'CANCELLED'
      });
    });

    it('treats already-cancelled response as a successful no-op', async () => {
      const rawResponse = {
        status: 'Success',
        failureResponse: [{ orderNumber: 'UB-NOOP', awbNumber: 'AWB-NOOP', message: 'Shipment already cancelled' }]
      };

      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(
          options,
          options.operation === 'authenticate'
            ? { access_token: 'token', token_type: 'Bearer', expires_in: 3600 }
            : rawResponse
        )
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });
      const result = await adapter.cancelShipment({ courier_order_id: 'UB-NOOP', tracking_number: 'AWB-NOOP' });

      expect(result.response.status).toBe('CANCELLED');
    });

    it('throws CourierProviderError when provider rejects cancellation', async () => {
      const rawResponse = {
        status: 'Error',
        failureResponse: [{ message: 'Cannot cancel shipment after pickup' }]
      };

      const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
        requestResult(
          options,
          options.operation === 'authenticate'
            ? { access_token: 'token', token_type: 'Bearer', expires_in: 3600 }
            : rawResponse
        )
      ));

      const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });
      await expect(
        adapter.cancelShipment({ courier_order_id: 'UB-FAIL', tracking_number: 'AWB-FAIL' })
      ).rejects.toMatchObject({
        name: 'CourierProviderError',
        operation: 'cancel',
        message: 'Cannot cancel shipment after pickup'
      });
    });
  });
});
