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
import { withRetry } from '../retry-helper.js';

export const URBANEBOLT_COURIER_PARTNER = 'urbanebolt';
const AUTHENTICATION_PATH = '/api/v1/auth/getToken/';
const CREATE_SHIPMENT_PATH = '/api/v1/services/manifest/';
const TRACK_SHIPMENT_PATH = '/api/v1/services/tracking-pub/';
const CANCEL_SHIPMENT_PATH = '/api/v1/services/cancel/';

export type UrbaneBoltAdapterConfig = {
  baseUrl: string;
  username: string;
  password: string;
  customerCode?: string;
  requestTimeoutMs: number;
  retryCount?: number;
  retryDelayMs?: number;
};

export type UrbaneBoltAdapterOptions = {
  config: UrbaneBoltAdapterConfig;
  httpClient?: ProviderHttpClient;
  sleepFn?: (ms: number) => Promise<void>;
};

type AuthenticatedRequestOptions = Omit<ProviderHttpRequestOptions, 'headers'> & {
  headers?: Record<string, string>;
};

type UrbaneBoltManifestPayload = Record<string, unknown>;

type UrbaneBoltAuthenticationResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
};

type UrbaneBoltManifestResponse = {
  successResponse?: unknown;
};

type UrbaneBoltManifestSuccessItem = {
  orderNumber?: unknown;
  awbNumber?: unknown;
};

type UrbaneBoltTrackingScan = {
  statusCode?: unknown;
  statusCodeDescription?: unknown;
  statusDateTime?: unknown;
  currentLocation?: unknown;
};

type UrbaneBoltTrackingData = {
  currentStatusCode?: unknown;
  currentStatusDateTime?: unknown;
  scans?: unknown;
};

type UrbaneBoltTrackingResponse = {
  data?: unknown;
};

type UrbaneBoltCancellationResponse = {
  successResponse?: unknown;
  failureResponse?: unknown;
};

type UrbaneBoltCancellationItem = {
  orderNumber?: unknown;
  awb?: unknown;
  message?: unknown;
};

const URBANEBOLT_SERVICE_TYPES = ['SSDD', 'SDD', 'NDD', 'ATA', 'PTP', '2HR'] as const;

function mapAddress(
  prefix: 'shpr' | 'cons' | 'rtn',
  address: Address,
  addressType?: string
): UrbaneBoltManifestPayload {
  return {
    [`${prefix}Name`]: address.name,
    [`${prefix}Mobile`]: normalizeMobile(address.phone),
    [`${prefix}Address`]: address.street,
    ...(addressType === undefined ? {} : { [`${prefix}AddressType`]: addressType }),
    [`${prefix}City`]: address.city,
    [`${prefix}State`]: address.state,
    [`${prefix}Country`]: address.country,
    [`${prefix}Pincode`]: address.postal_code,
    ...(address.email === undefined ? {} : { [`${prefix}Email`]: address.email })
  };
}

function normalizeServiceType(value: string): string {
  const serviceType = value.trim().toUpperCase();
  if ((URBANEBOLT_SERVICE_TYPES as readonly string[]).includes(serviceType)) {
    return serviceType;
  }

  throw invalidCreateRequest(
    `UrbaneBolt service_type must be one of: ${URBANEBOLT_SERVICE_TYPES.join(', ')}`
  );
}

function normalizeMobile(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
}

function normalizePaymentMode(value: string): string {
  const paymentMode = value.trim().toUpperCase();
  const mappedMode = paymentMode === 'PREPAID' ? 'PPD' : paymentMode;
  const supportedModes = ['PPD', 'COD', 'RVP', 'RVPQC'];

  if (supportedModes.includes(mappedMode)) {
    return mappedMode;
  }

  throw invalidCreateRequest(
    `UrbaneBolt payment.mode must be one of: ${supportedModes.join(', ')}`
  );
}

