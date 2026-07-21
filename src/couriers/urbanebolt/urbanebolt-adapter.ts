import type {
  Address,
  CancelShipmentInput,
  CourierCancelResult,
  CourierCreateResult,
  CourierTrackResult,
  CourierAuthenticationResult,
  CreateOrderRequest,
  TrackShipmentInput
} from '../../domain/contracts.js';
import { config as appConfig } from '../../config.js';
import {
  CourierProviderError,
  type CourierAdapter,
  type CourierOperation
} from '../courier-adapter.js';
import {
  requestProviderJson,
  type ProviderHttpClient,
  type ProviderHttpRequestOptions,
  type ProviderHttpResult
} from '../provider-http-client.js';

export const URBANEBOLT_COURIER_PARTNER = 'urbanebolt';
const AUTHENTICATION_PATH = '/api/v1/auth/getToken/';
const CREATE_SHIPMENT_PATH = '/api/v1/services/manifest/';

export type UrbaneBoltAdapterConfig = {
  baseUrl: string;
  username: string;
  password: string;
  requestTimeoutMs: number;
};

export type UrbaneBoltAdapterOptions = {
  config: UrbaneBoltAdapterConfig;
  httpClient?: ProviderHttpClient;
};

type AuthenticatedRequestOptions = Omit<ProviderHttpRequestOptions, 'headers'> & {
  headers?: Record<string, string>;
};

type UrbaneBoltManifestPayload = Record<string, unknown>;

function mapAddress(prefix: 'shpr' | 'cons' | 'rtn', address: Address): UrbaneBoltManifestPayload {
  return {
    [`${prefix}Name`]: address.name,
    [`${prefix}Phone`]: address.phone,
    [`${prefix}Add`]: address.street,
    [`${prefix}City`]: address.city,
    [`${prefix}State`]: address.state,
    [`${prefix}Country`]: address.country,
    [`${prefix}Pincode`]: address.postal_code,
    ...(address.email === undefined ? {} : { [`${prefix}Email`]: address.email })
  };
}

function mapCreateRequest(request: CreateOrderRequest): UrbaneBoltManifestPayload {
  return {
    orderNumber: request.order_id,
    serviceType: request.service_type,
    ...mapAddress('shpr', request.sender),
    ...mapAddress('cons', request.recipient),
    ...(request.return_address === undefined ? {} : mapAddress('rtn', request.return_address)),
    itemDescription: request.package.description,
    pieces: request.package.pieces,
    weight: request.package.weight,
    ...(request.package.length === undefined ? {} : { length: request.package.length }),
    ...(request.package.breadth === undefined ? {} : { breadth: request.package.breadth }),
    ...(request.package.height === undefined ? {} : { height: request.package.height }),
    paymentMode: request.payment.mode,
    ...(request.payment.amount_to_collect === undefined
      ? {}
      : { codAmount: request.payment.amount_to_collect }),
    ...(request.invoice === undefined ? {} : {
      invoiceNumber: request.invoice.invoice_number,
      invoiceDate: request.invoice.invoice_date,
      invoiceValue: request.invoice.value
    })
  };
}

function invalidCreateRequest(message: string): CourierProviderError {
  return new CourierProviderError({
    operation: 'create',
    kind: 'client',
    message,
    retryable: false
  });
}

function createResponseMappingError(
  rawRequestPayload: unknown,
  rawResponsePayload: unknown
): CourierProviderError {
  return new CourierProviderError({
    operation: 'create',
    kind: 'client',
    message: 'Courier create response did not contain a successful shipment',
    retryable: false,
    rawRequestPayload,
    rawResponsePayload
  });
}

function mapCreateResponse(
  request: CreateOrderRequest,
  rawRequestPayload: unknown,
  rawResponsePayload: unknown
): CourierCreateResult {
  const response = asRecord(rawResponsePayload);
  const successfulShipments = response?.successResponse;
  const successfulShipment = Array.isArray(successfulShipments)
    ? asRecord(successfulShipments[0])
    : undefined;
  const courierOrderId = stringValue(successfulShipment?.orderNumber);
  const trackingNumber = stringValue(successfulShipment?.awbNumber);

  if (!courierOrderId || !trackingNumber) {
    throw createResponseMappingError(rawRequestPayload, rawResponsePayload);
  }

  return {
    response: {
      order_id: request.order_id,
      courier_partner: request.courier_partner,
      courier_order_id: courierOrderId,
      tracking_number: trackingNumber,
      status: 'CREATED'
    },
    raw_request: rawRequestPayload,
    raw_response: rawResponsePayload
  };
}

function defaultAdapterOptions(): UrbaneBoltAdapterOptions {
  return {
    config: {
      baseUrl: appConfig.urbanebolt.baseUrl,
      username: appConfig.urbanebolt.username,
      password: appConfig.urbanebolt.password,
      requestTimeoutMs: appConfig.requestTimeoutMs
    },
    httpClient: requestProviderJson
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstValue(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[]
): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) {
        return source[key];
      }
    }
  }

  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function responseSources(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  const nested = root ? asRecord(root.data) : undefined;

  if (!root) {
    return [];
  }

  return nested ? [root, nested] : [root];
}

