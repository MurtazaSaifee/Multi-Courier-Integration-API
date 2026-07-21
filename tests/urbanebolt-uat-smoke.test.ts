import { describe, expect, it, vi } from 'vitest';
import { UrbaneBoltAdapter } from '../src/couriers/urbanebolt/urbanebolt-adapter.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';
import type { ProviderHttpRequestOptions, ProviderHttpResult } from '../src/couriers/provider-http-client.js';

describe('UrbaneBolt UAT Smoke Flow Verification (P9-T3)', () => {
  const sampleCreateRequest: CreateOrderRequest = {
    order_id: `UAT-SMOKE-${Date.now()}`,
    courier_partner: 'urbanebolt',
    service_type: 'EXPRESS',
    sender: {
      name: 'UAT Sender Hub',
      phone: '+919876543210',
      street: '123 Logistics Park',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      postal_code: '400001'
    },
    recipient: {
      name: 'UAT Recipient Customer',
      phone: '+919876543211',
      street: '456 Commercial Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'India',
      postal_code: '560001'
    },
    package: {
      description: 'Test UAT Electronic Item',
      pieces: 1,
      weight: 1.5,
      length: 20,
      breadth: 15,
      height: 10
    },
    payment: {
      mode: 'PREPAID'
    }
  };

  it('runs complete UAT smoke flow: authenticate -> create -> track -> cancel', async () => {
    let mockToken = 'uat_mock_bearer_token_12345';
    let currentStatus = 'CREATED';

    const mockHttpClient = vi.fn().mockImplementation(async (options: ProviderHttpRequestOptions): Promise<ProviderHttpResult<unknown>> => {
      const url = options.url;
      const method = options.method;

      if (url.includes('/api/v1/auth/getToken/')) {
        expect(options.payload).toEqual({
          username: 'info@urbanebolt.com',
          password: 'EKIcygsLVV5RCtPZ'
        });
        return {
          request: { method: 'POST', url, payload: options.payload },
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            payload: {
              status: 'Success',
              access_token: mockToken,
              token_type: 'Bearer',
              expires_in: 3600
            }
          }
        };
      }

      // Check Bearer authorization header attached to subsequent calls
      expect(options.headers?.authorization).toBe(`Bearer ${mockToken}`);

      if (url.includes('/api/v1/services/manifest/')) {
        return {
          request: { method: 'POST', url, payload: options.payload },
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            payload: {
              status: 'Success',
              successResponse: [
                {
                  orderNumber: sampleCreateRequest.order_id,
                  awbNumber: 'UB9988776655IN',
                  routeCode: 'BGL-01',
                  customerCode: 'CUST-001',
                  labelUrl: 'https://uat.urbanebolt.example/labels/UB9988776655IN.pdf'
                }
              ],
              errorResponse: []
            }
          }
        };
      }

      if (url.includes('/api/v1/services/tracking-pub/')) {
        expect(url).toContain('awb=UB9988776655IN');
        return {
          request: { method: 'GET', url },
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            payload: {
              status: 'Success',
              data: {
                orderNumber: sampleCreateRequest.order_id,
                awbNumber: 'UB9988776655IN',
                currentStatus: currentStatus,
                statusDate: '2026-07-21T12:00:00.000Z',
                scans: [
                  {
                    status: 'CREATED',
                    date: '2026-07-21T10:00:00.000Z',
                    location: 'Mumbai Hub',
                    description: 'Shipment manifest created'
                  }
                ]
              }
            }
          }
        };
      }

      if (url.includes('/api/v1/services/cancel/')) {
        expect(options.payload).toEqual({ awbs: 'UB9988776655IN' });
        currentStatus = 'CANCELLED';
        return {
          request: { method: 'POST', url, payload: options.payload },
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            payload: {
              status: 'Success',
              successResponse: [
                {
                  orderNumber: sampleCreateRequest.order_id,
                  awbNumber: 'UB9988776655IN',
                  message: 'Cancelled'
                }
              ]
            }
          }
        };
      }

      throw new Error(`Unexpected HTTP request to ${url}`);
    });

    const adapter = new UrbaneBoltAdapter({
      config: {
        baseUrl: 'https://uat.urbanebolt.example',
        username: 'info@urbanebolt.com',
        password: 'EKIcygsLVV5RCtPZ',
        requestTimeoutMs: 5000,
        retryCount: 0,
        retryDelayMs: 0
      },
      httpClient: mockHttpClient
    });

    // Step 1: Create Shipment (triggers authentication first)
    const createResult = await adapter.createShipment(sampleCreateRequest);
    expect(createResult.response.order_id).toBe(sampleCreateRequest.order_id);
    expect(createResult.response.courier_partner).toBe('urbanebolt');
    expect(createResult.response.courier_order_id).toBe(sampleCreateRequest.order_id);
    expect(createResult.response.tracking_number).toBe('UB9988776655IN');
    expect(createResult.response.status).toBe('CREATED');

    // Step 2: Track Shipment (uses cached authentication token)
    const trackResult = await adapter.trackShipment({
      tracking_number: createResult.response.tracking_number,
      courier_order_id: createResult.response.courier_order_id
    });
    expect(trackResult.response.order_id).toBe(sampleCreateRequest.order_id);
    expect(trackResult.response.tracking_number).toBe('UB9988776655IN');
    expect(trackResult.response.status).toBe('CREATED');
    expect(trackResult.response.events.length).toBe(1);
    expect(trackResult.response.events[0].status).toBe('CREATED');

    // Step 3: Cancel Shipment
    const cancelResult = await adapter.cancelShipment({
      tracking_number: createResult.response.tracking_number,
      courier_order_id: createResult.response.courier_order_id
    });
    expect(cancelResult.response.status).toBe('CANCELLED');

    // Step 4: Verify Tracking reflects cancellation
    const reTrackResult = await adapter.trackShipment({
      tracking_number: createResult.response.tracking_number,
      courier_order_id: createResult.response.courier_order_id
    });
    expect(reTrackResult.response.status).toBe('CANCELLED');

    // Verify all endpoints were hit cleanly in sequence
    expect(mockHttpClient).toHaveBeenCalledTimes(5);
  });
});
