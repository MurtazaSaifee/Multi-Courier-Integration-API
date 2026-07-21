export const NORMALIZED_STATUSES = [
  'PENDING',
  'CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
  'FAILED',
  'UNKNOWN'
] as const;

export type NormalizedStatus = (typeof NORMALIZED_STATUSES)[number];

export type Address = {
  name: string;
  phone: string;
  email?: string;
  street: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
};

export type PackageDetails = {
  description: string;
  pieces: number;
  weight: number;
  length?: number;
  breadth?: number;
  height?: number;
};

export type PaymentDetails = {
  mode: string;
  amount_to_collect?: number;
};

export type InvoiceDetails = {
  invoice_number: string;
  invoice_date: string;
  value: number;
};

export type CreateOrderRequest = {
  order_id: string;
  courier_partner: string;
  service_type: string;
  sender: Address;
  recipient: Address;
  return_address?: Address;
  package: PackageDetails;
  payment: PaymentDetails;
  invoice?: InvoiceDetails;
};

export type CreateOrderResponse = {
  order_id: string;
  courier_partner: string;
  courier_order_id: string;
  tracking_number: string;
  status: NormalizedStatus;
};

export type ShipmentReference = {
  courier_order_id: string | null;
  tracking_number: string;
};

export type TrackShipmentInput = ShipmentReference;

export type CancelShipmentInput = ShipmentReference;

export type TrackingEvent = {
  status: NormalizedStatus;
  status_at: string;
  location?: string;
  description?: string;
};

export type TrackOrderResponse = {
  order_id: string;
  courier_partner: string;
  tracking_number: string;
  status: NormalizedStatus;
  status_updated_at: string;
  events: TrackingEvent[];
};

export type CancelOrderResponse = {
  order_id: string;
  courier_partner: string;
  tracking_number?: string;
  status: NormalizedStatus;
};

export type BulkCreateOrderRequest = CreateOrderRequest[];

export type BulkOrderSuccess = {
  order_id: string;
  success: true;
  result: CreateOrderResponse;
};

export type BulkOrderFailure = {
  order_id: string;
  success: false;
  error: NormalizedError;
};

export type BulkOrderResult = BulkOrderSuccess | BulkOrderFailure;

export type BulkCreateOrderResponse = {
  results: BulkOrderResult[];
};

export type CourierCreateResult = {
  response: CreateOrderResponse;
  raw_request: unknown;
  raw_response: unknown;
};

export type CourierTrackResult = {
  response: TrackOrderResponse;
  raw_response: unknown;
};

export type CourierCancelResult = {
  response: CancelOrderResponse;
  raw_response: unknown;
};

/** Private adapter result. This token must never be returned by a public endpoint. */
export type CourierAuthenticationResult = {
  access_token: string;
  token_type: string;
  expires_at: Date;
};

export type OrderRecord = {
  id: string;
  merchant_order_id: string;
  courier_partner: string;
  courier_order_id: string | null;
  tracking_number: string | null;
  status: NormalizedStatus;
  normalized_request: CreateOrderRequest;
  courier_request_payload: unknown | null;
  courier_response_payload: unknown | null;
  failure_code: string | null;
  failure_message: string | null;
  is_deleted: boolean;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type TrackingHistoryEvent = {
  order_id: string;
  status: NormalizedStatus;
  status_at: Date;
  raw_payload: unknown;
};

export type TrackingHistoryRecord = TrackingHistoryEvent & {
  id: string;
};

export type NormalizedErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_COURIER'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_ID_CONFLICT'
  | 'ORDER_IN_PROGRESS'
  | 'COURIER_REJECTED'
  | 'COURIER_AUTH_FAILED'
  | 'COURIER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type ErrorDetail = {
  field?: string;
  message: string;
  supported_values?: string[];
};

export type NormalizedError = {
  code: NormalizedErrorCode;
  message: string;
  details: ErrorDetail[];
  request_id: string;
};

export type ErrorResponse = {
  error: NormalizedError;
};
