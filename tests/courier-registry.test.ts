import { describe, expect, it } from 'vitest';

import { CourierProviderError } from '../src/couriers/courier-adapter.js';
import { createCourierRegistry, courierRegistry } from '../src/couriers/courier-registry.js';
import { UrbaneBoltAdapter } from '../src/couriers/urbanebolt/urbanebolt-adapter.js';
import { UnknownCourierError } from '../src/errors/application-error.js';

describe('courier registry', () => {
  it('registers and resolves the default UrbaneBolt adapter', () => {
    const adapter = courierRegistry.resolve('urbanebolt');

    expect(adapter).toBeInstanceOf(UrbaneBoltAdapter);
    expect(adapter.courierPartner).toBe('urbanebolt');
    expect(courierRegistry.supportedCouriers()).toEqual(['urbanebolt']);
  });

  it('reports supported couriers for an unknown partner', () => {
    expect(() => courierRegistry.resolve('delhivery')).toThrow(UnknownCourierError);

    try {
      courierRegistry.resolve('delhivery');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownCourierError);
      expect((error as UnknownCourierError).details).toEqual([
        {
          field: 'courier_partner',
          message: 'Use one of the supported courier partners',
          supported_values: ['urbanebolt']
        }
      ]);
    }
  });

  it('rejects duplicate adapter registrations', () => {
    const adapter = new UrbaneBoltAdapter();

    expect(() => createCourierRegistry([adapter, adapter])).toThrow(Error);
    expect(() => createCourierRegistry([adapter, adapter])).toThrow(
      'Courier partner is registered more than once: urbanebolt'
    );
  });

  it('preserves typed provider failure metadata for adapter operations', () => {
    const failure = new CourierProviderError({
      operation: 'track',
      kind: 'timeout',
      message: 'Courier request timed out',
      retryable: true
    });

    expect(failure).toMatchObject({
      name: 'CourierProviderError',
      operation: 'track',
      kind: 'timeout',
      retryable: true
    });
  });
});
