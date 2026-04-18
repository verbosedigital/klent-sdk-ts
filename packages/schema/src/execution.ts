import { z } from 'zod';
import { idSchema, metadataSchema, timestampSchema } from './common.js';

export const executionStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const createExecutionRequestSchema = z.object({
  agent_id: idSchema,
  metadata: metadataSchema.optional(),
});
export type CreateExecutionRequest = z.infer<typeof createExecutionRequestSchema>;

export const executionSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  agent_id: idSchema,
  status: executionStatusSchema,
  started_at: timestampSchema,
  ended_at: timestampSchema.nullable(),
  metadata: metadataSchema,
});
export type Execution = z.infer<typeof executionSchema>;
