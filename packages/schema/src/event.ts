import { z } from 'zod';
import { idSchema, metadataSchema, timestampSchema } from './common.js';

export const eventTypeSchema = z.enum([
  'decision',
  'action_requested',
  'action_executed',
  'action_blocked',
  /** Engine returned `steer` — the SDK is about to run a substituted tool. */
  'action_steered',
  /** Engine returned `approve` — the action is parked awaiting human review. */
  'pending_approval',
  /** A pending action was resolved (approved or rejected) by a human. */
  'approval_resolved',
  'error',
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const logEventRequestSchema = z.object({
  execution_id: idSchema,
  type: eventTypeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  metadata: metadataSchema.optional(),
  /** Wall-clock duration of the work this event represents, in milliseconds. */
  duration_ms: z.number().int().nonnegative().optional(),
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
  duration_ms: z.number().int().nonnegative().nullable(),
  occurred_at: timestampSchema,
  received_at: timestampSchema,
});
export type Event = z.infer<typeof eventSchema>;
