import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

export const policyOperatorSchema = z.enum([
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'contains',
  'ends_with',
]);
export type PolicyOperator = z.infer<typeof policyOperatorSchema>;

export const policyEffectSchema = z.enum(['allow', 'deny', 'modify']);
export type PolicyEffect = z.infer<typeof policyEffectSchema>;

export const enforcementModeSchema = z.enum(['enforce', 'shadow']);
export type EnforcementMode = z.infer<typeof enforcementModeSchema>;

export const policyConditionSchema = z.object({
  field: z.string().min(1),
  operator: policyOperatorSchema,
  value: z.union([z.string(), z.number(), z.boolean()]),
});
export type PolicyCondition = z.infer<typeof policyConditionSchema>;

export const policyModificationSchema = z.object({
  field: z.string().min(1),
  value: z.unknown(),
});
export type PolicyModification = z.infer<typeof policyModificationSchema>;

export const createPolicyRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  enforcement_mode: enforcementModeSchema.default('enforce'),
  conditions: z.array(policyConditionSchema).min(1),
  effect: policyEffectSchema,
  modifications: z.array(policyModificationSchema).optional(),
});
export type CreatePolicyRequest = z.infer<typeof createPolicyRequestSchema>;

/** Every field optional — omitted fields stay unchanged server-side. */
export const updatePolicyRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    enforcement_mode: enforcementModeSchema.optional(),
    conditions: z.array(policyConditionSchema).min(1).optional(),
    effect: policyEffectSchema.optional(),
    modifications: z.array(policyModificationSchema).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdatePolicyRequest = z.infer<typeof updatePolicyRequestSchema>;

export const policySchema = z.object({
  id: idSchema,
  project_id: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  enforcement_mode: enforcementModeSchema,
  conditions: z.array(policyConditionSchema),
  effect: policyEffectSchema,
  modifications: z.array(policyModificationSchema).nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Policy = z.infer<typeof policySchema>;
