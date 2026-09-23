// Planner response / action schema (v0.1). Validated locally (V1) before anything happens.

import { z } from './zod';

const target = z.string().regex(/^e\d{1,5}$/);

export const ActionSchema = z.union([
  z.strictObject({ type: z.literal('click'), target }),
  z.strictObject({ type: z.literal('type'), target, text: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal('select'), target, option: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal('scroll'), direction: z.enum(['up', 'down']), amount_px: z.number().int().min(1).max(2000) }),
  z.strictObject({ type: z.literal('scroll'), target }),
  z.strictObject({ type: z.literal('wait'), ms: z.number().int().min(0).max(3000) }),
  z.strictObject({ type: z.literal('ask_user'), question: z.string().min(1).max(300) }),
  z.strictObject({ type: z.literal('done'), summary: z.string().max(300) }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const PlanResponseSchema = z.strictObject({
  status: z.enum(['continue', 'done', 'need_user']),
  actions: z.array(ActionSchema).max(5),
  message: z.string().max(300),
});
export type PlanResponse = z.infer<typeof PlanResponseSchema>;

/** A placeholder token like "[EMAIL_1]". `type.text` is either exactly one of these or literal text. */
export const PLACEHOLDER_TOKEN = /^\[(EMAIL|PHONE|ADDRESS|PERSON|PAN|AADHAAR|CARD)_\d{1,4}\]$/;
