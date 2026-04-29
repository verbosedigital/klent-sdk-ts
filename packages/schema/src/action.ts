import { z } from 'zod';
import { idSchema, metadataSchema, timestampSchema } from './common.js';
import { policyEffectSchema, policyModificationSchema, policyRedirectSchema } from './policy.js';

export const evaluateActionRequestSchema = z.object({
  execution_id: idSchema,
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  metadata: metadataSchema.optional(),
});
export type EvaluateActionRequest = z.infer<typeof evaluateActionRequestSchema>;

/**
 * Public response from `POST /v1/actions/evaluate`.
 *
 * `pending_action_id` is set whenever `decision === 'approve'` — the SDK uses
 * it to poll `GET /v1/pending_actions/:id` (or to long-poll via
 * `?wait_ms=…`). `redirect_to` is set whenever `decision === 'steer'`.
 */
export const evaluateActionResponseSchema = z.object({
  decision: policyEffectSchema,
  matched_policy_id: idSchema.nullable(),
  modifications: z.array(policyModificationSchema).nullable(),
  redirect_to: policyRedirectSchema.nullable(),
  pending_action_id: idSchema.nullable(),
  reason: z.string().nullable(),
});
export type EvaluateActionResponse = z.infer<typeof evaluateActionResponseSchema>;

/** Status of an action that's parked waiting for human approval. */
export const pendingActionStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type PendingActionStatus = z.infer<typeof pendingActionStatusSchema>;

export const pendingActionSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  execution_id: idSchema,
  event_id: idSchema.nullable(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  metadata: metadataSchema,
  status: pendingActionStatusSchema,
  matched_policy_id: idSchema.nullable(),
  reason: z.string().nullable(),
  modifications: z.array(policyModificationSchema).nullable(),
  requested_at: timestampSchema,
  expires_at: timestampSchema.nullable(),
  resolved_at: timestampSchema.nullable(),
  resolved_by_user_id: idSchema.nullable(),
  resolution_note: z.string().nullable(),
});
export type PendingAction = z.infer<typeof pendingActionSchema>;

/**
 * Body for `POST /v1/pending_actions/:id/resolve` (dashboard call).
 *
 * `approve` lets the action proceed (with optional last-mile `modifications`
 * the reviewer dialed in). `reject` blocks it like a `deny` would have.
 */
export const resolvePendingActionRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(2000).optional(),
  modifications: z.array(policyModificationSchema).optional(),
});
export type ResolvePendingActionRequest = z.infer<typeof resolvePendingActionRequestSchema>;