function mapCreateRequest(
  request: CreateOrderRequest,
  serviceType: string,
  paymentMode: string,
  customerCode?: string
): UrbaneBoltManifestPayload {
  const returnAddress = request.return_address ?? request.sender;
  const invoiceValue = request.invoice?.value ?? 0;

  return {
    ...(customerCode === undefined ? {} : { customerCode }),
    orderNumber: request.order_id,
    serviceType,
    ...mapAddress('shpr', request.sender, 'Office'),
    ...mapAddress('cons', request.recipient, 'Home'),
    ...mapAddress('rtn', returnAddress),
    itemDescription: request.package.description,
    pieces: request.package.pieces,
    itemQuantity: request.package.pieces,
    weight: request.package.weight,
    ...(request.package.length === undefined ? {} : { length: request.package.length }),
    ...(request.package.breadth === undefined ? {} : { breadth: request.package.breadth }),
    ...(request.package.height === undefined ? {} : { height: request.package.height }),
    payMode: paymentMode,
    collectableValue: request.payment.amount_to_collect ?? 0,
    declaredValue: invoiceValue,
    invoiceValue,
    ...(request.invoice === undefined ? {} : {
      invoiceNumber: request.invoice.invoice_number,
      invoiceDate: request.invoice.invoice_date
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
  const response = asUrbaneBoltManifestResponse(rawResponsePayload);
  const successfulShipments = response?.successResponse;
  const successfulShipment = Array.isArray(successfulShipments)
    ? asUrbaneBoltManifestSuccessItem(successfulShipments[0])
    : undefined;
  const courierOrderId = requiredString(successfulShipment?.orderNumber);
  const trackingNumber = requiredUrbaneBoltIdentifier(successfulShipment?.awbNumber);

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
  if (typeof rawStatus !== 'string') {
    return 'UNKNOWN';
  }

  const normalized = rawStatus.trim().toUpperCase();

  switch (normalized) {
    case 'MAN':
      return 'CREATED';

    case 'CAN':
      return 'CANCELLED';

    default:
      return 'UNKNOWN';
  }
}

function parseUrbaneBoltTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4}), (\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.indexOf(match[2]);
  if (month < 0) {
    return undefined;
  }

  const parsed = new Date(Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]) - 5,
    Number(match[5]) - 30
  ));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function mapTrackingEvent(scanPayload: unknown): TrackingEvent | undefined {
  const scan = asUrbaneBoltTrackingScan(scanPayload);
  const status = mapUrbaneBoltStatus(scan?.statusCode);
  const status_at = parseUrbaneBoltTimestamp(scan?.statusDateTime);
  const location = optionalString(scan?.currentLocation);
  const description = requiredString(scan?.statusCodeDescription);

  if (!scan || !status_at || !description) {
    return undefined;
  }

  return {
    status,
    status_at,
    ...(location === undefined ? {} : { location }),
    description
  };
}

