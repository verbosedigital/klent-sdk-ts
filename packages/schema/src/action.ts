import { z } from 'zod';
import { idSchema, metadataSchema } from './common.js';
import { policyEffectSchema, policyModificationSchema } from './policy.js';

export const evaluateActionRequestSchema = z.object({
  execution_id: idSchema,
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  metadata: metadataSchema.optional(),
});
export type EvaluateActionRequest = z.infer<typeof evaluateActionRequestSchema>;

export const evaluateActionResponseSchema = z.object({
  decision: policyEffectSchema,
  matched_policy_id: idSchema.nullable(),
  modifications: z.array(policyModificationSchema).nullable(),
  reason: z.string().nullable(),
});
export type EvaluateActionResponse = z.infer<typeof evaluateActionResponseSchema>;
