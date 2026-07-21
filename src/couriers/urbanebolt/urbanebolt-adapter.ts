import type {
  Address,
  CancelShipmentInput,
  CourierCancelResult,
  CourierCreateResult,
  CourierTrackResult,
  CourierAuthenticationResult,
  CreateOrderRequest,
  NormalizedStatus,
  TrackShipmentInput,
  TrackingEvent
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
const TRACK_SHIPMENT_PATH = '/api/v1/services/tracking-pub/';
const CANCEL_SHIPMENT_PATH = '/api/v1/services/cancel/';

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

export function mapUrbaneBoltStatus(rawStatus: unknown): NormalizedStatus {
  if (typeof rawStatus !== 'string' && typeof rawStatus !== 'number') {
    return 'UNKNOWN';
  }

  const normalized = String(rawStatus).trim().toUpperCase().replace(/[\s_-]+/g, '_');

  switch (normalized) {
    case 'CREATED':
    case 'MANIFESTED':
    case 'BOOKED':
    case 'NEW':
    case 'ORDER_CREATED':
      return 'CREATED';

    case 'PICKED_UP':
    case 'PICKUP':
    case 'PICKED':
    case 'OUT_FOR_PICKUP':
    case 'PU':
      return 'PICKED_UP';

    case 'IN_TRANSIT':
    case 'IN_TRANSIT_LOCATION':
    case 'TRANSIT':
    case 'DISPATCHED':
    case 'OUT_FOR_DELIVERY':
    case 'REACHED_HUB':
    case 'HUB_REACHED':
      return 'IN_TRANSIT';

    case 'DELIVERED':
    case 'DLVD':
    case 'COMPLETED':
      return 'DELIVERED';

    case 'CANCELLED':
    case 'CANCELED':
    case 'CANCEL':
    case 'CNCL':
      return 'CANCELLED';

    case 'FAILED':
    case 'FAILURE':
    case 'UNDELIVERED':
    case 'RTO':
    case 'RETURNED':
    case 'REJECTED':
      return 'FAILED';

    default:
      return 'UNKNOWN';
  }
}

function parseIsoDateString(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const timestamp = typeof value === 'number'
      ? (value > 1_000_000_000_000 ? value : value * 1000)
      : Date.parse(value);
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return undefined;
}

function mapTrackingEvent(scanPayload: unknown, fallbackStatusAt: string): TrackingEvent | undefined {
  const scan = asRecord(scanPayload);
  if (!scan) {
    return undefined;
  }

  const rawStatus = firstValue([scan], [
    'status',
    'statusCode',
    'status_code',
    'scanType',
    'scan_type',
    'activity',
    'event'
  ]);
  const status = mapUrbaneBoltStatus(rawStatus);

  const rawDate = firstValue([scan], [
    'date',
    'scanDate',
    'scan_date',
    'statusDate',
    'status_date',
    'timestamp',
    'time',
    'updatedAt',
    'updated_at'
  ]);
  const status_at = parseIsoDateString(rawDate) ?? fallbackStatusAt;

  const location = stringValue(
    firstValue([scan], ['location', 'scanLocation', 'scan_location', 'city', 'hub'])
  );

  const description = stringValue(
    firstValue([scan], ['description', 'remarks', 'message', 'instructions', 'scanDescription', 'scan_description'])
  );

  return {
    status,
    status_at,
    ...(location === undefined ? {} : { location }),
    ...(description === undefined ? {} : { description })
  };
}

function mapTrackResponse(
  input: TrackShipmentInput,
  rawResponsePayload: unknown
): CourierTrackResult {
  const sources = responseSources(rawResponsePayload);

  const orderId = stringValue(
    firstValue(sources, ['orderNumber', 'order_number', 'orderId', 'order_id', 'merchant_order_id'])
  ) ?? input.courier_order_id ?? input.tracking_number;

  const trackingNumber = stringValue(
    firstValue(sources, ['awbNumber', 'awb_number', 'awb', 'tracking_number', 'trackingNumber'])
  ) ?? input.tracking_number;

  const rawStatus = firstValue(sources, [
    'status',
    'statusCode',
    'status_code',
    'currentStatus',
    'current_status',
    'shipmentStatus',
    'shipment_status',
    'state'
  ]);

  const status = mapUrbaneBoltStatus(rawStatus);

  const rawUpdatedAt = firstValue(sources, [
    'status_updated_at',
    'statusUpdatedAt',
    'statusDate',
    'status_date',
    'updatedAt',
    'updated_at',
    'timestamp',
    'date'
  ]);
  const status_updated_at = parseIsoDateString(rawUpdatedAt) ?? new Date().toISOString();

  let scansArray: unknown[] | undefined;
  for (const source of sources) {
    const candidate = firstValue([source], ['scans', 'scan_history', 'history', 'events', 'tracking_history']);
    if (Array.isArray(candidate)) {
      scansArray = candidate;
      break;
    }
  }

  const events: TrackingEvent[] = [];
  if (Array.isArray(scansArray)) {
    for (const scanItem of scansArray) {
      const event = mapTrackingEvent(scanItem, status_updated_at);
      if (event) {
        events.push(event);
      }
    }
  }

  return {
    response: {
      order_id: orderId,
      courier_partner: URBANEBOLT_COURIER_PARTNER,
      tracking_number: trackingNumber,
      status,
      status_updated_at,
      events
    },
    raw_response: rawResponsePayload
  };
}

function isAlreadyCancelledMessage(message: unknown): boolean {
  if (typeof message !== 'string') {
    return false;
  }
  const lower = message.toLowerCase();
  return lower.includes('already cancelled')
    || lower.includes('already canceled')
    || (lower.includes('already') && lower.includes('cancel'));
}

function mapCancelResponse(
  input: CancelShipmentInput,
  rawRequestPayload: unknown,
  rawResponsePayload: unknown
): CourierCancelResult {
  const root = asRecord(rawResponsePayload);
  const sources = responseSources(rawResponsePayload);

  const successfulItems = root?.successResponse;
  const successfulItem = Array.isArray(successfulItems) && successfulItems.length > 0
    ? asRecord(successfulItems[0])
    : undefined;

  const courierOrderId = stringValue(
    successfulItem?.orderNumber ?? firstValue(sources, ['orderNumber', 'order_number', 'orderId', 'order_id'])
  ) ?? input.courier_order_id ?? input.tracking_number;

  const trackingNumber = stringValue(
    successfulItem?.awbNumber ?? firstValue(sources, ['awbNumber', 'awb_number', 'awb', 'tracking_number'])
  ) ?? input.tracking_number;

  if (successfulItem) {
    return {
      response: {
        order_id: courierOrderId,
        courier_partner: URBANEBOLT_COURIER_PARTNER,
        tracking_number: trackingNumber,
        status: 'CANCELLED'
      },
      raw_response: rawResponsePayload
    };
  }

  const failureItems = root?.failureResponse ?? root?.errorResponse ?? root?.errors;
  const failureItem = Array.isArray(failureItems) && failureItems.length > 0
    ? asRecord(failureItems[0])
    : undefined;

  const failureMsg = stringValue(
    failureItem?.message ?? failureItem?.error ?? failureItem?.reason ?? root?.message ?? root?.error
  );

  if (failureMsg && isAlreadyCancelledMessage(failureMsg)) {
    return {
      response: {
        order_id: courierOrderId,
        courier_partner: URBANEBOLT_COURIER_PARTNER,
        tracking_number: trackingNumber,
        status: 'CANCELLED'
      },
      raw_response: rawResponsePayload
    };
  }

  throw new CourierProviderError({
    operation: 'cancel',
    kind: 'client',
    message: failureMsg ?? 'Courier cancel response did not contain a successful cancellation',
    retryable: false,
    rawRequestPayload,
    rawResponsePayload
  });
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
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function responseSources(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  const nested = root ? asRecord(root.data) : undefined;

  if (!root) {
    return [];
  }

  return nested ? [nested, root] : [root];
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

  async trackShipment(input: TrackShipmentInput): Promise<CourierTrackResult> {
    if (typeof input.tracking_number !== 'string' || input.tracking_number.trim().length === 0) {
      throw new CourierProviderError({
        operation: 'track',
        kind: 'client',
        message: 'UrbaneBolt track request requires tracking_number',
        retryable: false
      });
    }

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${TRACK_SHIPMENT_PATH}?awb=${encodeURIComponent(
      input.tracking_number.trim()
    )}`;

    const result = await this.authenticatedRequest<unknown>({
      operation: 'track',
      method: 'GET',
      url,
      timeoutMs: this.config.requestTimeoutMs
    });

    return mapTrackResponse(input, result.response.payload);
  }

  async cancelShipment(input: CancelShipmentInput): Promise<CourierCancelResult> {
    if (typeof input.tracking_number !== 'string' || input.tracking_number.trim().length === 0) {
      throw new CourierProviderError({
        operation: 'cancel',
        kind: 'client',
        message: 'UrbaneBolt cancel request requires tracking_number',
        retryable: false
      });
    }

    const payload = { awbs: input.tracking_number.trim() };
    const result = await this.authenticatedRequest<unknown>({
      operation: 'cancel',
      method: 'POST',
      url: `${this.config.baseUrl.replace(/\/+$/, '')}${CANCEL_SHIPMENT_PATH}`,
      payload,
      timeoutMs: this.config.requestTimeoutMs
    });

    return mapCancelResponse(input, result.request.payload, result.response.payload);
  }
}
