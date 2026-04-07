require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
const port = Number(process.env.PORT) || 5000;
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
  });
});

app.post("/generate-product-content", async (req, res) => {
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : "";

  if (!title) {
    return res.status(400).json({ error: "Title is required" });
  }

  if (!openai) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not set in the backend environment.",
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
                "You write polished ecommerce product copy for Shopify stores. Return valid JSON with keys description and bullets. description must be one concise premium paragraph. bullets must be an array of exactly 3 short customer-facing benefit bullets. Do not include headings, markdown, SEO keywords, HTML, or extra keys.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Product title: ${title}`,
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
              bullets: {
                type: "array",
                items: { type: "string" },
                minItems: 3,
                maxItems: 3,
              },
            },
            required: ["description", "bullets"],
          },
        },
      },
    });

    const rawOutput = response.output_text;
    const parsedOutput = JSON.parse(rawOutput);

    return res.json({
      description: parsedOutput.description,
      bullets: parsedOutput.bullets,
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
