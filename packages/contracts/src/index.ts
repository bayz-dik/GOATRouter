import { z } from "zod";

export const HealthSchema = z.object({
  status: z.literal("ok"),
  version: z.string().min(1),
  uptimeSeconds: z.number().finite().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorSchema>;

export const ClientProtocolSchema = z.enum(["openai", "anthropic"]);
export type ClientProtocol = z.infer<typeof ClientProtocolSchema>;
