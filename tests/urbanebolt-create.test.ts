import { describe, expect, it, vi } from 'vitest';

import {
  type ProviderHttpClient,
  type ProviderHttpRequestOptions
} from '../src/couriers/provider-http-client.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';
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

describe('UrbaneBolt create shipment mapping', () => {
  it('maps one normalized order to a manifest item and normalizes the provider response', async () => {
    const calls: ProviderHttpRequestOptions[] = [];
    const rawResponse = {
      status: 'Success',
      successResponse: [{ orderNumber: 'UB-123', awbNumber: 'AWB-123' }],
      errorResponse: []
    };
    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => {
      calls.push(options);

      return requestResult(
        options,
        options.operation === 'authenticate'
          ? { access_token: 'create-token', token_type: 'Bearer', expires_in: 60 }
          : rawResponse
      );
    });
    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    const result = await adapter.createShipment(createRequest);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      operation: 'create',
      method: 'POST',
      url: 'https://courier.example/api/v1/services/manifest/',
      headers: { authorization: 'Bearer create-token' },
      payload: [{
        orderNumber: 'order-123',
        serviceType: 'express',
        shprName: 'Warehouse',
        shprPhone: '+911111111111',
        shprEmail: 'warehouse@example.com',
        shprAdd: '1 Sender Street',
        shprCity: 'Mumbai',
        shprState: 'Maharashtra',
        shprCountry: 'IN',
        shprPincode: '400001',
        consName: 'Customer',
        consPhone: '+912222222222',
        consAdd: '2 Recipient Street',
        consCity: 'Pune',
        consState: 'Maharashtra',
        consCountry: 'IN',
        consPincode: '411001',
        rtnName: 'Returns',
        rtnPhone: '+913333333333',
        rtnAdd: '3 Return Street',
        rtnCity: 'Mumbai',
        rtnState: 'Maharashtra',
        rtnCountry: 'IN',
        rtnPincode: '400002',
        itemDescription: 'Blue shirt',
        pieces: 2,
        weight: 1.25,
        length: 20,
        breadth: 15,
        height: 5,
        paymentMode: 'COD',
        codAmount: 799,
        invoiceNumber: 'INV-123',
        invoiceDate: '2026-07-21',
        invoiceValue: 799
      }]
    });
    expect(result).toEqual({
      response: {
        order_id: 'order-123',
        courier_partner: 'urbanebolt',
        courier_order_id: 'UB-123',
        tracking_number: 'AWB-123',
        status: 'CREATED'
      },
      raw_request: calls[1].payload,
      raw_response: rawResponse
    });
  });

  it('requires service_type before making a provider request', async () => {
    const httpClient = vi.fn<ProviderHttpClient>();
    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });
    const requestWithoutServiceType = {
      ...createRequest,
      service_type: undefined
    } as unknown as CreateOrderRequest;

    await expect(adapter.createShipment(requestWithoutServiceType)).rejects.toMatchObject({
      name: 'CourierProviderError',
      operation: 'create',
      kind: 'client',
      retryable: false
    });
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('fails closed when the provider does not return order and AWB numbers', async () => {
    const rawResponse = {
      status: 'Success',
      successResponse: [],
      errorResponse: [{ message: 'Rejected' }]
    };
    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
      requestResult(
        options,
        options.operation === 'authenticate'
          ? { access_token: 'create-token', token_type: 'Bearer', expires_in: 60 }
          : rawResponse
      )
    ));
    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    await expect(adapter.createShipment(createRequest)).rejects.toMatchObject({
      name: 'CourierProviderError',
      operation: 'create',
      kind: 'client',
      rawResponsePayload: rawResponse
    });
    expect(httpClient).toHaveBeenCalledTimes(2);
    expect((httpClient.mock.calls[1][0].payload as unknown[])[0]).toMatchObject({
      orderNumber: 'order-123',
      serviceType: 'express'
    });
  });

  it('does not expose the authentication token in the create result', async () => {
    const httpClient = vi.fn<ProviderHttpClient>().mockImplementation(async (options) => (
      requestResult(
        options,
        options.operation === 'authenticate'
          ? { access_token: 'create-token', token_type: 'Bearer', expires_in: 60 }
          : { successResponse: [{ orderNumber: 'UB-123', awbNumber: 'AWB-123' }], errorResponse: [] }
      )
    ));
    const adapter = new UrbaneBoltAdapter({
      config: urbaneBoltTestConfig,
      httpClient
    });

    const result = await adapter.createShipment(createRequest);

    expect(JSON.stringify(result)).not.toContain('create-token');
    expect(JSON.stringify(result)).not.toContain('configured-password');
  });
});
