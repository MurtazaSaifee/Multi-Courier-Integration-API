# Multi-Courier Integration API

A Node.js and TypeScript backend service that connects to different courier providers (including UrbaneBolt and MockCourier) through a single unified API.

---

## What This Service Does

- **Single REST API**: Create shipments, track packages, cancel orders, and send bulk orders using one standard set of endpoints.
- **Pluggable Couriers**: All courier-specific logic (e.g. UrbaneBolt and MockCourier adapters) is isolated behind clean adapter implementations, allowing new couriers to be added without touching core business logic or HTTP endpoints.
- **Database Tracking**: Stores all orders and step-by-step package tracking history in PostgreSQL using Knex.js.
- **Idempotency**: Prevents creating duplicate orders if the same request is sent twice.
- **Retries & Auth Handling**: Automatically retries transient network errors and refreshes expired login tokens.
- **Bulk Processing**: Handles up to 100 orders per batch concurrently without failing the whole batch if one order has an issue.

---

## Prerequisites

- **Node.js**: version 20 or higher
- **npm**: version 10 or higher
- **Docker Desktop**: required for running PostgreSQL

---

## How to Set Up

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment variables

Copy the pre-configured `.env.example` file to `.env`:

```bash
cp .env.example .env
```

The `.env.example` file comes pre-filled with working default UrbaneBolt UAT credentials (`info@urbanebolt.com`) so you can run the API immediately without needing to configure credentials manually.

#### Configuration Reference

| Variable | Pre-configured Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://user:password@localhost:5432/multi_courier` | PostgreSQL connection link |
| `PORT` | `3000` | Server port |
| `URBANEBOLT_BASE_URL` | `https://uat.urbanebolt.in` | Base URL for UrbaneBolt UAT API |
| `URBANEBOLT_USERNAME` | `info@urbanebolt.com` | UrbaneBolt UAT username |
| `URBANEBOLT_PASSWORD` | `EKIcygsLVV5RCtPZ` | UrbaneBolt UAT password |
| `URBANEBOLT_CUSTOMER_CODE` | `UEBCUS0008` | UrbaneBolt UAT customer code |
| `REQUEST_TIMEOUT_MS` | `5000` | Timeout for HTTP calls (ms) |
| `RETRY_COUNT` | `2` | Number of retry attempts |
| `RETRY_DELAY_MS` | `250` | Wait time between retries (ms) |
| `BULK_CONCURRENCY` | `5` | Concurrent orders processed in bulk mode |

### 3. Database setup

Start the PostgreSQL database with Docker:

```bash
npm run db:up
```

Run database migrations to create the tables:

```bash
npm run db:migrate
```

To test the database connection:

```bash
npm run db:check
```

To undo the last migration:

```bash
npm run db:rollback
```

To stop Docker:

```bash
npm run db:down
```

---

## How to Run

### Development mode (with auto-reload)

```bash
npm run dev
```

### Build and run in production

```bash
npm run build
npm run start
```

---

## Testing

Check TypeScript types:

```bash
npm run typecheck
```

Run unit and integration tests:

```bash
npm run test
```

Run UAT tests against live/sandbox UrbaneBolt endpoints:

```bash
npm run test:uat
```

---

## API Summary

- **`GET /health`**: Checks if the app and database are working.
- **`POST /api/v1/orders`**: Creates a new shipment order.
- **`GET /api/v1/orders/:order_id/track`**: Gets tracking status and full event history for an order.
- **`POST /api/v1/orders/:order_id/cancel`**: Cancels an active order.
- **`POST /api/v1/orders/bulk`**: Submits up to 100 orders at once.

For detailed request and response examples, see [docs/api_examples.md](docs/api_examples.md) or use the Postman collection at [docs/postman_collection.json](docs/postman_collection.json).

The Postman collection calls this local API, which then calls UrbaneBolt UAT when the UAT variables are configured. Set a fresh `orderId` before creating a new live UAT shipment.

---

## Design Choices

### Bulk Processing in Memory vs Background Queues

For bulk order creation (`POST /api/v1/orders/bulk`), I chose to process up to 100 orders concurrently in memory using a small worker pool (`BULK_CONCURRENCY = 5`).

Why I made this choice:
1. **Immediate response**: The caller gets back the results and tracking numbers right away in the API response without needing to set up webhooks or poll for status.
2. **Simple infrastructure**: Keeps the setup easy to run without requiring extra infrastructure like Redis, RabbitMQ, or BullMQ.
3. **Isolated errors**: Each order in a bulk request runs independently. If order #3 fails validation or gets rejected by the courier, orders #1, #2, and #4 still complete successfully.

*If we ever need to process huge batches of 1,000+ orders in the future, we can add a background worker queue behind the service without changing the public API endpoints or courier adapters.*

---

## Documentation Files

- Architecture overview & database design: [DESIGN.md](DESIGN.md)
- Curl examples and response samples: [docs/api_examples.md](docs/api_examples.md)
- Postman collection: [docs/postman_collection.json](docs/postman_collection.json)
