import { describe, expect, it, vi } from 'vitest';

import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import { createCourierRegistry, courierRegistry } from '../src/couriers/courier-registry.js';
import {
  requestProviderJson,
  type ProviderHttpClient,
  type ProviderHttpRequestOptions,
  type ProviderHttpResult
} from '../src/couriers/provider-http-client.js';
import type { CourierAuthenticationResult } from '../src/domain/contracts.js';
import {
  UrbaneBoltAdapter,
  type UrbaneBoltAdapterConfig
} from '../src/couriers/urbanebolt/urbanebolt-adapter.js';
import { UnknownCourierError } from '../src/errors/application-error.js';

const urbaneBoltTestConfig: UrbaneBoltAdapterConfig = {
  baseUrl: 'https://courier.example',
  username: 'configured-user',
  password: 'configured-password',
  requestTimeoutMs: 100
};

type TestableUrbaneBoltAdapter = {
  getAuthentication(): Promise<CourierAuthenticationResult>;
  authenticatedRequest<TPayload>(
    options: ProviderHttpRequestOptions
  ): Promise<ProviderHttpResult<TPayload>>;
};

function asTestableAdapter(adapter: UrbaneBoltAdapter): TestableUrbaneBoltAdapter {
  return adapter as unknown as TestableUrbaneBoltAdapter;
}

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
    const authenticationResponse = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid credentials' }), { status: 401 })
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
      operation: 'authenticate',
      method: 'POST',
      url: 'https://courier.example/auth',
      payload: { username: 'user', password: 'password' },
      timeoutMs: 100,
      fetchImplementation: authenticationResponse
    })).rejects.toMatchObject({
      name: 'CourierProviderError',
      kind: 'authentication',
      retryable: false,
      statusCode: 401
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

describe('UrbaneBolt authentication', () => {
  it('sends configured credentials, caches the token, and attaches bearer authentication', async () => {
    const calls: ProviderHttpRequestOptions[] = [];
    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => {
      calls.push(options);

      return {
        request: {
          method: options.method,
          url: options.url,
          ...(options.payload === undefined ? {} : { payload: options.payload })
        },
        response: {
          statusCode: 200,
          payload: options.operation === 'authenticate'
            ? { access_token: 'secret-token', token_type: 'Bearer', expires_in: 60 }
            : { status: 'ok' }
        }
      };
    });
    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });
    const internal = asTestableAdapter(adapter);

    await internal.getAuthentication();
    await internal.getAuthentication();
    const result = await internal.authenticatedRequest({
      operation: 'track',
      method: 'GET',
      url: 'https://courier.example/track',
      timeoutMs: 100
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      operation: 'authenticate',
      method: 'POST',
      url: 'https://courier.example/api/v1/auth/getToken/',
      payload: {
        username: 'configured-user',
        password: 'configured-password'
      },
      timeoutMs: 100
    });
    expect(calls[1].headers).toEqual({ authorization: 'Bearer secret-token' });
    expect(result.response.payload).toEqual({ status: 'ok' });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('refreshes once after an authentication rejection', async () => {
    let authenticationCount = 0;
    const calls: ProviderHttpRequestOptions[] = [];
    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => {
      calls.push(options);

      if (options.operation === 'authenticate') {
        authenticationCount += 1;
        return {
          request: { method: options.method, url: options.url, payload: options.payload },
          response: {
            statusCode: 200,
            payload: {
              access_token: authenticationCount === 1 ? 'expired-token' : 'fresh-token',
              token_type: 'Bearer',
              expires_in: 60
            }
          }
        };
      }

      if (options.headers?.authorization === 'Bearer expired-token') {
        throw new CourierProviderError({
          operation: options.operation,
          kind: 'authentication',
          message: 'Courier token rejected',
          retryable: false,
          statusCode: 401
        });
      }

      return {
        request: { method: options.method, url: options.url, payload: options.payload },
        response: { statusCode: 200, payload: { status: 'ok' } }
      };
    });
    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    const result = await asTestableAdapter(adapter).authenticatedRequest({
      operation: 'track',
      method: 'GET',
      url: 'https://courier.example/track',
      timeoutMs: 100
    });

    expect(authenticationCount).toBe(2);
    expect(calls.map((call) => call.operation)).toEqual([
      'authenticate',
      'track',
      'authenticate',
      'track'
    ]);
    expect(calls[3].headers).toEqual({ authorization: 'Bearer fresh-token' });
    expect(result.response.payload).toEqual({ status: 'ok' });
    expect(JSON.stringify(result)).not.toMatch(/expired-token|fresh-token/);
  });

  it('does not retain an invalid authentication response payload', async () => {
    const httpClient = vi.fn<ProviderHttpClient>().mockResolvedValue({
      request: {
        method: 'POST',
        url: 'https://courier.example/api/v1/auth/getToken/',
        payload: { username: 'configured-user', password: 'configured-password' }
      },
      response: {
        statusCode: 200,
        payload: { access_token: 'unusable-token', expires_in: 0 }
      }
    });
    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    await expect(asTestableAdapter(adapter).getAuthentication()).rejects.toMatchObject({
      kind: 'authentication',
      rawResponsePayload: undefined
    });
  });
});
