# API Examples & Usage Guide

This guide shows sample `curl` commands and JSON responses for all endpoints in the Multi-Courier Integration API.

---

## Variable Placeholders Used Below

| Variable | Example | What it is |
|---|---|---|
| `{{baseUrl}}` | `http://localhost:3000` | The base URL of the API server |
| `{{merchantOrderId}}` | `ORD-2026-0722-001` | Your unique order reference ID |
| `{{orderId}}` | `ORD-2026-0722-001` | The order ID used in URL parameters |

---

## 1. Health Check

### `GET /health`
Checks if the server and database are running properly.

#### Example Request:
```bash
curl -X GET "http://localhost:3000/health" \
  -H "Accept: application/json"
```

#### Example Response (200 OK):
```json
{
  "status": "OK",
  "timestamp": "2026-07-22T12:00:00.000Z",
  "environment": "development"
}
```

---

## 2. Create Order / Shipment

### `POST /api/v1/orders`
Creates a new shipment with a courier partner (e.g. `urbanebolt`).

#### Example Request (Success Case):
```bash
curl -X POST "http://localhost:3000/api/v1/orders" \
  -H "Content-Type: application/json" \
  -d '{
    "merchant_order_id": "ORD-2026-0722-001",
    "courier_partner": "urbanebolt",
    "service_type": "EXPRESS",
    "sender": {
      "name": "Acme Warehouse",
      "phone": "+919876543210",
      "email": "dispatch@acme.example",
      "address_line1": "Plot 42, Industrial Area Phase 1",
      "city": "Mumbai",
      "state": "Maharashtra",
      "postal_code": "400001",
      "country": "IN"
    },
    "recipient": {
      "name": "Jane Doe",
      "phone": "+919123456789",
      "email": "jane.doe@example.com",
      "address_line1": "Flat 302, Sunrise Apartments",
      "city": "Bengaluru",
      "state": "Karnataka",
      "postal_code": "560001",
      "country": "IN"
    },
    "package_details": {
      "weight_kg": 1.5,
      "dimensions_cm": {
        "length": 20,
        "width": 15,
        "height": 10
      },
      "declared_value": 1500,
      "currency": "INR",
      "contents_description": "Electronics - Headphones"
    }
  }'
```

#### Example Response (201 Created):
```json
{
  "order_id": "ORD-2026-0722-001",
  "merchant_order_id": "ORD-2026-0722-001",
  "courier_partner": "urbanebolt",
  "courier_order_id": "UB-MANIFEST-98765",
  "tracking_number": "UB-TRK-12345678",
  "status": "PENDING",
  "created_at": "2026-07-22T12:05:00.000Z"
}
```

#### Example Response (Sending Same Request Again - 200 OK):
If you re-send the exact same payload with `ORD-2026-0722-001`, the API returns the existing order instead of making a duplicate shipment:
```json
{
  "order_id": "ORD-2026-0722-001",
  "merchant_order_id": "ORD-2026-0722-001",
  "courier_partner": "urbanebolt",
  "courier_order_id": "UB-MANIFEST-98765",
  "tracking_number": "UB-TRK-12345678",
  "status": "PENDING",
  "created_at": "2026-07-22T12:05:00.000Z"
}
```

#### Example Error Response — Missing Fields (400 Bad Request):
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid order request payload",
    "details": {
      "issues": [
        {
          "field": "service_type",
          "message": "Required"
        }
      ]
    },
    "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }
}
```

#### Example Error Response — Courier Error (422 Unprocessable Entity):
When the courier rejects the shipment (e.g. invalid pincode):
```json
{
  "error": {
    "code": "COURIER_REJECTED",
    "message": "UrbaneBolt rejected shipment creation: Destination pincode unserviceable",
    "details": {
      "courier_partner": "urbanebolt",
      "provider_code": "UNSERVICEABLE_PINCODE"
    },
    "request_id": "b2c3d4e5-f6a7-8901-bcde-f23456789012"
  }
}
```

---

## 3. Track Order

### `GET /api/v1/orders/:order_id/track`
Fetches the current status and full scan event history for an order.

#### Example Request:
```bash
curl -X GET "http://localhost:3000/api/v1/orders/ORD-2026-0722-001/track" \
  -H "Accept: application/json"
