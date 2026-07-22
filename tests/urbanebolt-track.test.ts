import { describe, expect, it, vi } from 'vitest';

import {
  type ProviderHttpClient,
  type ProviderHttpRequestOptions
} from '../src/couriers/provider-http-client.js';
import type { TrackShipmentInput } from '../src/domain/contracts.js';
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

function requestResult(options: ProviderHttpRequestOptions, payload: unknown) {
  return {
    request: {
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload })
    },
    response: {
      statusCode: 200,
      payload
    }
  };
}

describe('UrbaneBolt tracking mapping', () => {
  it('maps tracking response and scan history correctly', async () => {
    const calls: ProviderHttpRequestOptions[] = [];
    const rawResponse = {
      status: 'Success',
      data: {
        currentStatusCode: 'MAN',
        currentStatusCodeDescription: 'Shipment Manifested',
        currentStatusDateTime: '22 Jul 2026, 18:01',
        currentLocation: 'Mumbai',
        scans: [
          {
            statusCode: 'MAN',
            statusCodeDescription: 'Shipment Manifested',
            statusDateTime: '22 Jul 2026, 18:01',
            currentLocation: 'Mumbai'
          }
        ]
      }
    };

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => {
      calls.push(options);

      return requestResult(
        options,
        options.operation === 'authenticate'
          ? { access_token: 'track-token', token_type: 'Bearer', expires_in: 60 }
          : rawResponse
      );
    });

    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    const input: TrackShipmentInput = {
      courier_order_id: 'UB-999',
      tracking_number: 'AWB-999'
    };

    const result = await adapter.trackShipment(input);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      operation: 'track',
      method: 'GET',
      url: 'https://courier.example/api/v1/services/tracking-pub/?awb=AWB-999',
      headers: { authorization: 'Bearer track-token' }
    });

    expect(result).toEqual({
      response: {
        order_id: 'UB-999',
        courier_partner: 'urbanebolt',
        tracking_number: 'AWB-999',
        status: 'CREATED',
        status_updated_at: '2026-07-22T12:31:00.000Z',
        events: [
          {
            status: 'CREATED',
            status_at: '2026-07-22T12:31:00.000Z',
            location: 'Mumbai',
            description: 'Shipment Manifested'
          }
        ]
      },
      raw_response: rawResponse
    });
  });

  it('requires tracking_number before sending request to provider', async () => {
    const httpClient = vi.fn<ProviderHttpClient>();
    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    await expect(adapter.trackShipment({ courier_order_id: 'UB-1', tracking_number: '' })).rejects.toMatchObject({
      name: 'CourierProviderError',
      operation: 'track',
      kind: 'client',
      retryable: false
    });

    expect(httpClient).not.toHaveBeenCalled();
  });

  it('maps unrecognized provider status to UNKNOWN', async () => {
    const rawResponse = {
      status: 'Success',
      data: {
        currentStatusCode: 'CUSTOM_INTERNAL_STATUS',
        currentStatusDateTime: '22 Jul 2026, 18:01',
        currentLocation: 'Mumbai',
        scans: [{
          statusCode: 'CUSTOM_INTERNAL_STATUS',
          statusCodeDescription: 'Unknown status',
          statusDateTime: '22 Jul 2026, 18:01',
          currentLocation: 'Mumbai'
        }]
      }
    };

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
      requestResult(
        options,
        options.operation === 'authenticate'
          ? { access_token: 'track-token', token_type: 'Bearer', expires_in: 60 }
          : rawResponse
      )
    ));

    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    const result = await adapter.trackShipment({ courier_order_id: null, tracking_number: 'AWB-CUSTOM' });

    expect(result.response.status).toBe('UNKNOWN');
  });

  it('maps the published UAT tracking response shape', async () => {
    const rawResponse = {
      status: 'Success',
      data: {
        currentStatusCode: 'MAN',
        currentStatusCodeDescription: 'Shipment Manifested',
        currentStatusDateTime: '22 Jul 2026, 18:01',
        currentLocation: 'Mumbai',
        scans: [
          {
            statusCode: 'MAN',
            statusCodeDescription: 'Shipment Manifested',
            statusDateTime: '22 Jul 2026, 18:01',
            currentLocation: 'Mumbai'
          }
        ]
      }
    };

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
      requestResult(
        options,
        options.operation === 'authenticate'
          ? { access_token: 'track-token', token_type: 'Bearer', expires_in: 60 }
          : rawResponse
      )
    ));

    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    const result = await adapter.trackShipment({ courier_order_id: 'UB-UAT', tracking_number: 'AWB-UAT' });

    expect(result.response.status).toBe('CREATED');
    expect(result.response.events).toEqual([
      expect.objectContaining({
        status: 'CREATED',
        location: 'Mumbai',
        description: 'Shipment Manifested'
      })
    ]);
    expect(result.response.events[0]?.status_at).toMatch(/^2026-07-22T/);
  });

  it('maps the observed UAT status codes and leaves unobserved values unknown', () => {
    expect(mapUrbaneBoltStatus('MAN')).toBe('CREATED');
    expect(mapUrbaneBoltStatus('CAN')).toBe('CANCELLED');
    expect(mapUrbaneBoltStatus('MANIFESTED')).toBe('UNKNOWN');
    expect(mapUrbaneBoltStatus('SOMETHING_ELSE')).toBe('UNKNOWN');
  });

  it('rejects a response that does not use the UAT tracking shape', async () => {
    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
      requestResult(options, options.operation === 'authenticate'
        ? { access_token: 'track-token', token_type: 'Bearer', expires_in: 60 }
        : { status: 'Success', data: { status: 'MANIFESTED' } })
    ));
    const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });

    await expect(adapter.trackShipment({ courier_order_id: 'UB-INVALID', tracking_number: 'AWB-INVALID' }))
      .rejects.toMatchObject({ operation: 'track', kind: 'client' });
  });

  it('preserves a cancellation scan with an empty UAT location', async () => {
    const rawResponse = {
      status: 'Success',
      data: {
        currentStatusCode: 'CAN',
        currentStatusDateTime: '22 Jul 2026, 18:01',
        currentLocation: '',
        scans: [{
          statusCode: 'CAN',
          statusCodeDescription: 'Cancelled',
          statusDateTime: '22 Jul 2026, 18:01',
          currentLocation: ''
        }]
      }
    };
    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
      requestResult(options, options.operation === 'authenticate'
        ? { access_token: 'track-token', token_type: 'Bearer', expires_in: 60 }
        : rawResponse)
    ));
    const adapter = new UrbaneBoltAdapter({ config: urbaneBoltTestConfig, httpClient });

    const result = await adapter.trackShipment({ courier_order_id: 'UB-CANCELLED', tracking_number: 'AWB-CANCELLED' });

    expect(result.response.status).toBe('CANCELLED');
    expect(result.response.events[0]).toEqual({
      status: 'CANCELLED',
      status_at: '2026-07-22T12:31:00.000Z',
      description: 'Cancelled'
    });
  });
});
