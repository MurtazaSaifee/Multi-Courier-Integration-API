# API Examples & Usage Guide

This guide shows sample `curl` commands and JSON responses for all endpoints in the Multi-Courier Integration API.

---

## Variable Placeholders Used Below

| Variable | Example | What it is |
|---|---|---|
| `{{baseUrl}}` | `http://localhost:3000` | The base URL of the API server |
| `{{orderId}}` | `ORD-2026-0722-001` | The unique order ID |

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
  "status": "ok"
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
    "order_id": "ORD-2026-0722-001",
    "courier_partner": "urbanebolt",
    "service_type": "express",
    "sender": {
      "name": "Acme Warehouse",
      "phone": "+919876543210",
      "email": "dispatch@acme.example",
      "street": "Plot 42, Industrial Area Phase 1",
      "city": "Mumbai",
      "state": "Maharashtra",
      "country": "IN",
      "postal_code": "400001"
    },
    "recipient": {
      "name": "Jane Doe",
      "phone": "+919123456789",
      "email": "jane.doe@example.com",
      "street": "Flat 302, Sunrise Apartments",
      "city": "Bengaluru",
      "state": "Karnataka",
      "country": "IN",
      "postal_code": "560001"
    },
    "package": {
      "description": "Electronics - Headphones",
      "pieces": 1,
      "weight": 1.5,
      "length": 20,
      "breadth": 15,
      "height": 10
    },
    "payment": {
      "mode": "PREPAID",
      "amount_to_collect": 0
    }
  }'
```

#### Example Response (201 Created):
```json
{
  "order_id": "ORD-2026-0722-001",
  "courier_partner": "urbanebolt",
  "courier_order_id": "UB-MANIFEST-98765",
  "tracking_number": "UB-TRK-12345678",
  "status": "CREATED"
}
```

#### Example Response (Sending Same Request Again - 200 OK):
If you re-send the exact same payload with `ORD-2026-0722-001`, the API returns the existing order instead of making a duplicate shipment:
```json
{
  "order_id": "ORD-2026-0722-001",
  "courier_partner": "urbanebolt",
  "courier_order_id": "UB-MANIFEST-98765",
  "tracking_number": "UB-TRK-12345678",
  "status": "CREATED"
}
```

#### Example Error Response — Missing Fields (400 Bad Request):
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "code": "invalid_type",
        "expected": "string",
        "received": "undefined",
        "path": ["service_type"],
        "message": "Required"
      }
    ],
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
    "message": "The courier partner rejected the order request",
    "details": [],
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
  "courier_partner": "urbanebolt",
  "tracking_number": "UB-TRK-12345678",
  "status": "IN_TRANSIT",
  "status_updated_at": "2026-07-22T12:30:00.000Z",
  "events": [
    {
      "status": "CREATED",
      "status_at": "2026-07-22T12:05:00.000Z",
      "description": "Shipment manifest generated"
    },
    {
      "status": "IN_TRANSIT",
      "status_at": "2026-07-22T12:30:00.000Z",
      "location": "Mumbai Hub",
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
    "message": "Order not found",
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
  "courier_partner": "urbanebolt",
  "tracking_number": "UB-TRK-12345678",
  "status": "CANCELLED"
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
      "order_id": "BULK-2026-001",
      "courier_partner": "urbanebolt",
      "service_type": "express",
      "sender": {
        "name": "Acme Warehouse",
        "phone": "+919876543210",
        "street": "Industrial Area",
        "city": "Mumbai",
        "state": "Maharashtra",
        "country": "IN",
        "postal_code": "400001"
      },
      "recipient": {
        "name": "Alice Smith",
        "phone": "+919111111111",
        "street": "Main Street 1",
        "city": "Delhi",
        "state": "Delhi",
        "country": "IN",
        "postal_code": "110001"
      },
      "package": {
        "description": "Item 1",
        "pieces": 1,
        "weight": 1.0
      },
      "payment": {
        "mode": "PREPAID"
      }
    },
    {
      "order_id": "BULK-2026-002",
      "courier_partner": "urbanebolt",
      "service_type": "standard",
      "sender": {
        "name": "Acme Warehouse",
        "phone": "+919876543210",
        "street": "Industrial Area",
        "city": "Mumbai",
        "state": "Maharashtra",
        "country": "IN",
        "postal_code": "400001"
      },
      "recipient": {
        "name": "Bob Jones",
        "phone": "+919222222222",
        "street": "Park Road 5",
        "city": "Chennai",
        "state": "Tamil Nadu",
        "country": "IN",
        "postal_code": "600001"
      },
      "package": {
        "description": "Item 2",
        "pieces": 1,
        "weight": 2.0
      },
      "payment": {
        "mode": "PREPAID"
      }
    }
  ]'
```

#### Example Response (200 OK):
```json
[
  {
    "order_id": "BULK-2026-001",
    "status": "SUCCESS",
    "response": {
      "order_id": "BULK-2026-001",
      "courier_partner": "urbanebolt",
      "courier_order_id": "UB-MANIFEST-990011",
      "tracking_number": "UB-TRK-990011",
      "status": "CREATED"
    }
  },
  {
    "order_id": "BULK-2026-002",
    "status": "SUCCESS",
    "response": {
      "order_id": "BULK-2026-002",
      "courier_partner": "urbanebolt",
      "courier_order_id": "UB-MANIFEST-990022",
      "tracking_number": "UB-TRK-990022",
      "status": "CREATED"
    }
  }
]
```
