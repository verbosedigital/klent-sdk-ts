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
 * Rate-limit clause attached to a policy. When set, the policy's `effect`
 * fires once the configured count of prior `action_executed` events in the
 * rolling window has been reached.
 *
 * - `scope: 'tool'`        — limit shared across all agents in the project.
 *   "transfer_funds is capped at 100/hr project-wide."
 * - `scope: 'agent_tool'`  — limit per (agent_id, tool) pair, the more
 *   common case. "Each agent can call transfer_funds 5 times per hour."
 *
 * `window_minutes` is a sliding window: at evaluation time we count the
 * action_executed events whose `occurred_at` is within the last N minutes.
 */
export const policyRateLimitSchema = z.object({
  scope: z.enum(['tool', 'agent_tool']),
  limit: z.number().int().positive(),
  window_minutes: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60),
});
export type PolicyRateLimit = z.infer<typeof policyRateLimitSchema>;

/**
 * Loop-guard clause. When set, the policy's `effect` fires once the agent
 * has called this same tool `threshold` times in a row within the current
 * execution — i.e. the last `threshold - 1` `action_executed` events for
 * this execution all targeted the same tool, and this incoming action would
 * be the next one.
 *
 * Use case: the classic "agent stuck in a loop" failure. The agent retries
 * `web_search` 50 times when the first response wasn't what it wanted; you
 * want to cut the cord at, say, 10 consecutive calls.
 *
 * Scope is per-execution (which is also per-agent — one execution = one
 * agent run). A different tool in between resets the streak.
 *
 * This clause is mutually exclusive with `rate_limit` on the same policy
 * (both are historical-event pre-filters with different semantics — pick
 * one per policy).
 */
export const policyLoopGuardSchema = z.object({
  threshold: z.number().int().min(2).max(100),
});
export type PolicyLoopGuard = z.infer<typeof policyLoopGuardSchema>;

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
  rate_limit: policyRateLimitSchema.optional(),
  loop_guard: policyLoopGuardSchema.optional(),
  /**
   * For `effect: 'approve'`: how many distinct human approvals are required
   * before the action is released. Default 1 (single-approver, current
   * behavior). Any single rejection still terminates the action regardless
   * of this number. Ignored for non-approve effects.
   */
  required_approvals: z.number().int().min(1).max(10).default(1),
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
    rate_limit?: PolicyRateLimit | null;
    loop_guard?: PolicyLoopGuard | null;
    required_approvals?: number | null;
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
  // required_approvals > 1 is meaningful only for approve. We don't error on
  // misuse — just clamp behavior in the engine — but flag it at the API/YAML
  // boundary so authors don't end up with silently ignored config.
  if (
    value.required_approvals !== undefined &&
    value.required_approvals !== null &&
    value.required_approvals > 1 &&
    value.effect !== 'approve'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'required_approvals > 1 only applies when effect is "approve"',
      path: ['required_approvals'],
    });
  }
  // rate_limit and loop_guard are both historical-event pre-filters but with
  // different scopes (project rolling window vs. per-execution streak).
  // Allowing both on one policy makes "fire when?" ambiguous. Force authors
  // to split into two policies.
  if (value.rate_limit && value.loop_guard) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'rate_limit and loop_guard cannot both be set on the same policy',
      path: ['loop_guard'],
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
    rate_limit: policyRateLimitSchema.nullable().optional(),
    loop_guard: policyLoopGuardSchema.nullable().optional(),
    required_approvals: z.number().int().min(1).max(10).optional(),
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
  rate_limit: policyRateLimitSchema.nullable(),
  loop_guard: policyLoopGuardSchema.nullable(),
  required_approvals: z.number().int().min(1).max(10),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Policy = z.infer<typeof policySchema>;
