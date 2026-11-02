import { z } from 'zod';

export const EXTRACT_TYPES = ['TEXT', 'ATTRIBUTE'] as const;
export const FIELD_ROLES = ['TEXT', 'PRICE', 'STOCK', 'QUANTITY'] as const;

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 60 * 24 * 7;

const terms = z.array(z.string().trim().min(1).max(100)).max(30).default([]);

const fieldShape = z.object({
  name: z.string().trim().min(1, 'Field name is required').max(100),
  selector: z.string().trim().min(1, 'CSS selector is required').max(500),
  extractType: z.enum(EXTRACT_TYPES).default('TEXT'),
  attribute: z.string().trim().max(100).nullish(),
  role: z.enum(FIELD_ROLES).default('TEXT'),
  inStockTerms: terms,
  outOfStockTerms: terms,
});

const attributeRequired = (field: { extractType?: string; attribute?: string | null }) =>
  field.extractType !== 'ATTRIBUTE' || Boolean(field.attribute);
const attributeMessage = { message: 'Attribute name is required for attribute extraction', path: ['attribute'] };

export const fieldInputSchema = fieldShape.refine(attributeRequired, attributeMessage);
export const fieldPatchSchema = fieldShape.partial().refine(attributeRequired, attributeMessage);
// Inside a monitor update, a field with an id edits that field and one without is created.
export const fieldSetItemSchema = fieldShape
  .extend({ id: z.string().uuid().optional() })
  .refine(attributeRequired, attributeMessage);

const uniqueNames = (fields: { name: string }[]) =>
  new Set(fields.map((f) => f.name.toLowerCase())).size === fields.length;
const fieldSet = z
  .array(fieldSetItemSchema)
  .min(1, 'Add at least one field')
  .max(50)
  .refine(uniqueNames, { message: 'Field names must be unique' });

const monitorShape = {
  name: z.string().trim().min(1, 'Name is required').max(150),
  url: z.string().trim().url('Enter a valid URL').max(2048),
  intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES),
  enabled: z.boolean(),
};

export const monitorCreateSchema = z.object({
  ...monitorShape,
  intervalMinutes: monitorShape.intervalMinutes.default(60),
  enabled: monitorShape.enabled.default(true),
  fields: fieldSet,
});

export const monitorUpdateSchema = z.object({
  name: monitorShape.name.optional(),
  url: monitorShape.url.optional(),
  intervalMinutes: monitorShape.intervalMinutes.optional(),
  enabled: monitorShape.enabled.optional(),
  fields: fieldSet.optional(),
});

export const previewSchema = z.object({
  url: monitorShape.url,
  fields: z.array(fieldSetItemSchema).min(1).max(50),
});

export const historyQuerySchema = z.object({
  monitorId: z.string().uuid().optional(),
  status: z.enum(['SUCCESS', 'PARTIAL', 'ERROR']).optional(),
  changed: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type FieldInput = z.infer<typeof fieldSetItemSchema>;
export type MonitorCreate = z.infer<typeof monitorCreateSchema>;
export type MonitorUpdate = z.infer<typeof monitorUpdateSchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
