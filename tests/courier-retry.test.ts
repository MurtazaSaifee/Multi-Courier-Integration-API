import { describe, expect, it, vi } from 'vitest';

import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import type { ProviderHttpClient, ProviderHttpRequestOptions } from '../src/couriers/provider-http-client.js';
import { isRetryableError, withRetry } from '../src/couriers/retry-helper.js';
import { UrbaneBoltAdapter, type UrbaneBoltAdapterConfig } from '../src/couriers/urbanebolt/urbanebolt-adapter.js';

const testConfig: UrbaneBoltAdapterConfig = {
  baseUrl: 'https://courier.example',
  username: 'test-user',
  password: 'test-password',
  requestTimeoutMs: 100,
  retryCount: 2,
  retryDelayMs: 250
};

describe('Configured Courier Retries (P7-T1)', () => {
  it('retries 5xx server errors for 3 total attempts with exponential delays (250 ms, 500 ms)', async () => {
    let attempts = 0;
    const delays: number[] = [];

    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new CourierProviderError({
        operation: 'create',
        kind: 'server',
        message: 'Server error 503',
        retryable: true,
        statusCode: 503
      });
    });

    const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        initialDelayMs: 250,
        sleep: sleepMock
      })
    ).rejects.toThrow('Server error 503');

    expect(attempts).toBe(3); // 1 initial + 2 retries = 3 total attempts
    expect(delays).toEqual([250, 500]); // exponential delays: 250 * 2^0, 250 * 2^1
  });

  it('does not retry 4xx client errors and fails on first attempt', async () => {
    let attempts = 0;
    const sleepMock = vi.fn();

    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new CourierProviderError({
        operation: 'create',
        kind: 'client',
        message: 'Bad Request 400',
        retryable: false,
        statusCode: 400
      });
    });

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        initialDelayMs: 250,
        sleep: sleepMock
      })
    ).rejects.toThrow('Bad Request 400');

    expect(attempts).toBe(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('retries network failures and timeouts', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new CourierProviderError({
          operation: 'track',
          kind: 'network',
          message: 'Network drop',
          retryable: true
        });
      }
      if (attempts === 2) {
        throw new CourierProviderError({
          operation: 'track',
          kind: 'timeout',
          message: 'Request timeout',
          retryable: true
        });
      }
      return 'success';
    });

    const result = await withRetry(fn, {
      maxRetries: 2,
      initialDelayMs: 250,
      sleep: sleepMock
    });

    expect(result).toBe('success');
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it('correctly identifies retryable vs non-retryable errors', () => {
    const serverErr = new CourierProviderError({
      operation: 'create',
      kind: 'server',
      message: '500 Internal',
      retryable: true
    });
    const clientErr = new CourierProviderError({
      operation: 'create',
      kind: 'client',
      message: '400 Bad Request',
      retryable: false
    });

    expect(isRetryableError(serverErr)).toBe(true);
    expect(isRetryableError(clientErr)).toBe(false);
    expect(isRetryableError(new Error('Generic error'))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });

  it('integrates retries in UrbaneBoltAdapter for 5xx errors with custom configuration', async () => {
    let callCount = 0;
    const delays: number[] = [];

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => {
      callCount++;
      if (options.operation === 'authenticate') {
        return {
          request: { method: 'POST', url: options.url },
          response: {
            statusCode: 200,
            payload: { access_token: 'valid-token', token_type: 'Bearer', expires_in: 3600 }
          }
        };
      }
      throw new CourierProviderError({
        operation: options.operation,
        kind: 'server',
        message: '500 Internal Server Error',
        retryable: true,
        statusCode: 500
      });
    });

    const sleepFn = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    const adapter = new UrbaneBoltAdapter({
      config: testConfig,
      httpClient,
      sleepFn
    });

    await expect(
      adapter.cancelShipment({ courier_order_id: 'UB-1', tracking_number: 'AWB-1' })
    ).rejects.toThrow('500 Internal Server Error');

    // 1 auth call + 3 cancel calls (1 initial + 2 retries) = 4 HTTP calls
    expect(callCount).toBe(4);
    expect(delays).toEqual([250, 500]);
  });
});
