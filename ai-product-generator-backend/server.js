require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
const port = Number(process.env.PORT) || 5000;
const monthlyGenerationLimit = Number(process.env.MONTHLY_GENERATION_LIMIT) || 100;
const requiredAccessToken = process.env.ACCESS_TOKEN || "";
const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5000",
  "chrome-extension://*",
];
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || defaultAllowedOrigins.join(",")
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const usageByClientAndMonth = new Map();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const isAllowed = allowedOrigins.some((allowedOrigin) => {
        if (allowedOrigin === "*") {
          return true;
        }

        if (allowedOrigin.endsWith("*")) {
          return origin.startsWith(allowedOrigin.slice(0, -1));
        }

        return origin === allowedOrigin;
      });

      callback(isAllowed ? null : new Error("Origin not allowed by CORS"), isAllowed);
    },
  }),
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    allowedOrigins,
    authEnabled: Boolean(requiredAccessToken),
    monthlyGenerationLimit,
  });
});

app.get("/usage", (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const clientId = normalizeClientId(req.query.clientId);
  const usage = getUsageForClient(clientId);

  return res.json({
    clientId,
    usage,
    limit: monthlyGenerationLimit,
    remaining: Math.max(monthlyGenerationLimit - usage.count, 0),
    period: usage.period,
  });
});

app.post("/generate-product-content", async (req, res) => {
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const clientId = normalizeClientId(req.body?.clientId);
  const usage = getUsageForClient(clientId);

  if (!title) {
    return res.status(400).json({ error: "Title is required" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({
      error: "Unauthorized. Missing or invalid extension access token.",
    });
  }

  if (!openai) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not set in the backend environment.",
    });
  }

  if (usage.count >= monthlyGenerationLimit) {
    return res.status(429).json({
      error: "Monthly generation limit reached for this client.",
      usage: {
        count: usage.count,
        limit: monthlyGenerationLimit,
        period: usage.period,
      },
    });
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You write polished ecommerce product copy for premium Shopify stores. Return valid JSON only. Use a clean storefront style. description must be 1 to 2 short sentences and should read naturally, like a luxury ecommerce listing. highlights must be an array of exactly 6 concise product benefit lines. composition must be an array of exactly 2 concise material or construction lines. Do not mention SEO, AI, markdown, numbering, or extra keys. Avoid hype and keep the tone premium, modern, and product-focused.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Product title: ${title}\nClient/store identifier: ${clientId}\nDesired output example structure:\nA super trainer for long runs and tempo runs. Featuring a responsive cushioning system and energy-return foam for a highly efficient ride.\n\nHighlights:\n- First highlight\n- Second highlight\n- Third highlight\n- Fourth highlight\n- Fifth highlight\n- Sixth highlight\n\nComposition:\n- Upper material\n- Outsole material`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "product_copy",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              description: { type: "string" },
              highlights: {
                type: "array",
                items: { type: "string" },
                minItems: 6,
                maxItems: 6,
              },
              composition: {
                type: "array",
                items: { type: "string" },
                minItems: 2,
                maxItems: 2,
              },
            },
            required: ["description", "highlights", "composition"],
          },
        },
      },
    });

    const rawOutput = response.output_text;
    const parsedOutput = JSON.parse(rawOutput);
    incrementUsage(clientId);

    return res.json({
      description: parsedOutput.description,
      highlights: parsedOutput.highlights,
      composition: parsedOutput.composition,
      usage: {
        count: getUsageForClient(clientId).count,
        limit: monthlyGenerationLimit,
        period: getUsageForClient(clientId).period,
      },
    });
  } catch (error) {
    console.error("Failed to generate product content:", error);
    return res.status(500).json({
      error:
        error?.message || "OpenAI request failed while generating content.",
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

function isAuthorized(req) {
  if (!requiredAccessToken) {
    return true;
  }

  return req.get("x-extension-token") === requiredAccessToken;
}

function normalizeClientId(value) {
  if (typeof value !== "string") {
    return "unknown-client";
  }

  const cleaned = value.trim().toLowerCase();
  return cleaned || "unknown-client";
}

function getCurrentUsagePeriod() {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}`;
}

function getUsageKey(clientId) {
  return `${clientId}:${getCurrentUsagePeriod()}`;
}

function getUsageForClient(clientId) {
  const period = getCurrentUsagePeriod();
  const key = getUsageKey(clientId);
  const existing = usageByClientAndMonth.get(key);

  if (existing) {
    return { count: existing.count, period };
  }

  return { count: 0, period };
}

function incrementUsage(clientId) {
  const key = getUsageKey(clientId);
  const existing = usageByClientAndMonth.get(key);

  usageByClientAndMonth.set(key, {
    count: existing ? existing.count + 1 : 1,
  });
}