function expirationDate(payload: unknown): Date | undefined {
  const sources = responseSources(payload);
  const expiresAt = firstValue(sources, ['expires_at', 'expiresAt']);

  if (typeof expiresAt === 'string' || typeof expiresAt === 'number') {
    const timestamp = typeof expiresAt === 'number'
      ? expiresAt > 1_000_000_000_000 ? expiresAt : expiresAt * 1000
      : Date.parse(expiresAt);
    const parsed = new Date(timestamp);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const expiresIn = firstValue(sources, ['expires_in', 'expiresIn', 'expires']);
  const seconds = typeof expiresIn === 'number'
    ? expiresIn
    : typeof expiresIn === 'string' ? Number(expiresIn) : Number.NaN;

  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000);
  }

  return undefined;
}

function parseAuthenticationResult(payload: unknown): CourierAuthenticationResult | undefined {
  const sources = responseSources(payload);
  const accessToken = stringValue(firstValue(sources, ['access_token', 'accessToken', 'token']));
  const expiresAt = expirationDate(payload);

  if (!accessToken || !expiresAt || expiresAt.getTime() <= Date.now()) {
    return undefined;
  }

  return {
    access_token: accessToken,
    token_type: stringValue(firstValue(sources, ['token_type', 'tokenType'])) ?? 'Bearer',
    expires_at: expiresAt
  };
}

function invalidAuthenticationResponse(): CourierProviderError {
  return new CourierProviderError({
    operation: 'authenticate',
    kind: 'authentication',
    message: 'Courier authentication response was invalid',
    retryable: false
  });
}

function isAuthenticationRejection(error: unknown): error is CourierProviderError {
  return error instanceof CourierProviderError && error.kind === 'authentication';
}

function operationNotImplemented(operation: CourierOperation): CourierProviderError {
  return new CourierProviderError({
    operation,
    kind: 'not_implemented',
    message: `UrbaneBolt ${operation} operation is not implemented`,
    retryable: false
  });
}

/** Provider-specific implementation boundary; operations are added in later Phase 3 tasks. */
export class UrbaneBoltAdapter implements CourierAdapter {
  readonly courierPartner = URBANEBOLT_COURIER_PARTNER;
  private readonly config: UrbaneBoltAdapterConfig;
  private readonly httpClient: ProviderHttpClient;
  private cachedAuthentication?: CourierAuthenticationResult;
  private authenticationInFlight?: Promise<CourierAuthenticationResult>;

  constructor(options: UrbaneBoltAdapterOptions = defaultAdapterOptions()) {
    this.config = options.config;
    this.httpClient = options.httpClient ?? requestProviderJson;
  }

  private async authenticate(): Promise<CourierAuthenticationResult> {
    try {
      const result = await this.httpClient({
        operation: 'authenticate',
        method: 'POST',
        url: `${this.config.baseUrl.replace(/\/+$/, '')}${AUTHENTICATION_PATH}`,
        payload: {
          username: this.config.username,
          password: this.config.password
        },
        timeoutMs: this.config.requestTimeoutMs
      });
      const authentication = parseAuthenticationResult(result.response.payload);

      if (!authentication) {
        throw invalidAuthenticationResponse();
      }

      this.cachedAuthentication = authentication;
      return authentication;
    } catch (error) {
      if (error instanceof CourierProviderError) {
        throw new CourierProviderError({
          operation: 'authenticate',
          kind: error.kind,
          message: error.message,
          retryable: error.retryable,
          ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
          ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode })
        });
      }

      throw error;
    }
  }

  private async getAuthentication(): Promise<CourierAuthenticationResult> {
    if (this.cachedAuthentication && this.cachedAuthentication.expires_at.getTime() > Date.now()) {
      return this.cachedAuthentication;
    }

    if (!this.authenticationInFlight) {
      this.authenticationInFlight = this.authenticate();
    }

    try {
      return await this.authenticationInFlight;
    } finally {
      this.authenticationInFlight = undefined;
    }
  }

  private async authenticatedRequest<TPayload>(
    options: AuthenticatedRequestOptions
  ): Promise<ProviderHttpResult<TPayload>> {
    const authentication = await this.getAuthentication();
    const sendRequest = async (token: CourierAuthenticationResult) => {
      const result = await this.httpClient({
        ...options,
        headers: {
          ...options.headers,
          authorization: `${token.token_type} ${token.access_token}`
        }
      });

      return result as ProviderHttpResult<TPayload>;
    };

    try {
      return await sendRequest(authentication);
    } catch (error) {
      if (!isAuthenticationRejection(error)) {
        throw error;
      }

      this.cachedAuthentication = undefined;
      const refreshedAuthentication = await this.getAuthentication();
      return sendRequest(refreshedAuthentication);
    }
  }

  async createShipment(request: CreateOrderRequest): Promise<CourierCreateResult> {
    if (typeof request.service_type !== 'string' || request.service_type.trim().length === 0) {
      throw invalidCreateRequest('UrbaneBolt create request requires service_type');
    }

    const manifestPayload = [mapCreateRequest(request)];
    const result = await this.authenticatedRequest<unknown>({
      operation: 'create',
      method: 'POST',
      url: `${this.config.baseUrl.replace(/\/+$/, '')}${CREATE_SHIPMENT_PATH}`,
      payload: manifestPayload,
      timeoutMs: this.config.requestTimeoutMs
    });

    return mapCreateResponse(request, result.request.payload, result.response.payload);
  }

  async trackShipment(_input: TrackShipmentInput): Promise<CourierTrackResult> {
    throw operationNotImplemented('track');
  }

  async cancelShipment(_input: CancelShipmentInput): Promise<CourierCancelResult> {
    throw operationNotImplemented('cancel');
  }
}