```

#### Example Response (200 OK):
```json
{
  "order_id": "ORD-2026-0722-001",
  "tracking_number": "UB-TRK-12345678",
  "status": "IN_TRANSIT",
  "courier_partner": "urbanebolt",
  "last_updated": "2026-07-22T12:30:00.000Z",
  "events": [
    {
      "status": "PENDING",
      "timestamp": "2026-07-22T12:05:00.000Z",
      "description": "Shipment manifest generated"
    },
    {
      "status": "IN_TRANSIT",
      "timestamp": "2026-07-22T12:30:00.000Z",
      "description": "Package scanned at Mumbai Hub"
    }
  ]
}
```

#### Example Error Response — Order Not Found (404 Not Found):
```json
{
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "Order with ID 'ORD-NON-EXISTENT' was not found",
    "request_id": "c3d4e5f6-a7b8-9012-cdef-345678901234"
  }
}
```

---

## 4. Cancel Order

### `POST /api/v1/orders/:order_id/cancel`
Cancels an order with the courier partner.

#### Example Request:
```bash
curl -X POST "http://localhost:3000/api/v1/orders/ORD-2026-0722-001/cancel" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Customer requested cancellation before dispatch"
  }'
```

#### Example Response (200 OK):
```json
{
  "order_id": "ORD-2026-0722-001",
  "tracking_number": "UB-TRK-12345678",
  "status": "CANCELLED",
  "cancelled_at": "2026-07-22T12:45:00.000Z"
}
```

#### Example Response — Cancelling an Already Cancelled Order (200 OK):
If the order is already cancelled, it returns success without throwing an error:
```json
{
  "order_id": "ORD-2026-0722-001",
  "tracking_number": "UB-TRK-12345678",
  "status": "CANCELLED",
  "cancelled_at": "2026-07-22T12:45:00.000Z"
}
```

---

## 5. Bulk Order Processing

### `POST /api/v1/orders/bulk`
Processes up to 100 orders in a single request.

#### Example Request:
```bash
curl -X POST "http://localhost:3000/api/v1/orders/bulk" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "merchant_order_id": "BULK-2026-001",
      "courier_partner": "urbanebolt",
      "service_type": "EXPRESS",
      "sender": {
        "name": "Acme Warehouse",
        "phone": "+919876543210",
        "address_line1": "Industrial Area",
        "city": "Mumbai",
        "state": "Maharashtra",
        "postal_code": "400001",
        "country": "IN"
      },
      "recipient": {
        "name": "Alice Smith",
        "phone": "+919111111111",
        "address_line1": "Main Street 1",
        "city": "Delhi",
        "state": "Delhi",
        "postal_code": "110001",
        "country": "IN"
      },
      "package_details": {
        "weight_kg": 1.0,
        "declared_value": 500
      }
    },
    {
      "merchant_order_id": "BULK-2026-002",
      "courier_partner": "urbanebolt",
      "service_type": "STANDARD",
      "sender": {
        "name": "Acme Warehouse",
        "phone": "+919876543210",
        "address_line1": "Industrial Area",
        "city": "Mumbai",
        "state": "Maharashtra",
        "postal_code": "400001",
        "country": "IN"
      },
      "recipient": {
        "name": "Bob Jones",
        "phone": "+919222222222",
        "address_line1": "Park Road 5",
        "city": "Chennai",
        "state": "Tamil Nadu",
        "postal_code": "600001",
        "country": "IN"
      },
      "package_details": {
        "weight_kg": 2.0,
        "declared_value": 1200
      }
    }
  ]'
```

#### Example Response (200 OK):
```json
{
  "total": 2,
  "successful": 2,
  "failed": 0,
  "results": [
    {
      "merchant_order_id": "BULK-2026-001",
      "status": "SUCCESS",
      "order_id": "BULK-2026-001",
      "tracking_number": "UB-TRK-990011",
      "courier_partner": "urbanebolt"
    },
    {
      "merchant_order_id": "BULK-2026-002",
      "status": "SUCCESS",
      "order_id": "BULK-2026-002",
      "tracking_number": "UB-TRK-990022",
      "courier_partner": "urbanebolt"
    }
  ]
}
```

#### Example Error Response — Sending More Than 100 Orders (400 Bad Request):
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Bulk order request batch exceeds maximum limit of 100 orders",
    "request_id": "d4e5f6a7-b8c9-0123-def0-456789012345"
  }
}
```
