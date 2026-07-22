import { describe, expect, it, vi } from 'vitest';

import {
  type ProviderHttpClient,
  type ProviderHttpRequestOptions
} from '../src/couriers/provider-http-client.js';
import type { CancelShipmentInput } from '../src/domain/contracts.js';
import {
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

describe('UrbaneBolt cancellation mapping', () => {
  it('maps a successful cancellation response to CANCELLED', async () => {
    const calls: ProviderHttpRequestOptions[] = [];
    const rawResponse = {
      status: 'Success',
      successResponse: [
        {
          orderNumber: 'UB-100',
          awb: 'AWB-100',
          message: 'Cancelled'
        }
      ],
      failureResponse: []
    };

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => {
      calls.push(options);

      return requestResult(
        options,
        options.operation === 'authenticate'
          ? { access_token: 'cancel-token', token_type: 'Bearer', expires_in: 60 }
          : rawResponse
      );
    });

    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    const input: CancelShipmentInput = {
      courier_order_id: 'UB-100',
      tracking_number: 'AWB-100'
    };

    const result = await adapter.cancelShipment(input);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      operation: 'cancel',
      method: 'POST',
      url: 'https://courier.example/api/v1/services/cancel/',
      headers: { authorization: 'Bearer cancel-token' },
      payload: { awbs: 'AWB-100' }
    });

    expect(result).toEqual({
      response: {
        order_id: 'UB-100',
        courier_partner: 'urbanebolt',
        tracking_number: 'AWB-100',
        status: 'CANCELLED'
      },
      raw_response: rawResponse
    });
  });

  it('treats an already-cancelled response as a successful no-op returning CANCELLED', async () => {
    const rawResponse = {
      status: 'Success',
      successResponse: [],
      failureResponse: [
        {
          orderNumber: 'UB-101',
          awb: 'AWB-101',
          message: 'Shipment already cancelled'
        }
      ]
    };

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
      requestResult(
        options,
        options.operation === 'authenticate'
          ? { access_token: 'cancel-token', token_type: 'Bearer', expires_in: 60 }
          : rawResponse
      )
    ));

    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    const input: CancelShipmentInput = {
      courier_order_id: 'UB-101',
      tracking_number: 'AWB-101'
    };

    const result = await adapter.cancelShipment(input);

    expect(result.response.status).toBe('CANCELLED');
    expect(result.response.order_id).toBe('UB-101');
    expect(result.raw_response).toEqual(rawResponse);
  });

  it('throws CourierProviderError when cancellation is rejected by provider', async () => {
    const rawResponse = {
      status: 'Success',
      successResponse: [],
      failureResponse: [
        {
          orderNumber: 'UB-102',
          awb: 'AWB-102',
          message: 'Cannot cancel shipment after pickup'
        }
      ]
    };

    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
      requestResult(
        options,
        options.operation === 'authenticate'
          ? { access_token: 'cancel-token', token_type: 'Bearer', expires_in: 60 }
          : rawResponse
      )
    ));

    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    await expect(
      adapter.cancelShipment({ courier_order_id: 'UB-102', tracking_number: 'AWB-102' })
    ).rejects.toMatchObject({
      name: 'CourierProviderError',
      operation: 'cancel',
      kind: 'client',
      message: 'Cannot cancel shipment after pickup',
      retryable: false,
      rawResponsePayload: rawResponse
    });
  });

  it('requires tracking_number before sending cancel request', async () => {
    const httpClient = vi.fn<ProviderHttpClient>();
    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    await expect(
      adapter.cancelShipment({ courier_order_id: 'UB-1', tracking_number: '' })
    ).rejects.toMatchObject({
      name: 'CourierProviderError',
      operation: 'cancel',
      kind: 'client',
      retryable: false
    });

    expect(httpClient).not.toHaveBeenCalled();
  });
});
