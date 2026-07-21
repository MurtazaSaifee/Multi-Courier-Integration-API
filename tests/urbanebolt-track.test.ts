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
        orderNumber: 'UB-999',
        awbNumber: 'AWB-999',
        status: 'In_Transit',
        status_updated_at: '2026-07-21T10:00:00.000Z',
        scans: [
          {
            status: 'Manifested',
            date: '2026-07-21T08:00:00.000Z',
            location: 'Mumbai Hub',
            description: 'Order manifested'
          },
          {
            status: 'Picked_Up',
            date: '2026-07-21T09:00:00.000Z',
            location: 'Mumbai Facility',
            description: 'Package picked up'
          },
          {
            status: 'In_Transit',
            date: '2026-07-21T10:00:00.000Z',
            location: 'En route to Pune',
            description: 'In transit to destination'
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
        status: 'IN_TRANSIT',
        status_updated_at: '2026-07-21T10:00:00.000Z',
        events: [
          {
            status: 'CREATED',
            status_at: '2026-07-21T08:00:00.000Z',
            location: 'Mumbai Hub',
            description: 'Order manifested'
          },
          {
            status: 'PICKED_UP',
            status_at: '2026-07-21T09:00:00.000Z',
            location: 'Mumbai Facility',
            description: 'Package picked up'
          },
          {
            status: 'IN_TRANSIT',
            status_at: '2026-07-21T10:00:00.000Z',
            location: 'En route to Pune',
            description: 'In transit to destination'
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
        awbNumber: 'AWB-CUSTOM',
        status: 'CUSTOM_INTERNAL_STATUS'
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

  it('correctly maps all standard status strings', () => {
    expect(mapUrbaneBoltStatus('MANIFESTED')).toBe('CREATED');
    expect(mapUrbaneBoltStatus('PICKED_UP')).toBe('PICKED_UP');
    expect(mapUrbaneBoltStatus('In_Transit')).toBe('IN_TRANSIT');
    expect(mapUrbaneBoltStatus('DELIVERED')).toBe('DELIVERED');
    expect(mapUrbaneBoltStatus('Cancelled')).toBe('CANCELLED');
    expect(mapUrbaneBoltStatus('FAILED')).toBe('FAILED');
    expect(mapUrbaneBoltStatus('SOMETHING_ELSE')).toBe('UNKNOWN');
  });
});
