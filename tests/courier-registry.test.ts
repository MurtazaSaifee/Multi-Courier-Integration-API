import { describe, expect, it, vi } from 'vitest';

import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import { createCourierRegistry, courierRegistry } from '../src/couriers/courier-registry.js';
import { requestProviderJson } from '../src/couriers/provider-http-client.js';
import { UrbaneBoltAdapter } from '../src/couriers/urbanebolt/urbanebolt-adapter.js';
import { UnknownCourierError } from '../src/errors/application-error.js';

describe('courier registry', () => {
  it('registers and resolves the default UrbaneBolt adapter', () => {
    const adapter = courierRegistry.resolve('urbanebolt');

    expect(adapter).toBeInstanceOf(UrbaneBoltAdapter);
    expect(adapter.courierPartner).toBe('urbanebolt');
    expect(courierRegistry.supportedCouriers()).toEqual(['urbanebolt']);
  });

  it('reports supported couriers for an unknown partner', () => {
    expect(() => courierRegistry.resolve('delhivery')).toThrow(UnknownCourierError);

    try {
      courierRegistry.resolve('delhivery');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownCourierError);
      expect((error as UnknownCourierError).details).toEqual([
        {
          field: 'courier_partner',
          message: 'Use one of the supported courier partners',
          supported_values: ['urbanebolt']
        }
      ]);
    }
  });

  it('rejects duplicate adapter registrations', () => {
    const adapter = new UrbaneBoltAdapter();

    expect(() => createCourierRegistry([adapter, adapter])).toThrow(Error);
    expect(() => createCourierRegistry([adapter, adapter])).toThrow(
      'Courier partner is registered more than once: urbanebolt'
    );
  });

  it('preserves typed provider failure metadata for adapter operations', () => {
    const failure = new CourierProviderError({
      operation: 'track',
      kind: 'timeout',
      message: 'Courier request timed out',
      retryable: true
    });

    expect(failure).toMatchObject({
      name: 'CourierProviderError',
      operation: 'track',
      kind: 'timeout',
      retryable: true
    });
  });
});

describe('provider HTTP client', () => {
  it('constructs JSON requests and captures request and response payloads', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ shipment: 'created' }), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      })
    );
    const payload = { orderNumber: 'order-1' };

    const result = await requestProviderJson({
      operation: 'create',
      method: 'POST',
      url: 'https://courier.example/shipments',
      payload,
      headers: { authorization: 'Bearer test-token' },
      timeoutMs: 100,
      fetchImplementation
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://courier.example/shipments',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-token'
        },
        body: JSON.stringify(payload),
        signal: expect.any(AbortSignal)
      })
    );
    expect(result).toEqual({
      request: {
        method: 'POST',
        url: 'https://courier.example/shipments',
        payload
      },
      response: {
        statusCode: 201,
        payload: { shipment: 'created' }
      }
    });
  });

  it('classifies HTTP 4xx and 5xx responses with raw payloads', async () => {
    const clientResponse = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid shipment' }), { status: 422 })
    );
    const serverResponse = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'temporarily unavailable' }), { status: 503 })
    );

    await expect(requestProviderJson({
      operation: 'create',
      method: 'POST',
      url: 'https://courier.example/shipments',
      payload: { orderNumber: 'order-1' },
      timeoutMs: 100,
      fetchImplementation: clientResponse
    })).rejects.toMatchObject({
      name: 'CourierProviderError',
      kind: 'client',
      retryable: false,
      statusCode: 422,
      rawResponsePayload: { error: 'invalid shipment' }
    });

    await expect(requestProviderJson({
      operation: 'track',
      method: 'GET',
      url: 'https://courier.example/track',
      timeoutMs: 100,
      fetchImplementation: serverResponse
    })).rejects.toMatchObject({
      name: 'CourierProviderError',
      kind: 'server',
      retryable: true,
      statusCode: 503,
      rawResponsePayload: { error: 'temporarily unavailable' }
    });
  });

  it('classifies network failures and timeout cancellation', async () => {
    const networkFailure = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket closed'));
    const timeoutFailure = vi.fn<typeof fetch>().mockImplementation((_url, init) => (
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
    ));

    await expect(requestProviderJson({
      operation: 'track',
      method: 'GET',
      url: 'https://courier.example/track',
      timeoutMs: 100,
      fetchImplementation: networkFailure
    })).rejects.toMatchObject({
      kind: 'network',
      retryable: true
    });

    await expect(requestProviderJson({
      operation: 'track',
      method: 'GET',
      url: 'https://courier.example/track',
      timeoutMs: 5,
      fetchImplementation: timeoutFailure
    })).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true
    });
  });
});
