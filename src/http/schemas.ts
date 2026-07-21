import { z } from 'zod';

const requiredText = z.string().trim().min(1);

const addressSchema = z.object({
  name: requiredText,
  phone: requiredText,
  email: z.string().email().optional(),
  street: requiredText,
  city: requiredText,
  state: requiredText,
  country: requiredText,
  postal_code: requiredText
}).strict();

const packageSchema = z.object({
  description: requiredText,
  pieces: z.number().int().positive(),
  weight: z.number().positive(),
  length: z.number().positive().optional(),
  breadth: z.number().positive().optional(),
  height: z.number().positive().optional()
}).strict();

const paymentSchema = z.object({
  mode: requiredText,
  amount_to_collect: z.number().nonnegative().optional()
}).strict();

const invoiceSchema = z.object({
  invoice_number: requiredText,
  invoice_date: requiredText,
  value: z.number().nonnegative()
}).strict();

export const createOrderRequestSchema = z.object({
  order_id: requiredText,
  courier_partner: requiredText,
  service_type: requiredText,
  sender: addressSchema,
  recipient: addressSchema,
  return_address: addressSchema.optional(),
  package: packageSchema,
  payment: paymentSchema,
  invoice: invoiceSchema.optional()
}).strict();

export const trackShipmentInputSchema = z.object({
  courier_order_id: requiredText.nullable(),
  tracking_number: requiredText
}).strict();

export const cancelShipmentInputSchema = trackShipmentInputSchema;

export const bulkCreateOrderRequestSchema = z
  .array(createOrderRequestSchema)
  .min(1)
  .max(100);
