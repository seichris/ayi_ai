import { jsonrepair } from "jsonrepair";
import { z, ZodType } from "zod";

const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 12_000);

type GenerateJsonOptions = {
  systemInstruction: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  retries?: number;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

class GeminiRequestError extends Error {
  readonly status: number;
  readonly model: string;

  constructor(model: string, status: number, body: string) {
    super(`Gemini request failed (${status}) for model "${model}": ${body}`);
    this.status = status;
    this.model = model;
  }
}

function parseStructuredJson<T>(schema: ZodType<T>, text: string): T {
  const jsonText = extractJsonText(text);

  try {
    const parsed = JSON.parse(jsonText);
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const repairedText = jsonrepair(jsonText);
      const parsed = JSON.parse(repairedText);
      return schema.parse(parsed);
    }

    throw error;
  }
}

async function repairJsonOutput(
  model: string,
  apiKey: string,
  options: GenerateJsonOptions,
  rawOutput: string,
  responseSchema: Record<string, unknown>,
  validationError?: string
): Promise<string> {
  const schemaText = JSON.stringify(responseSchema, null, 2);

  return invokeGemini(
    model,
    apiKey,
    {
      systemInstruction:
        "You repair model output into a valid JSON object that strictly matches a required JSON Schema. Include all required fields. Return JSON only with no commentary, no markdown, and no surrounding text.",
      userPrompt: `Original task:\n${options.userPrompt}

Required JSON Schema:
${schemaText}

Validation error to fix:
${validationError ?? "N/A"}

Model output to repair:
${rawOutput}`,
      temperature: 0,
      maxOutputTokens: options.maxOutputTokens ?? 2200,
      retries: 0,
    },
    true,
    responseSchema
  );
}

function buildGeminiResponseSchema<T>(
  schema: ZodType<T>
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const allowedSchemaKeys = new Set([
    "type",
    "format",
    "description",
    "nullable",
    "enum",
    "items",
    "maxItems",
    "minItems",
    "properties",
    "required",
    "propertyOrdering",
    "anyOf",
  ]);

  const sanitize = (
    value: unknown,
    context: "schema" | "propertiesMap" = "schema"
  ): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, context));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    if (context === "propertiesMap") {
      const mapped: Record<string, unknown> = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        mapped[propertyName] = sanitize(propertySchema, "schema");
      }
      return mapped;
    }

    const schemaNode = value as Record<string, unknown>;
    const constValue = schemaNode.const;

    const result: Record<string, unknown> = {};

    if (constValue !== undefined && schemaNode.enum === undefined) {
      if (typeof constValue === "string") {
        result.enum = [constValue];
      } else if (schemaNode.type === undefined) {
        result.type = typeof constValue;
      }
    }

    for (const [key, child] of Object.entries(schemaNode)) {
      if (
        key === "$schema" ||
        key === "additionalProperties" ||
        key === "const" ||
        !allowedSchemaKeys.has(key)
      ) {
        continue;
      }

      if (key === "properties") {
        result[key] = sanitize(child, "propertiesMap");
        continue;
      }

      result[key] = sanitize(child, "schema");
    }

    return result;
  };

  return sanitize(jsonSchema) as Record<string, unknown>;
}

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  if (withoutFence.startsWith("{") || withoutFence.startsWith("[")) {
    return withoutFence;
  }

  const objectStart = withoutFence.indexOf("{");
  const objectEnd = withoutFence.lastIndexOf("}");

  if (objectStart >= 0 && objectEnd > objectStart) {
    return withoutFence.slice(objectStart, objectEnd + 1);
  }

  return withoutFence;
}

async function invokeGemini(
  model: string,
  apiKey: string,
  options: GenerateJsonOptions,
  forceStrictJson = false,
  responseSchema?: Record<string, unknown>
): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const strictPromptSuffix =
    "Return only a valid JSON object. Do not include markdown fences or commentary.";

  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.2,
    maxOutputTokens: options.maxOutputTokens ?? 2200,
    responseMimeType: "application/json",
  };

  if (responseSchema) {
    generationConfig.responseSchema = responseSchema;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: options.systemInstruction }],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: forceStrictJson
                ? `${options.userPrompt}\n\n${strictPromptSuffix}`
                : options.userPrompt,
            },
          ],
        },
      ],
      generationConfig,
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new GeminiRequestError(model, response.status, text);
  }

  const data = (await response.json()) as GeminiResponse;
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return text;
}

export async function generateJson<T>(
  schema: ZodType<T>,
  options: GenerateJsonOptions
): Promise<T> {
  const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;

  if (!apiKey) {
    throw new Error("GOOGLE_AI_STUDIO_API_KEY is not set.");
  }

  const configuredModel = process.env.GEMINI_MODEL?.trim();
  const responseSchema = buildGeminiResponseSchema(schema);
  const models = configuredModel
    ? Array.from(new Set([configuredModel, DEFAULT_GEMINI_MODEL]))
    : [DEFAULT_GEMINI_MODEL];
  const retries = options.retries ?? 1;

  let lastError: Error | null = null;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let responseText: string | null = null;

      try {
        responseText = await invokeGemini(
          model,
          apiKey,
          options,
          attempt > 0,
          responseSchema
        );
        return parseStructuredJson(schema, responseText);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const repairSource = responseText;
        const canRepair =
          repairSource !== null &&
          (lastError instanceof SyntaxError || lastError instanceof z.ZodError);

        if (canRepair) {
          try {
            const repairedText = await repairJsonOutput(
              model,
              apiKey,
              options,
              repairSource,
              responseSchema,
              lastError.message
            );
            return parseStructuredJson(schema, repairedText);
          } catch (repairError) {
            lastError =
              repairError instanceof Error
                ? repairError
                : new Error(String(repairError));
          }
        }

        if (lastError instanceof GeminiRequestError && lastError.status === 404) {
          break;
        }
      }
    }

    const isModelNotFound =
      lastError instanceof GeminiRequestError && lastError.status === 404;
    const hasNextModel = modelIndex < models.length - 1;

    if (
      configuredModel &&
      model === configuredModel &&
      isModelNotFound &&
      configuredModel !== DEFAULT_GEMINI_MODEL
    ) {
      console.warn("gemini.model_fallback", {
        from: configuredModel,
        to: DEFAULT_GEMINI_MODEL,
      });
    }

    if (isModelNotFound && hasNextModel) {
      continue;
    }

    if (lastError) {
      throw lastError;
    }
  }

  throw new Error(lastError?.message ?? "Gemini JSON generation failed.");
}

export const jsonBooleanSchema = z.object({
  value: z.boolean(),
});
