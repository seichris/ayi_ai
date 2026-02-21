import { z, ZodType } from "zod";

const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";

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
  const parsed = JSON.parse(jsonText);
  return schema.parse(parsed);
}

async function repairJsonOutput(
  model: string,
  apiKey: string,
  options: GenerateJsonOptions,
  rawOutput: string
): Promise<string> {
  return invokeGemini(
    model,
    apiKey,
    {
      systemInstruction:
        "You repair model output into a valid JSON object. Return JSON only with no commentary, no markdown, and no surrounding text.",
      userPrompt: `Original task:\n${options.userPrompt}\n\nModel output to repair:\n${rawOutput}`,
      temperature: 0,
      maxOutputTokens: options.maxOutputTokens ?? 2200,
      retries: 0,
    },
    true
  );
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
  forceStrictJson = false
): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const strictPromptSuffix =
    "Return only a valid JSON object. Do not include markdown fences or commentary.";

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
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxOutputTokens ?? 2200,
        responseMimeType: "application/json",
      },
    }),
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
        responseText = await invokeGemini(model, apiKey, options, attempt > 0);
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
              repairSource
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
