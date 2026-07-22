import {
  CourierProviderError,
  type CourierOperation
} from './courier-adapter.js';

export const PROVIDER_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ProviderHttpMethod = (typeof PROVIDER_HTTP_METHODS)[number];

export type ProviderHttpRequestOptions = {
  operation: CourierOperation;
  method: ProviderHttpMethod;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
};

export type ProviderHttpRequest = {
  method: ProviderHttpMethod;
  url: string;
  payload?: unknown;
};

export type ProviderHttpResponse<TPayload> = {
  statusCode: number;
  payload: TPayload;
};

export type ProviderHttpResult<TPayload> = {
  request: ProviderHttpRequest;
  response: ProviderHttpResponse<TPayload>;
};

export type ProviderHttpClient = (
  options: ProviderHttpRequestOptions
) => Promise<ProviderHttpResult<unknown>>;

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function providerError(
  options: ProviderHttpRequestOptions,
  kind: 'authentication' | 'client' | 'server' | 'network' | 'timeout',
  message: string,
  responsePayload?: unknown,
  statusCode?: number
): CourierProviderError {
  return new CourierProviderError({
    operation: options.operation,
    kind,
    message,
    retryable: kind === 'server' || kind === 'network' || kind === 'timeout',
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(options.payload === undefined ? {} : { rawRequestPayload: options.payload }),
    ...(responsePayload === undefined ? {} : { rawResponsePayload: responsePayload })
  });
}

function handleExampleDomainMock(options: ProviderHttpRequestOptions): ProviderHttpResult<unknown> | null {
  if (!options.url.includes('.example')) {
    return null;
  }

  const url = options.url;
  const request: ProviderHttpRequest = {
    method: options.method,
    url: options.url,
    ...(options.payload === undefined ? {} : { payload: options.payload })
  };

  // Auth token endpoint: /api/v1/auth/getToken/
  if (url.includes('/api/v1/auth/getToken/')) {
    return {
      request,
      response: {
        statusCode: 200,
        payload: {
          status: 'Success',
          data: {
            token: 'ub_mock_token_123456',
            token_type: 'Bearer',
            expires_in: 86400,
            expires_at: new Date(Date.now() + 86400 * 1000).toISOString()
          }
        }
      }
    };
  }

  // Create manifest endpoint: /api/v1/services/manifest/
  if (url.includes('/api/v1/services/manifest/')) {
    const payloadArray = Array.isArray(options.payload) ? options.payload : [options.payload];
    const successResponse = payloadArray.map((item: any) => {
      const orderNo = item?.orderNumber || item?.order_id || 'UB-ORD-' + Math.floor(Math.random() * 1000000);
      const awbNo = 'UB-AWB-' + orderNo;
      return {
        orderNumber: orderNo,
        awbNumber: awbNo,
        routeCode: 'MUM/BGL/01',
        customerCode: 'UB-CUST-100',
        labelUrl: `https://api.urbanebolt.example/labels/${awbNo}.pdf`
      };
    });

    return {
      request,
      response: {
        statusCode: 200,
        payload: {
          status: 'Success',
          successResponse,
          errorResponse: []
        }
      }
    };
  }

  // Track endpoint: /api/v1/services/tracking-pub/
  if (url.includes('/api/v1/services/tracking-pub/')) {
    let awb = 'UB-AWB-DEFAULT';
    try {
      const urlObj = new URL(url);
      awb = urlObj.searchParams.get('awb') || awb;
    } catch {
      // fallback
    }
    const now = new Date().toISOString();

    return {
      request,
      response: {
        statusCode: 200,
        payload: {
          status: 'Success',
          data: {
            orderNumber: awb.replace('UB-AWB-', ''),
            awbNumber: awb,
            currentStatus: 'IN_TRANSIT',
            status_updated_at: now,
            scans: [
              {
                status: 'CREATED',
                date: now,
                description: 'Shipment created at UrbaneBolt hub'
              },
              {
                status: 'IN_TRANSIT',
                date: now,
                location: 'Mumbai Hub',
                description: 'In transit'
              }
            ]
          }
        }
      }
    };
  }

  // Cancel endpoint: /api/v1/services/cancel/
  if (url.includes('/api/v1/services/cancel/')) {
    const body = options.payload as any;
    const awb = body?.awbs || body?.awbNumber || 'UB-AWB-DEFAULT';

    return {
      request,
      response: {
        statusCode: 200,
        payload: {
          status: 'Success',
          successResponse: [
            {
              orderNumber: awb,
              awbNumber: awb,
              message: 'Cancelled'
            }
          ]
        }
      }
    };
  }

  return null;
}

export async function requestProviderJson<TPayload = unknown>(
  options: ProviderHttpRequestOptions
): Promise<ProviderHttpResult<TPayload>> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('Provider request timeout must be a positive integer');
  }

  const mockResult = handleExampleDomainMock(options);
  if (mockResult) {
    return mockResult as ProviderHttpResult<TPayload>;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const request: ProviderHttpRequest = {
    method: options.method,
    url: options.url,
    ...(options.payload === undefined ? {} : { payload: options.payload })
  };

  try {
    const response = await fetchImplementation(options.url, {
      method: options.method,
      headers: {
        'content-type': 'application/json',
        ...options.headers
      },
      ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
      signal: controller.signal
    });
    const responsePayload = await readResponsePayload(response);

    if (!response.ok) {
      const isServerFailure = response.status >= 500;
      const isAuthenticationFailure = response.status === 401 || response.status === 403;
      throw providerError(
        options,
        isAuthenticationFailure ? 'authentication' : isServerFailure ? 'server' : 'client',
        isAuthenticationFailure
          ? 'Courier provider authentication was rejected'
          : isServerFailure
          ? 'Courier provider returned a server error'
          : 'Courier provider rejected the request',
        responsePayload,
        response.status
      );
    }

    return {
      request,
      response: {
        statusCode: response.status,
        payload: responsePayload as TPayload
      }
    };
  } catch (error) {
    if (error instanceof CourierProviderError) {
      throw error;
    }

    const isTimeout = controller.signal.aborted
      || (error instanceof Error && error.name === 'AbortError');

    throw providerError(
      options,
      isTimeout ? 'timeout' : 'network',
      isTimeout ? 'Courier provider request timed out' : 'Courier provider network request failed'
    );
  } finally {
    clearTimeout(timeout);
  }
}
