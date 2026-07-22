# API Examples & Usage Guide

This guide shows sample `curl` commands and normalized local API responses for both supported courier partners: **UrbaneBolt** (`urbanebolt`) and **MockCourier** (`mockcourier`).

---

## Variable Placeholders Used Below

| Variable | Example | What it is |
|---|---|---|
| `{{baseUrl}}` | `http://localhost:3000` | The base URL of the API server |
| `{{orderId}}` | `ORD-2026-UB-001` | The unique order ID |

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
Creates a new shipment with a specified courier partner (`urbanebolt` or `mockcourier`).

### 2.1 UrbaneBolt Provider Example (`courier_partner: "urbanebolt"`)

#### Example Request:
```bash
curl -X POST "http://localhost:3000/api/v1/orders" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "ORD-2026-UB-001",
    "courier_partner": "urbanebolt",
    "service_type": "NDD",
    "sender": {
      "name": "Acme Warehouse",
      "phone": "+919876543210",
      "email": "dispatch@acme.example",
      "street": "Plot 42, Industrial Area Phase 1",
      "city": "Mumbai",
      "state": "Maharashtra",
      "country": "India",
      "postal_code": "400001"
    },
    "recipient": {
      "name": "Jane Doe",
      "phone": "+919123456789",
      "email": "jane.doe@example.com",
      "street": "Flat 302, Sunrise Apartments",
      "city": "Bengaluru",
      "state": "Karnataka",
      "country": "India",
      "postal_code": "560001"
    },
    "return_address": {
      "name": "Acme Returns",
      "phone": "+919876543212",
      "street": "Plot 42, Industrial Area Phase 1",
      "city": "Mumbai",
      "state": "Maharashtra",
      "country": "India",
      "postal_code": "400001"
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
    },
    "invoice": {
      "invoice_number": "ORD-2026-UB-001-INV",
      "invoice_date": "2026-07-22",
      "value": 100
    }
  }'
```

#### Example Response (201 Created):
```json
{
  "order_id": "ORD-2026-UB-001",
  "courier_partner": "urbanebolt",
  "courier_order_id": "ORD-2026-UB-001",
  "tracking_number": "200000006959",
  "status": "CREATED"
}
```

### 2.2 MockCourier Provider Example (`courier_partner: "mockcourier"`)

#### Example Request:
```bash
curl -X POST "http://localhost:3000/api/v1/orders" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "ORD-2026-MC-001",
    "courier_partner": "mockcourier",
    "service_type": "standard",
    "sender": {
      "name": "Logistics Depot",
      "phone": "+919876543210",
      "email": "depot@example.com",
      "street": "Warehouse Complex A",
      "city": "Delhi",
      "state": "Delhi",
      "country": "IN",
      "postal_code": "110001"
    },
    "recipient": {
      "name": "John Smith",
      "phone": "+919811122233",
      "email": "john.smith@example.com",
      "street": "10 Park Street",
      "city": "Kolkata",
      "state": "West Bengal",
      "country": "IN",
      "postal_code": "700016"
    },
    "package": {
      "description": "Books & Stationery",
      "pieces": 2,
      "weight": 2.0
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
  "order_id": "ORD-2026-MC-001",
  "courier_partner": "mockcourier",
  "courier_order_id": "MOCK-ORD-ORD-2026-MC-001",
  "tracking_number": "MOCK-TRK-ORD-2026-MC-001",
  "status": "CREATED"
}
```

#### Example Response (Idempotent Resubmission - 201 Created):
Sending the exact same payload returns the existing order:
```json
{
  "order_id": "ORD-2026-UB-001",
  "courier_partner": "urbanebolt",
  "courier_order_id": "ORD-2026-UB-001",
  "tracking_number": "200000006959",
  "status": "CREATED"
}
```

#### Example Error Response — Missing Required Field (400 Bad Request):
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

#### Example Error Response — Provider Rejection (422 Unprocessable Entity):
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

### 3.1 UrbaneBolt Order Tracking

#### Example Request:
```bash
curl -X GET "http://localhost:3000/api/v1/orders/ORD-2026-UB-001/track" \
  -H "Accept: application/json"
```

#### Example Response (200 OK):
```json
{
  "order_id": "ORD-2026-UB-001",
  "courier_partner": "urbanebolt",
  "tracking_number": "200000006959",
  "status": "CREATED",
  "status_updated_at": "2026-07-22T12:47:00.000Z",
  "events": [
    {
      "status": "CREATED",
      "status_at": "2026-07-22T12:47:00.000Z",
      "location": "Mumbai",
      "description": "Shipment Manifested"
    }
  ]
}
```