function mapTrackResponse(
  input: TrackShipmentInput,
  rawResponsePayload: unknown
): CourierTrackResult {
  const response = asUrbaneBoltTrackingResponse(rawResponsePayload);
  const data = asUrbaneBoltTrackingData(response?.data);
  const status_updated_at = parseUrbaneBoltTimestamp(data?.currentStatusDateTime);

  if (!data || !status_updated_at || !Array.isArray(data.scans)) {
    throw invalidProviderResponse('track', 'Courier track response did not match the UrbaneBolt UAT shape', rawResponsePayload);
  }

  const mappedEvents = data.scans.map(mapTrackingEvent);
  if (mappedEvents.some((event) => event === undefined)) {
    throw invalidProviderResponse('track', 'Courier track response contained an invalid UrbaneBolt scan', rawResponsePayload);
  }
  const events = mappedEvents as TrackingEvent[];

  return {
    response: {
      order_id: input.courier_order_id ?? input.tracking_number,
      courier_partner: URBANEBOLT_COURIER_PARTNER,
      tracking_number: input.tracking_number,
      status: mapUrbaneBoltStatus(data.currentStatusCode),
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
  const response = asUrbaneBoltCancellationResponse(rawResponsePayload);
  const successfulItems = response?.successResponse;
  const successfulItem = Array.isArray(successfulItems) && successfulItems.length > 0
    ? asUrbaneBoltCancellationItem(successfulItems[0])
    : undefined;

  if (successfulItem) {
    const courierOrderId = requiredString(successfulItem.orderNumber);
    const trackingNumber = requiredUrbaneBoltIdentifier(successfulItem.awb);
    if (!courierOrderId || !trackingNumber) {
      throw invalidProviderResponse('cancel', 'Courier cancel response did not contain UrbaneBolt shipment identifiers', rawResponsePayload);
    }

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

  const failureItems = response?.failureResponse;
  const failureItem = Array.isArray(failureItems) && failureItems.length > 0
    ? asUrbaneBoltCancellationItem(failureItems[0])
    : undefined;

  const failureMsg = requiredString(failureItem?.message);

  if (failureMsg && isAlreadyCancelledMessage(failureMsg)) {
    return {
      response: {
        order_id: input.courier_order_id ?? input.tracking_number,
        courier_partner: URBANEBOLT_COURIER_PARTNER,
        tracking_number: input.tracking_number,
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
      customerCode: appConfig.urbanebolt.customerCode,
      requestTimeoutMs: appConfig.requestTimeoutMs,
      retryCount: appConfig.retryCount,
      retryDelayMs: appConfig.retryDelayMs
    },
    httpClient: requestProviderJson
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredUrbaneBoltIdentifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return requiredString(value);
}

function parseAuthenticationResult(payload: unknown): CourierAuthenticationResult | undefined {
  const response = asUrbaneBoltAuthenticationResponse(payload);
  const accessToken = requiredString(response?.access_token);
  const expiresIn = response?.expires_in;
  const tokenType = requiredString(response?.token_type);
  const expiresAt = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000)
    : undefined;

  if (!accessToken || !tokenType || !expiresAt || expiresAt.getTime() <= Date.now()) {
    return undefined;
  }

  return {
    access_token: accessToken,
    token_type: tokenType,
    expires_at: expiresAt
  };
}

function asUrbaneBoltAuthenticationResponse(value: unknown): UrbaneBoltAuthenticationResponse | undefined {
  return asRecord(value) as UrbaneBoltAuthenticationResponse | undefined;
}

function asUrbaneBoltManifestResponse(value: unknown): UrbaneBoltManifestResponse | undefined {
  return asRecord(value) as UrbaneBoltManifestResponse | undefined;
}

function asUrbaneBoltManifestSuccessItem(value: unknown): UrbaneBoltManifestSuccessItem | undefined {
  return asRecord(value) as UrbaneBoltManifestSuccessItem | undefined;
}

function asUrbaneBoltTrackingResponse(value: unknown): UrbaneBoltTrackingResponse | undefined {
  return asRecord(value) as UrbaneBoltTrackingResponse | undefined;
}

function asUrbaneBoltTrackingData(value: unknown): UrbaneBoltTrackingData | undefined {
  return asRecord(value) as UrbaneBoltTrackingData | undefined;
}

function asUrbaneBoltTrackingScan(value: unknown): UrbaneBoltTrackingScan | undefined {
  return asRecord(value) as UrbaneBoltTrackingScan | undefined;
}

function asUrbaneBoltCancellationResponse(value: unknown): UrbaneBoltCancellationResponse | undefined {
  return asRecord(value) as UrbaneBoltCancellationResponse | undefined;
}

function asUrbaneBoltCancellationItem(value: unknown): UrbaneBoltCancellationItem | undefined {
  return asRecord(value) as UrbaneBoltCancellationItem | undefined;
}

function invalidProviderResponse(
  operation: CourierOperation,
  message: string,
  rawResponsePayload: unknown
): CourierProviderError {
  return new CourierProviderError({
    operation,
    kind: 'client',
    message,
    retryable: false,
    rawResponsePayload
  });
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
  private readonly sleepFn?: (ms: number) => Promise<void>;
  private cachedAuthentication?: CourierAuthenticationResult;
  private authenticationInFlight?: Promise<CourierAuthenticationResult>;

  constructor(options: UrbaneBoltAdapterOptions = defaultAdapterOptions()) {
    this.config = options.config;
    this.httpClient = options.httpClient ?? requestProviderJson;
    this.sleepFn = options.sleepFn;
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
    const retryCount = this.config.retryCount ?? appConfig.retryCount;
    const retryDelayMs = this.config.retryDelayMs ?? appConfig.retryDelayMs;

    const executeCall = async () => {
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
        this.authenticationInFlight = undefined;
        const refreshedAuthentication = await this.getAuthentication();
        return sendRequest(refreshedAuthentication);
      }
    };

    return withRetry(executeCall, {
      maxRetries: retryCount,
      initialDelayMs: retryDelayMs,
      sleep: this.sleepFn
    });
  }

  async createShipment(request: CreateOrderRequest): Promise<CourierCreateResult> {
    if (typeof request.service_type !== 'string' || request.service_type.trim().length === 0) {
      throw invalidCreateRequest('UrbaneBolt create request requires service_type');
    }

    const manifestPayload = [mapCreateRequest(
      request,
      normalizeServiceType(request.service_type),
      normalizePaymentMode(request.payment.mode),
      this.config.customerCode
    )];
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
