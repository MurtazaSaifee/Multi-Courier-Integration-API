import { UnknownCourierError } from '../errors/application-error.js';
import type { CourierAdapter } from './courier-adapter.js';
import { UrbaneBoltAdapter } from './urbanebolt/urbanebolt-adapter.js';

export interface CourierRegistry {
  resolve(courierPartner: string): CourierAdapter;
  supportedCouriers(): readonly string[];
}

export function createCourierRegistry(
  adapters: readonly CourierAdapter[] = [new UrbaneBoltAdapter()]
): CourierRegistry {
  const adaptersByPartner = new Map<string, CourierAdapter>();

  for (const adapter of adapters) {
    if (adaptersByPartner.has(adapter.courierPartner)) {
      throw new Error(`Courier partner is registered more than once: ${adapter.courierPartner}`);
    }

    adaptersByPartner.set(adapter.courierPartner, adapter);
  }

  const supportedCouriers = Object.freeze([...adaptersByPartner.keys()].sort());

  return {
    resolve(courierPartner: string): CourierAdapter {
      const adapter = adaptersByPartner.get(courierPartner);

      if (!adapter) {
        throw new UnknownCourierError(supportedCouriers);
      }

      return adapter;
    },

    supportedCouriers(): readonly string[] {
      return supportedCouriers;
    }
  };
}

export const courierRegistry = createCourierRegistry();
