import { z } from 'zod';

export const idSchema = z.string().min(1).max(128);

export const timestampSchema = z.string().datetime();

export const metadataSchema = z.record(z.string(), z.unknown()).default({});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
