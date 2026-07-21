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
  kind: 'client' | 'server' | 'network' | 'timeout',
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

export async function requestProviderJson<TPayload = unknown>(
  options: ProviderHttpRequestOptions
): Promise<ProviderHttpResult<TPayload>> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('Provider request timeout must be a positive integer');
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
      throw providerError(
        options,
        isServerFailure ? 'server' : 'client',
        isServerFailure
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
