import { z, ZodType } from "zod";

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
    throw new Error(`Gemini request failed (${response.status}): ${text}`);
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

  const model = process.env.GEMINI_MODEL ?? "gemini-flash-3";
  const retries = options.retries ?? 1;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const text = await invokeGemini(model, apiKey, options, attempt > 0);
      const jsonText = extractJsonText(text);
      const parsed = JSON.parse(jsonText);
      return schema.parse(parsed);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(lastError?.message ?? "Gemini JSON generation failed.");
}

export const jsonBooleanSchema = z.object({
  value: z.boolean(),
});
