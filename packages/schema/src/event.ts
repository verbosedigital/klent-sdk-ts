import { z } from 'zod';
import { idSchema, metadataSchema, timestampSchema } from './common.js';

export const eventTypeSchema = z.enum([
  'decision',
  'action_requested',
  'action_executed',
  'action_blocked',
  'error',
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const logEventRequestSchema = z.object({
  execution_id: idSchema,
  type: eventTypeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  metadata: metadataSchema.optional(),
  occurred_at: timestampSchema.optional(),
});
export type LogEventRequest = z.infer<typeof logEventRequestSchema>;

export const eventSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  execution_id: idSchema,
  type: eventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  metadata: metadataSchema,
  occurred_at: timestampSchema,
  received_at: timestampSchema,
});
export type Event = z.infer<typeof eventSchema>;
