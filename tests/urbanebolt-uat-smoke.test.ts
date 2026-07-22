import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { UrbaneBoltAdapter } from '../src/couriers/urbanebolt/urbanebolt-adapter.js';
import type { CreateOrderRequest } from '../src/domain/contracts.js';

const runUat = process.env.RUN_URBANEBOLT_UAT === 'true';

describe.runIf(runUat)('UrbaneBolt Live Opt-in UAT Integration Test (Fix 3)', () => {
  it('executes live UAT flow: authenticate -> create -> track -> cancel', async () => {
    const adapter = new UrbaneBoltAdapter({
      config: {
        baseUrl: config.urbanebolt.baseUrl,
        username: config.urbanebolt.username,
        password: config.urbanebolt.password,
        customerCode: config.urbanebolt.customerCode,
        requestTimeoutMs: config.requestTimeoutMs,
        retryCount: config.retryCount,
        retryDelayMs: config.retryDelayMs
      }
    });

    const uniqueOrderId = `UAT-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const sampleCreateRequest: CreateOrderRequest = {
      order_id: uniqueOrderId,
      courier_partner: 'urbanebolt',
      service_type: 'NDD',
      sender: {
        name: 'Synthetic UAT Sender',
        phone: '+919876543210',
        street: '123 Test Park',
        city: 'Mumbai',
        state: 'Maharashtra',
        country: 'India',
        postal_code: '400001'
      },
      recipient: {
        name: 'Synthetic UAT Recipient',
        phone: '+919876543211',
        street: '456 Test Street',
        city: 'Bengaluru',
        state: 'Karnataka',
        country: 'India',
        postal_code: '560001'
      },
      return_address: {
        name: 'Synthetic UAT Returns',
        phone: '+919876543212',
        street: '123 Test Park',
        city: 'Mumbai',
        state: 'Maharashtra',
        country: 'India',
        postal_code: '400001'
      },
      package: {
        description: 'Synthetic UAT Item',
        pieces: 1,
        weight: 1.5,
        length: 20,
        breadth: 15,
        height: 10
      },
      payment: {
        mode: 'PREPAID',
        amount_to_collect: 0
      },
      invoice: {
        invoice_number: `${uniqueOrderId}-INV`,
        invoice_date: new Date().toISOString().slice(0, 10),
        value: 100
      }
    };

    let createdTrackingNumber: string | undefined;
    let createdCourierOrderId: string | null | undefined;
    let cancellationCompleted = false;

    try {
      const createResult = await adapter.createShipment(sampleCreateRequest);
      expect(createResult.response.order_id).toBe(uniqueOrderId);
      expect(createResult.response.courier_partner).toBe('urbanebolt');
      expect(createResult.response.status).toBeDefined();
      const trackingNumber = createResult.response.tracking_number;
      const courierOrderId = createResult.response.courier_order_id;
      createdTrackingNumber = trackingNumber;
      createdCourierOrderId = courierOrderId;

      expect(trackingNumber).toEqual(expect.any(String));
      expect(courierOrderId).toEqual(expect.any(String));

      const trackResult = await adapter.trackShipment({
        tracking_number: trackingNumber,
        courier_order_id: courierOrderId
      });
      expect(trackResult.response.order_id).toBe(uniqueOrderId);
      expect(trackResult.response.tracking_number).toBe(trackingNumber);
      expect(trackResult.response.status).toBeDefined();

      const cancelResult = await adapter.cancelShipment({
        tracking_number: trackingNumber,
        courier_order_id: courierOrderId
      });
      expect(cancelResult.response.order_id).toBe(uniqueOrderId);
      expect(cancelResult.response.tracking_number).toBe(trackingNumber);
      expect(cancelResult.response.status).toBe('CANCELLED');
      cancellationCompleted = true;
    } finally {
      if (createdTrackingNumber && !cancellationCompleted) {
        try {
          await adapter.cancelShipment({
            tracking_number: createdTrackingNumber,
            courier_order_id: createdCourierOrderId ?? null
          });
        } catch {
          // Cleanup is best-effort after an earlier assertion or provider failure.
        }
      }
    }
  });
});

if (!runUat) {
  describe('UrbaneBolt Live Opt-in UAT Integration Test (Skipped)', () => {
    it('is skipped because RUN_URBANEBOLT_UAT is not set to true', () => {
      expect(runUat).toBe(false);
    });
  });
}
