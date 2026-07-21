import { describe, expect, it, vi } from 'vitest';

import type { ProviderHttpClient, ProviderHttpRequestOptions } from '../src/couriers/provider-http-client.js';
import { CourierAuthFailedError, mapCourierProviderError } from '../src/errors/application-error.js';
import { UrbaneBoltAdapter, type UrbaneBoltAdapterConfig } from '../src/couriers/urbanebolt/urbanebolt-adapter.js';
import { CourierProviderError } from '../src/couriers/courier-adapter.js';

const testConfig: UrbaneBoltAdapterConfig = {
  baseUrl: 'https://courier.example',
  username: 'test-user',
  password: 'test-password',
  requestTimeoutMs: 100
};

describe('Courier Authentication Failure Handling & Refresh (P7-T2)', () => {
  it('automatically refreshes token and retries the original request once upon authentication rejection', async () => {
    let authCount = 0;
    let trackCount = 0;

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options: ProviderHttpRequestOptions) => {
      if (options.operation === 'authenticate') {
        authCount++;
        return {
          request: { method: options.method, url: options.url },
          response: {
            statusCode: 200,
            payload: { access_token: `token-${authCount}`, token_type: 'Bearer', expires_in: 3600 }
          }
        };
      }

      if (options.operation === 'track') {
        trackCount++;
        if (trackCount === 1) {
          throw new CourierProviderError({
            operation: 'track',
            kind: 'authentication',
            message: '401 Unauthorized',
            retryable: false,
            statusCode: 401
          });
        }
        return {
          request: { method: options.method, url: options.url },
          response: {
            statusCode: 200,
            payload: {
              data: {
                awbNumber: 'AWB-100',
                status: 'IN_TRANSIT',
                statusDate: '2026-07-21T12:00:00.000Z'
              }
            }
          }
        };
      }

      throw new Error(`Unexpected operation ${options.operation}`);
    });

    const adapter = new UrbaneBoltAdapter({
      config: testConfig,
      httpClient
    });

    const result = await adapter.trackShipment({ courier_order_id: 'UB-100', tracking_number: 'AWB-100' });

    expect(result.response.status).toBe('IN_TRANSIT');
    expect(authCount).toBe(2); // 1 initial auth + 1 refresh auth
    expect(trackCount).toBe(2); // 1 rejected track + 1 retried track
  });

  it('throws CourierProviderError kind=authentication and maps to COURIER_AUTH_FAILED if retried call still fails', async () => {
    let trackCount = 0;

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options: ProviderHttpRequestOptions) => {
      if (options.operation === 'authenticate') {
        return {
          request: { method: options.method, url: options.url },
          response: {
            statusCode: 200,
            payload: { access_token: 'token-persistent-fail', token_type: 'Bearer', expires_in: 3600 }
          }
        };
      }

      if (options.operation === 'track') {
        trackCount++;
        throw new CourierProviderError({
          operation: 'track',
          kind: 'authentication',
          message: '401 Unauthorized permanently',
          retryable: false,
          statusCode: 401
        });
      }

      throw new Error(`Unexpected operation ${options.operation}`);
    });

    const adapter = new UrbaneBoltAdapter({
      config: testConfig,
      httpClient
    });

    let caughtError: unknown;
    try {
      await adapter.trackShipment({ courier_order_id: 'UB-100', tracking_number: 'AWB-100' });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(CourierProviderError);
    expect((caughtError as CourierProviderError).kind).toBe('authentication');
    expect(trackCount).toBe(2); // Exactly 1 initial + 1 refresh retry, no infinite loop!

    // Verify mapping to COURIER_AUTH_FAILED
    const mapped = mapCourierProviderError(caughtError as CourierProviderError);
    expect(mapped).toBeInstanceOf(CourierAuthFailedError);
    expect(mapped.code).toBe('COURIER_AUTH_FAILED');
    expect(mapped.statusCode).toBe(502);
  });

  it('prevents unbounded retry loops when authentication endpoint returns authentication failure', async () => {
    let authCount = 0;

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options: ProviderHttpRequestOptions) => {
      if (options.operation === 'authenticate') {
        authCount++;
        throw new CourierProviderError({
          operation: 'authenticate',
          kind: 'authentication',
          message: 'Invalid credentials',
          retryable: false,
          statusCode: 401
        });
      }

      throw new Error(`Unexpected operation ${options.operation}`);
    });

    const adapter = new UrbaneBoltAdapter({
      config: testConfig,
      httpClient
    });

    await expect(
      adapter.createShipment({
        order_id: 'ORD-1',
        courier_partner: 'urbanebolt',
        service_type: 'express',
        sender: {
          name: 'Sender',
          phone: '+919999999999',
          street: 'Street 1',
          city: 'City',
          state: 'State',
          country: 'IN',
          postal_code: '110001'
        },
        recipient: {
          name: 'Recipient',
          phone: '+918888888888',
          street: 'Street 2',
          city: 'City',
          state: 'State',
          country: 'IN',
          postal_code: '110002'
        },
        package: {
          description: 'Box',
          pieces: 1,
          weight: 1
        },
        payment: {
          mode: 'PREPAID'
        }
      })
    ).rejects.toMatchObject({
      operation: 'authenticate',
      kind: 'authentication'
    });

    // Verify only 1 auth attempt was made (no infinite loop)
    expect(authCount).toBe(1);
  });
});