### 3.2 MockCourier Order Tracking

#### Example Request:
```bash
curl -X GET "http://localhost:3000/api/v1/orders/ORD-2026-MC-001/track" \
  -H "Accept: application/json"
```

#### Example Response (200 OK):
```json
{
  "order_id": "ORD-2026-MC-001",
  "courier_partner": "mockcourier",
  "tracking_number": "MOCK-TRK-ORD-2026-MC-001",
  "status": "IN_TRANSIT",
  "status_updated_at": "2026-07-22T17:00:00.000Z",
  "events": [
    {
      "status": "CREATED",
      "status_at": "2026-07-22T17:00:00.000Z",
      "description": "Shipment created at MockCourier hub"
    },
    {
      "status": "IN_TRANSIT",
      "status_at": "2026-07-22T17:00:00.000Z",
      "location": "Central Mock Hub",
      "description": "In transit"
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

### 4.1 UrbaneBolt Order Cancellation

#### Example Request:
```bash
curl -X POST "http://localhost:3000/api/v1/orders/ORD-2026-UB-001/cancel" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Customer requested cancellation before dispatch"
  }'
```

#### Example Response (200 OK):
```json
{
  "order_id": "ORD-2026-UB-001",
  "courier_partner": "urbanebolt",
  "tracking_number": "200000006959",
  "status": "CANCELLED"
}
```

### 4.2 MockCourier Order Cancellation

#### Example Request:
```bash
curl -X POST "http://localhost:3000/api/v1/orders/ORD-2026-MC-001/cancel" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Merchant cancelled order"
  }'
```

#### Example Response (200 OK):
```json
{
  "order_id": "ORD-2026-MC-001",
  "courier_partner": "mockcourier",
  "tracking_number": "MOCK-TRK-ORD-2026-MC-001",
  "status": "CANCELLED"
}
```

---

## 5. Bulk Order Processing

### `POST /api/v1/orders/bulk`
Processes up to 100 orders in a single request. Supports mixing different courier partners (`urbanebolt` and `mockcourier`) in the same batch.

#### Example Request (Mixed Couriers Batch):
```bash
curl -X POST "http://localhost:3000/api/v1/orders/bulk" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "order_id": "BULK-2026-UB-01",
      "courier_partner": "urbanebolt",
      "service_type": "NDD",
      "sender": {
        "name": "Acme Warehouse",
        "phone": "+919876543210",
        "street": "Industrial Area",
        "city": "Mumbai",
        "state": "Maharashtra",
        "country": "India",
        "postal_code": "400001"
      },
      "recipient": {
        "name": "Alice Smith",
        "phone": "+919111111111",
        "street": "Main Street 1",
        "city": "Delhi",
        "state": "Delhi",
        "country": "India",
        "postal_code": "110001"
      },
      "return_address": {
        "name": "Acme Returns",
        "phone": "+919876543212",
        "street": "Industrial Area",
        "city": "Mumbai",
        "state": "Maharashtra",
        "country": "India",
        "postal_code": "400001"
      },
      "package": {
        "description": "Item 1",
        "pieces": 1,
        "weight": 1.0,
        "length": 20,
        "breadth": 15,
        "height": 10
      },
      "payment": {
        "mode": "PREPAID",
        "amount_to_collect": 0
      },
      "invoice": {
        "invoice_number": "BULK-2026-UB-01-INV",
        "invoice_date": "2026-07-22",
        "value": 100
      }
    },
    {
      "order_id": "BULK-2026-MC-02",
      "courier_partner": "mockcourier",
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
        "description": "Item 2 - Mock Courier",
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
    "order_id": "BULK-2026-UB-01",
    "status": "SUCCESS",
    "response": {
      "order_id": "BULK-2026-UB-01",
      "courier_partner": "urbanebolt",
      "courier_order_id": "BULK-2026-UB-01",
      "tracking_number": "200000006959",
      "status": "CREATED"
    }
  },
  {
    "order_id": "BULK-2026-MC-02",
    "status": "SUCCESS",
    "response": {
      "order_id": "BULK-2026-MC-02",
      "courier_partner": "mockcourier",
      "courier_order_id": "MOCK-ORD-BULK-2026-MC-02",
      "tracking_number": "MOCK-TRK-BULK-2026-MC-02",
      "status": "CREATED"
    }
  }
]
```
