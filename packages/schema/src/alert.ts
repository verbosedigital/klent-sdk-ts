import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
import { eventTypeSchema } from './event.js';

export const alertChannelSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('email'),
    target: z.string().email(),
  }),
  z.object({
    type: z.literal('webhook'),
    target: z.string().url(),
    secret: z.string().min(16).optional(),
  }),
]);
export type AlertChannel = z.infer<typeof alertChannelSchema>;

export const createAlertRuleRequestSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  event_types: z.array(eventTypeSchema).min(1),
  channel: alertChannelSchema,
});
export type CreateAlertRuleRequest = z.infer<typeof createAlertRuleRequestSchema>;

export const alertRuleSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  name: z.string(),
  enabled: z.boolean(),
  event_types: z.array(eventTypeSchema),
  channel: alertChannelSchema,
  created_at: timestampSchema,
});
export type AlertRule = z.infer<typeof alertRuleSchema>;
