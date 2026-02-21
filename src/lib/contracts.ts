import { z } from "zod";

export const chatRoleSchema = z.enum(["user", "assistant"]);

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: chatRoleSchema,
  content: z.string().min(1).max(4000),
  analysis: z.unknown().optional(),
  createdAt: z.string().datetime(),
});

export const chatTurnRequestSchema = z.object({
  sessionId: z.string().min(1).max(191).optional(),
  message: z.string().min(1).max(4000),
});

const optionalNumber = z.coerce.number().nonnegative().optional();

export const classifierResultSchema = z.object({
  decision: z.enum(["allowed", "disallowed"]),
  reason: z.string().min(1).max(220),
});

export const lineItemSchema = z.object({
  tool: z.string().min(1),
  plan: z.string().optional(),
  seats: optionalNumber,
  annualCost: optionalNumber,
  currency: z.string().min(1).default("USD"),
  term: z.string().optional(),
  notes: z.string().optional(),
});

export const renewalAdviceSchema = z.object({
  onTopic: z.literal(true),
  lineItems: z.array(lineItemSchema).min(1),
  marketRange: z.object({
    min: z.coerce.number().nonnegative(),
    max: z.coerce.number().nonnegative(),
    currency: z.string().min(1),
    basis: z.string().min(1),
    confidence: z.enum(["low", "medium", "high"]),
  }),
  savingsEstimate: z.object({
    percentMin: z.coerce.number(),
    percentMax: z.coerce.number(),
    amountMin: optionalNumber,
    amountMax: optionalNumber,
    currency: z.string().min(1).default("USD"),
    explanation: z.string().min(1),
  }),
  leveragePoints: z.array(z.string().min(1)).min(1),
  counterEmail: z.object({
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  clarifyingQuestions: z.array(z.string().min(1)).max(6),
  assumptions: z.array(z.string().min(1)).min(1),
  confidence: z.enum(["low", "medium", "high"]),
});

export const chatApiResponseSchema = z.object({
  sessionId: z.string().min(1).optional(),
  onTopic: z.boolean(),
  replyText: z.string().min(1),
  analysis: renewalAdviceSchema.optional(),
});

export const chatSessionHistoryResponseSchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(
    z.object({
      id: z.string().min(1),
      role: chatRoleSchema,
      content: z.string().min(1),
      analysis: renewalAdviceSchema.optional(),
      createdAt: z.string().datetime(),
    })
  ),
});

export type ChatRole = z.infer<typeof chatRoleSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatTurnRequest = z.infer<typeof chatTurnRequestSchema>;
export type RenewalAdvice = z.infer<typeof renewalAdviceSchema>;
export type ChatApiResponse = z.infer<typeof chatApiResponseSchema>;
export type ChatSessionHistoryResponse = z.infer<
  typeof chatSessionHistoryResponseSchema
>;
