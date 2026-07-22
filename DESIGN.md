# Architecture & Design

This document explains how the Multi-Courier Integration API is structured, how data is saved, and why certain technical choices were made.

---

## 1. Overview

The goal of this service is to give e-commerce applications one single REST API to talk to multiple courier partners (like UrbaneBolt). 

Different couriers use completely different API paths, login methods, request formats, and status names. Instead of putting courier-specific logic inside our API routes, everything provider-specific is wrapped inside adapter modules. The main application only deals with standardized domain models.

### Key goals:
- **Keep couriers separate**: Adding a new courier only requires adding a new adapter. Route handlers and business logic don't change.
- **Prevent duplicate orders**: Use database locks so identical order requests don't create multiple shipments with the courier.
- **Save audit logs**: Keep full raw requests and responses from the courier so we can debug issues easily.

---

## 2. Architecture & The Adapter Pattern

Here is how a request flows through the app:

```
  Client (Store / App)
         │
         ▼
  Express Routes + Zod Validation
         │
         ▼
  Order Service & Repositories ──► PostgreSQL Database
         │
         ▼
  Courier Registry
         │
         ├──► UrbaneBolt Adapter ──► UrbaneBolt API
         │
         └──► MockCourier Adapter
```

### The `CourierAdapter` Interface

Every courier adapter implements three main methods:

- `createShipment(request)`: Takes standard order data, converts it to the courier's format, sends the request, and returns a unified response.
- `trackShipment(input)`: Fetches tracking status from the courier and maps provider-specific codes to standard statuses (`CREATED`, `PICKED_UP`, `IN_TRANSIT`, `DELIVERED`, `CANCELLED`, `FAILED`, `UNKNOWN`).
- `cancelShipment(trackingNumber)`: Sends a cancel request to the courier. If the order is already cancelled, it returns a clean success response without throwing an error.

### UrbaneBolt Adapter Details
- **Token Login**: Logs in using configured credentials and saves the auth token in memory until it expires. If an API call fails with a 401 Unauthorized error, it clears the token and tries logging in again once.
- **Security**: Auth tokens and passwords are only stored in memory. They are never saved to the database or written to log files.
- **Strict UAT contract**: The adapter reads the published and live-tested UrbaneBolt UAT fields directly. For example, tracking uses `data.currentStatusCode`, `currentStatusDateTime`, and `scans`; observed `MAN` maps to `CREATED` and `CAN` maps to `CANCELLED`. Unrecognised provider codes map to `UNKNOWN`.
- **Boundary ownership**: The shared courier interface remains generic. UrbaneBolt request names and response fields stay inside this adapter rather than being made generic across the application.

---

## 3. Database Schema

The database uses PostgreSQL with Knex.js. It has two main tables:

### Table 1: `orders`

Stores current order state and details:

- `id`: Primary key (auto-incrementing integer)
- `merchant_order_id`: Unique order ID sent by the client (used for idempotency)
- `courier_partner`: Courier name (e.g. `urbanebolt`)
- `courier_order_id`: Order ID returned by the courier
- `tracking_number`: Shipment tracking number
- `status`: Current standard status (`CREATED`, `PICKED_UP`, `IN_TRANSIT`, `DELIVERED`, `CANCELLED`, `FAILED`, `UNKNOWN`)
- `service_type`: Delivery tier (e.g. `EXPRESS`, `STANDARD`)
- `normalized_request`: JSON snapshot of the standard request payload
- `raw_courier_request`: Raw JSON payload sent to the courier
- `raw_courier_response`: Raw JSON payload received back from the courier
- `failure_reason`: Error description if the order creation failed
- `failure_code`: Standard error code if failed
- `created_at` / `updated_at`: Timestamps
- `deleted_at`: Timestamp used for soft deleting orders

### Table 2: `tracking_history`

Appends tracking scan events as they happen:

- `id`: Primary key
- `order_id`: Foreign key pointing to `orders.id`
- `status`: Standard status for this event
- `event_timestamp`: Timestamp when the scan event occurred
- `description`: Event notes or location details
- `raw_payload`: Full raw JSON response from the courier tracking scan
- `created_at`: Insertion timestamp

### Indexes & Rules
- `merchant_order_id` has a UNIQUE constraint on the `orders` table to stop duplicate orders.
- A composite unique constraint on `(order_id, status, event_timestamp)` in `tracking_history` prevents saving the exact same scan event twice.

---

## 4. How Duplicate Prevention (Idempotency) Works

When a client sends a request to `POST /api/v1/orders`:

1. **Reserve first**: The app immediately saves a record with `status = 'PENDING'` in PostgreSQL.
2. **Check for duplicates**:
   - If `merchant_order_id` already exists with the same request data, the app returns the existing order right away without calling the courier again.
   - If `merchant_order_id` exists but the request data is different, the API returns a `409 Conflict` error.
3. **Call courier**: Once reserved, the courier adapter makes the HTTP call.
4. **Update database**: The order record is updated with the tracking number, courier order ID, and final status. If the courier call fails, the status is set to `FAILED`.

---

## 5. Bulk Order Processing

`POST /api/v1/orders/bulk` accepts an array of up to 100 orders:

- **Controlled concurrency**: Processes orders in parallel using a small concurrency limit (`BULK_CONCURRENCY = 5`).
- **Isolated failures**: Each item runs in its own try/catch block and database transaction. If order #2 fails, order #1 and order #3 still complete normally.
- **Single response**: Returns `200 OK` with an array showing the outcome (`SUCCESS` or `FAILED`) for each order in the batch.

---

## 6. Retries and Error Handling

### Retry Policy
Outbound HTTP calls to couriers use a retry helper for temporary errors (network drops, timeouts, or 5xx server errors):
- Retries up to 2 times (3 total attempts) with a short delay (`250ms` initial wait).
- Client errors (like 400 Bad Request or 422 Unprocessable Entity) are not retried because sending the same bad data won't fix them.

### Error Format
All errors return a standard JSON structure:

```json
{
  "error": {
    "code": "COURIER_REJECTED",
    "message": "UrbaneBolt rejected shipment: Pincode not serviceable",
    "details": {
      "courier_partner": "urbanebolt",
      "provider_code": "INVALID_PINCODE"
    },
    "request_id": "c7a840e6-527e-4171-a5b6-75ab61eef345"
  }
}
```

---

## 7. Trade-offs & Next Steps

1. **In-memory bulk vs Job Queue**:
   - *Current implementation*: Runs bulk requests in memory using bounded promises. This keeps things simple and gives immediate API responses for batches up to 100 items.
   - *Future improvement*: For processing thousands of orders asynchronously, we could add a BullMQ/Redis background worker queue.
2. **Polling vs Webhooks**:
   - *Current implementation*: Tracking status is updated whenever a client calls `GET /api/v1/orders/:id/track`.
   - *Future improvement*: Add a webhook listener endpoint so couriers can push status updates to us automatically.
