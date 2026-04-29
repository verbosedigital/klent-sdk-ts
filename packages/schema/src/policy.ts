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

/**
 * What a policy does when it matches.
 *
 * - `allow`  — the action runs untouched.
 * - `deny`   — the SDK gets a deny decision and never executes the tool.
 * - `modify` — the engine returns `modifications` that the SDK merges into the
 *   tool's input before executing. Same tool, different args.
 * - `approve` — human-in-the-loop. The action is parked in `pending_actions`
 *   and the SDK polls (or long-polls via `GET /v1/pending_actions/:id`) until
 *   a human resolves it from the dashboard.
 * - `steer`  — redirect to a different tool. The engine returns a
 *   `redirect_to: { tool, input }` envelope and the SDK runs that *instead* of
 *   the original call. Stronger than `modify` because the tool itself changes.
 */
export const policyEffectSchema = z.enum(['allow', 'deny', 'modify', 'approve', 'steer']);
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

/**
 * Where a `steer` policy points: a different tool plus the input it should
 * receive. We don't try to merge with the original input — `steer` is meant
 * to be a hard substitution. If a policy author wants to keep the original
 * input shape, they can spell it out under `input`.
 */
export const policyRedirectSchema = z.object({
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type PolicyRedirect = z.infer<typeof policyRedirectSchema>;

/**
 * Base policy create body. Kept as a plain ZodObject (no `.refine()`) so
 * downstream callers can still use `.pick()` / `.extend()`. Cross-field
 * validation lives in {@link policyEffectShapeRefinements} below — apply it
 * with `createPolicyRequestSchema.superRefine(policyEffectShapeRefinements)`
 * at the request boundary.
 */
export const createPolicyRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  enforcement_mode: enforcementModeSchema.default('enforce'),
  conditions: z.array(policyConditionSchema).min(1),
  effect: policyEffectSchema,
  modifications: z.array(policyModificationSchema).optional(),
  redirect_to: policyRedirectSchema.optional(),
});
export type CreatePolicyRequest = z.infer<typeof createPolicyRequestSchema>;

/**
 * Cross-field validation for policy effects:
 * - `effect: 'steer'`  requires `redirect_to`
 * - `effect: 'modify'` requires at least one `modifications` entry
 *
 * Wired in via `superRefine` on the boundary schema (HTTP route, dashboard
 * action, YAML loader) so the base object stays composable.
 */
export const policyEffectShapeRefinements = (
  value: {
    effect: PolicyEffect;
    modifications?: PolicyModification[] | null;
    redirect_to?: PolicyRedirect | null;
  },
  ctx: z.RefinementCtx,
): void => {
  if (value.effect === 'steer' && !value.redirect_to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'redirect_to is required when effect is "steer"',
      path: ['redirect_to'],
    });
  }
  if (value.effect === 'modify' && (!value.modifications || value.modifications.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'modifications is required when effect is "modify"',
      path: ['modifications'],
    });
  }
};

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
    redirect_to: policyRedirectSchema.nullable().optional(),
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
  redirect_to: policyRedirectSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Policy = z.infer<typeof policySchema>;
