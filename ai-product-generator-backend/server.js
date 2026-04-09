require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT) || 5000;
const monthlyGenerationLimit =
  Number(process.env.MONTHLY_GENERATION_LIMIT) || 5;
const freePlanName = process.env.DEFAULT_PLAN_NAME || "free";
const requiredAccessToken = process.env.ACCESS_TOKEN || "";
const adminPanelToken = process.env.ADMIN_PANEL_TOKEN || "";
const paymentInstructions =
  process.env.PAYMENT_INSTRUCTIONS ||
  "Transfers through Whish, BOB Finance, or OMT must be sent to +961 70 221 936. After payment, submit your transaction reference and optional proof screenshot in the app.";
const supportContact =
  process.env.SUPPORT_CONTACT || "WhatsApp +961 70 221 936";
const maxProofDataUrlLength = 2500000;
const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5000",
  "chrome-extension://*",
  "https://admin.shopify.com",
  "https://*.myshopify.com",
];
const configuredAllowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const derivedAllowedOrigins = [
  process.env.SHOPIFY_APP_URL,
  process.env.SHOPIFY_ADMIN_URL,
]
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);
const allowedOrigins = Array.from(
  new Set([
    ...defaultAllowedOrigins,
    ...configuredAllowedOrigins,
    ...derivedAllowedOrigins,
  ]),
);
const databaseUrl = process.env.DATABASE_URL || "";
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const usageByClientAndMonth = new Map();
const contentPresetsByClient = new Map();
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
    })
  : null;

initializeDatabase().catch((error) => {
  console.error("Failed to initialize database:", error);
});

app.use(
  cors((req, callback) => {
    const origin = req.get("origin");

    if (!origin) {
      callback(null, { origin: true });
      return;
    }

    const hasValidExtensionToken =
      Boolean(requiredAccessToken) &&
      req.get("x-extension-token") === requiredAccessToken;
    const hasValidAdminToken =
      Boolean(adminPanelToken) && req.get("x-admin-token") === adminPanelToken;

    if (hasValidExtensionToken || hasValidAdminToken) {
      callback(null, { origin: true });
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

    if (!isAllowed) {
      console.warn(
        `Rejected CORS origin: ${origin}. Allowed origins: ${allowedOrigins.join(", ")}`,
      );
    }

    callback(null, { origin: isAllowed });
  }),
);

app.use(express.json({ limit: "3mb" }));
app.use(
  "/admin/assets",
  express.static(path.join(__dirname, "admin-panel"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    },
  }),
);

app.get("/admin", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "admin-panel", "admin.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    allowedOrigins,
    authEnabled: Boolean(requiredAccessToken),
    adminEnabled: Boolean(adminPanelToken),
    monthlyGenerationLimit,
    databaseEnabled: Boolean(pool),
    defaultPlanName: freePlanName,
    manualBillingEnabled: true,
  });
});

app.get("/plans", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const plans = await listPlans();
    return res.json({
      plans: plans.map((plan) => ({
        ...enrichPlan(plan),
        isPaid: plan.price_cents > 0,
      })),
      paymentInstructions,
      supportContact,
    });
  } catch (error) {
    console.error("Failed to list plans:", error);
    return res.status(500).json({
      error: error?.message || "Failed to load plans.",
    });
  }
});

app.get("/usage", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.query.clientId);
    const shop = await ensureShop(clientId);
    const plan = await getPlanForShop(shop.id);
    const usage = await getUsageForClient(clientId);

    return res.json({
      clientId,
      shop,
      plan,
      usage,
      limit: plan.monthly_generation_limit,
      remaining: Math.max(plan.monthly_generation_limit - usage.count, 0),
      period: usage.period,
    });
  } catch (error) {
    console.error("Failed to fetch usage:", error);
    return res.status(500).json({
      error: error?.message || "Failed to fetch usage.",
    });
  }
});

app.get("/shop-status", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.query.clientId);
    const shop = await ensureShop(clientId);
    const plan = await getPlanForShop(shop.id);
    const usage = await getUsageForClient(clientId);
    const latestRequest = await getLatestPlanRequestForShop(shop.id);
    const profile = await getShopProfile(shop.id);

    return res.json({
      clientId,
      shop,
      plan,
      usage,
      remaining: Math.max(plan.monthly_generation_limit - usage.count, 0),
      latestRequest,
      profile,
      paymentInstructions,
      supportContact,
    });
  } catch (error) {
    console.error("Failed to fetch shop status:", error);
    return res.status(500).json({
      error: error?.message || "Failed to fetch shop status.",
    });
  }
});

app.post("/shop-profile", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.body?.clientId);
    const shop = await ensureShop(clientId);
    const profile = await upsertShopProfile(shop.id, {
      businessType: sanitizeText(req.body?.businessType, 120),
      brandTone: sanitizeText(req.body?.brandTone, 120),
      targetAudience: sanitizeText(req.body?.targetAudience, 160),
      descriptionStyle: sanitizeText(req.body?.descriptionStyle, 120),
      brandGuidelines: sanitizeText(req.body?.brandGuidelines, 2000),
    });

    return res.json({
      message: "Shop profile saved successfully.",
      profile,
    });
  } catch (error) {
    console.error("Failed to save shop profile:", error);
    return res.status(500).json({
      error: error?.message || "Failed to save the shop profile.",
    });
  }
});

app.get("/content-presets", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.query.clientId);
    const shop = await ensureShop(clientId);
    const plan = await getPlanForShop(shop.id);

    if (!hasPlanFeature(plan, "presetsEnabled")) {
      return res.status(403).json({
        error: "Your current plan does not include saved presets.",
      });
    }

    const presets = await listContentPresetsForShop(shop.id, clientId);

    return res.json({ presets });
  } catch (error) {
    console.error("Failed to load content presets:", error);
    return res.status(500).json({
      error: error?.message || "Failed to load content presets.",
    });
  }
});

app.post("/content-presets", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.body?.clientId);
    const shop = await ensureShop(clientId);
    const plan = await getPlanForShop(shop.id);

    if (!hasPlanFeature(plan, "presetsEnabled")) {
      return res.status(403).json({
        error: "Upgrade to a higher plan to save content presets.",
      });
    }

    const preset = await createContentPresetForShop(shop.id, clientId, {
      name: sanitizeText(req.body?.name, 80),
      mode: normalizeGenerationMode(req.body?.mode),
      language: normalizeGenerationLanguage(req.body?.language),
      instructions: sanitizeText(req.body?.instructions, 1000),
    });

    return res.status(201).json({
      message: "Preset saved successfully.",
      preset,
    });
  } catch (error) {
    console.error("Failed to save content preset:", error);
    return res.status(500).json({
      error: error?.message || "Failed to save the content preset.",
    });
  }
});

app.post("/content-presets/:id/delete", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.body?.clientId);
    const shop = await ensureShop(clientId);
    const plan = await getPlanForShop(shop.id);
    const presetId = Number(req.params.id);

    if (!hasPlanFeature(plan, "presetsEnabled")) {
      return res.status(403).json({
        error: "Your current plan does not include saved presets.",
      });
    }

    if (!Number.isInteger(presetId) || presetId <= 0) {
      return res.status(400).json({ error: "Invalid preset id." });
    }

    await deleteContentPresetForShop(shop.id, clientId, presetId);

    return res.json({ message: "Preset deleted successfully." });
  } catch (error) {
    console.error("Failed to delete content preset:", error);
    return res.status(500).json({
      error: error?.message || "Failed to delete the content preset.",
    });
  }
});

app.post("/plan-requests", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      error: "Unauthorized. Missing or invalid extension access token.",
    });
  }

  try {
    const clientId = normalizeClientId(req.body?.clientId);
    const requestedPlanName =
      typeof req.body?.requestedPlanName === "string"
        ? req.body.requestedPlanName.trim().toLowerCase()
        : "";
    const contactName = sanitizeText(req.body?.contactName, 120);
    const phoneNumber = sanitizeText(req.body?.phoneNumber, 60);
    const email = sanitizeText(req.body?.email, 160);
    const contactChannel = [phoneNumber ? `Phone: ${phoneNumber}` : "", email ? `Email: ${email}` : ""]
      .filter(Boolean)
      .join(" | ");
    const paymentMethod = sanitizeText(req.body?.paymentMethod, 80);
    const paymentReference = sanitizeText(req.body?.paymentReference, 160);
    const customerNotes = sanitizeText(req.body?.notes, 1000);
    const proofFileName = sanitizeText(req.body?.proofFileName, 255);
    const proofMimeType = sanitizeText(req.body?.proofMimeType, 120);
    const proofDataUrl = sanitizeProofDataUrl(req.body?.proofDataUrl);

    if (!requestedPlanName) {
      return res.status(400).json({ error: "Requested plan is required." });
    }

    if (!contactName) {
      return res
        .status(400)
        .json({ error: "Please provide your full name." });
    }

    if (!phoneNumber) {
      return res
        .status(400)
        .json({ error: "Please provide a phone number for follow-up." });
    }

    const shop = await ensureShop(clientId);
    const currentPlan = await getPlanForShop(shop.id);
    const requestedPlan = await getPlanByName(requestedPlanName);

    if (!requestedPlan || !requestedPlan.is_active) {
      return res.status(404).json({ error: "Requested plan was not found." });
    }

    if (requestedPlan.price_cents <= 0) {
      return res.status(400).json({
        error: "Only paid plans can be requested through manual approval.",
      });
    }

    if (
      currentPlan.name === requestedPlan.name &&
      currentPlan.status === "active" &&
      currentPlan.is_active
    ) {
      return res.status(400).json({
        error: "This shop is already on the selected plan.",
      });
    }

    const existingPendingRequest = await getPendingPlanRequestForShop(
      shop.id,
      requestedPlan.id,
    );

    if (existingPendingRequest) {
      return res.status(409).json({
        error:
          "There is already a pending request for this plan. We will review it after payment is confirmed.",
      });
    }

    const insertedRequest = await createPlanRequest({
      shopId: shop.id,
      currentPlanId: currentPlan.id || null,
      requestedPlanId: requestedPlan.id,
      contactName,
      contactChannel,
      paymentMethod,
      paymentReference,
      customerNotes,
      proofFileName,
      proofMimeType,
      proofDataUrl,
    });

    return res.status(201).json({
      message:
        "Your upgrade request was sent successfully. We will activate the paid plan after confirming your payment.",
      request: insertedRequest,
      paymentInstructions,
      supportContact,
    });
  } catch (error) {
    console.error("Failed to create plan request:", error);
    return res.status(500).json({
      error: error?.message || "Failed to create the plan request.",
    });
  }
});

app.post("/generate-product-content", async (req, res) => {
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const clientId = normalizeClientId(req.body?.clientId);
  const generationMode = normalizeGenerationMode(req.body?.mode);
  const requestedLanguage = normalizeGenerationLanguage(req.body?.language);
  const existingDescription = sanitizeText(req.body?.existingDescription, 5000);
  const presetInstructions = sanitizeText(req.body?.presetInstructions, 1000);

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

  try {
    const shop = await ensureShop(clientId);
    const plan = await getPlanForShop(shop.id);
    const usage = await getUsageForClient(clientId);
    const profile = await getShopProfile(shop.id);

    if (!shop.is_active) {
      return res.status(403).json({
        error: "This shop is not active.",
      });
    }

    if (!plan.is_active || plan.status !== "active") {
      return res.status(403).json({
        error: "This shop does not have an active subscription.",
      });
    }

    if (!hasPlanFeature(plan, "multilingualEnabled") && requestedLanguage !== "English") {
      return res.status(403).json({
        error: "Your current plan does not include multilingual generation.",
      });
    }

    if (
      !hasPlanFeature(plan, "advancedModesEnabled") &&
      !["conversion", "rewrite"].includes(generationMode)
    ) {
      return res.status(403).json({
        error: "Your current plan does not include advanced generation modes.",
      });
    }

    if (!hasPlanFeature(plan, "presetsEnabled") && presetInstructions) {
      return res.status(403).json({
        error: "Your current plan does not include saved preset instructions.",
      });
    }

    if (usage.count >= plan.monthly_generation_limit) {
      return res.status(429).json({
        error: "Monthly generation limit reached for this shop.",
        usage: {
          count: usage.count,
          limit: plan.monthly_generation_limit,
          period: usage.period,
        },
      });
    }

    const response = await openai.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: buildGenerationSystemPrompt({
                generationMode,
                requestedLanguage,
                presetInstructions,
              }),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildGenerationUserPrompt({
                title,
                clientId,
                profile,
                generationMode,
                requestedLanguage,
                existingDescription,
                presetInstructions,
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "product_copy",
          strict: true,
          schema: getProductCopySchema(),
        },
      },
    });

    const parsedOutput = JSON.parse(response.output_text);
    const updatedUsage = await incrementUsage(shop.id, clientId);
    await recordUsageEvent(shop.id, updatedUsage.period, title);

    return res.json({
      description: parsedOutput.description,
      highlights: parsedOutput.highlights,
      composition: parsedOutput.composition,
      metaTitle: parsedOutput.metaTitle,
      metaDescription: parsedOutput.metaDescription,
      subtitle: parsedOutput.subtitle,
      faq: parsedOutput.faq,
      mode: generationMode,
      language: requestedLanguage,
      usage: {
        count: updatedUsage.count,
        limit: plan.monthly_generation_limit,
        period: updatedUsage.period,
      },
      plan: {
        id: plan.id,
        name: plan.name,
      },
      profile,
    });
  } catch (error) {
    console.error("Failed to generate product content:", error);
    return res.status(500).json({
      error:
        error?.message || "OpenAI request failed while generating content.",
    });
  }
});

app.get("/admin/api/dashboard", async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }

  try {
    const [summary, requests] = await Promise.all([
      getAdminSummary(),
      listPlanRequests("pending"),
    ]);

    return res.json({
      summary,
      pendingRequests: requests,
      paymentInstructions,
      supportContact,
    });
  } catch (error) {
    console.error("Failed to load admin dashboard:", error);
    return res.status(500).json({
      error: error?.message || "Failed to load admin dashboard.",
    });
  }
});

app.get("/admin/api/plan-requests", async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }

  try {
    const requests = await listPlanRequests(req.query.status);
    return res.json({ requests });
  } catch (error) {
    console.error("Failed to load plan requests:", error);
    return res.status(500).json({
      error: error?.message || "Failed to load plan requests.",
    });
  }
});

app.post("/admin/api/plan-requests/:id/approve", async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }

  try {
    const requestId = Number(req.params.id);
    const adminNotes = sanitizeText(req.body?.adminNotes, 1000);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: "Invalid request id." });
    }

    const updatedRequest = await approvePlanRequest(
      requestId,
      adminNotes,
      "manual-admin",
    );

    return res.json({
      message: "Plan request approved and subscription updated.",
      request: updatedRequest,
    });
  } catch (error) {
    console.error("Failed to approve plan request:", error);
    return res.status(500).json({
      error: error?.message || "Failed to approve the request.",
    });
  }
});

app.post("/admin/api/plan-requests/:id/reject", async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }

  try {
    const requestId = Number(req.params.id);
    const adminNotes = sanitizeText(req.body?.adminNotes, 1000);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: "Invalid request id." });
    }

    const updatedRequest = await rejectPlanRequest(
      requestId,
      adminNotes,
      "manual-admin",
    );

    return res.json({
      message: "Plan request rejected.",
      request: updatedRequest,
    });
  } catch (error) {
    console.error("Failed to reject plan request:", error);
    return res.status(500).json({
      error: error?.message || "Failed to reject the request.",
    });
  }
});

app.use((error, req, res, _next) => {
  console.error("Unhandled server error:", error);

  if (req.path.startsWith("/admin/api/")) {
    return res.status(500).json({
      error: error?.message || "Internal server error.",
    });
  }

  return res.status(500).json({
    error: error?.message || "Internal server error.",
  });
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

function isAdminAuthorized(req) {
  if (!adminPanelToken) {
    return false;
  }

  return req.get("x-admin-token") === adminPanelToken;
}

function normalizeClientId(value) {
  if (typeof value !== "string") {
    return "unknown-client";
  }

  const cleaned = value.trim().toLowerCase();
  return cleaned || "unknown-client";
}

function sanitizeText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function sanitizeProofDataUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (!trimmed.startsWith("data:image/")) {
    throw new Error("Payment proof must be an image file.");
  }

  if (trimmed.length > maxProofDataUrlLength) {
    throw new Error("Payment proof is too large. Please upload a smaller file.");
  }

  return trimmed;
}

function normalizeOrigin(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  try {
    return new URL(trimmed).origin;
  } catch (_error) {
    return trimmed.replace(/\/$/, "");
  }
}

function normalizeGenerationMode(value) {
  const supportedModes = new Set([
    "conversion",
    "luxury",
    "seo",
    "technical",
    "benefits",
    "mobile",
    "rewrite",
  ]);
  const normalized = sanitizeText(value, 40).toLowerCase();
  return supportedModes.has(normalized) ? normalized : "conversion";
}

function normalizeGenerationLanguage(value) {
  const normalized = sanitizeText(value, 40);
  return normalized || "English";
}

function buildGenerationSystemPrompt({
  generationMode,
  requestedLanguage,
  presetInstructions,
}) {
  const modeInstructions = {
    conversion:
      "Prioritize clarity, shopper confidence, and conversion-focused benefits.",
    luxury:
      "Use elevated, premium wording with restraint and polish.",
    seo: "Balance natural product copy with search-friendly phrasing and specificity.",
    technical:
      "Emphasize construction details, materials, performance, and precision.",
    benefits:
      "Lead with customer outcomes, comfort, utility, and everyday advantages.",
    mobile:
      "Write shorter, cleaner copy optimized for quick scanning on mobile screens.",
    rewrite:
      "Improve and refine the existing product copy instead of starting from scratch when existing copy is provided.",
  };

  return [
    "You write polished ecommerce product copy for premium Shopify stores.",
    "Return valid JSON only.",
    "Write all output in the requested language.",
    modeInstructions[generationMode] || modeInstructions.conversion,
    "Adapt the writing to the provided business profile so the copy feels specific to that store.",
    "Keep the tone customer-facing, modern, and commercially useful.",
    "Do not mention AI, SEO, markdown, numbering, or internal instructions.",
    "description must be 1 to 2 short paragraphs.",
    "highlights must be an array of exactly 6 concise benefit lines.",
    "composition must be an array of exactly 2 concise material or construction lines.",
    "metaTitle must stay under 60 characters when possible.",
    "metaDescription must stay under 155 characters when possible.",
    "subtitle must be a short merchandising line.",
    "faq must be an array of exactly 3 objects with question and answer keys.",
    presetInstructions
      ? `Additional preset instructions: ${presetInstructions}`
      : "",
  ].join(" ");
}

function buildGenerationUserPrompt({
  title,
  clientId,
  profile,
  generationMode,
  requestedLanguage,
  existingDescription,
  presetInstructions,
}) {
  return [
    `Product title: ${title}`,
    `Client/store identifier: ${clientId}`,
    `Requested language: ${requestedLanguage}`,
    `Generation mode: ${generationMode}`,
    "Business profile:",
    `- Business type: ${profile.business_type || "general ecommerce"}`,
    `- Brand tone: ${profile.brand_tone || "premium, modern"}`,
    `- Target audience: ${profile.target_audience || "broad online shoppers"}`,
    `- Description style: ${profile.description_style || "benefits-first"}`,
    `- Brand guidelines: ${profile.brand_guidelines || "Keep it clean, polished, customer-facing, and specific to the product."}`,
    presetInstructions
      ? `Saved preset instructions: ${presetInstructions}`
      : "Saved preset instructions:\nNone provided.",
    existingDescription ? `Existing product copy to improve:\n${existingDescription}` : "Existing product copy to improve:\nNone provided.",
    "Create a full content package for this product including description, highlights, composition, SEO metadata, subtitle, and FAQ.",
  ].join("\n");
}

function getProductCopySchema() {
  return {
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
      metaTitle: { type: "string" },
      metaDescription: { type: "string" },
      subtitle: { type: "string" },
      faq: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string" },
            answer: { type: "string" },
          },
          required: ["question", "answer"],
        },
        minItems: 3,
        maxItems: 3,
      },
    },
    required: [
      "description",
      "highlights",
      "composition",
      "metaTitle",
      "metaDescription",
      "subtitle",
      "faq",
    ],
  };
}

function getCurrentUsagePeriod() {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}`;
}

function getUsageKey(clientId) {
  return `${clientId}:${getCurrentUsagePeriod()}`;
}

async function getUsageForClient(clientId) {
  if (pool) {
    const period = getCurrentUsagePeriod();
    const result = await pool.query(
      `
        SELECT usage_count
        FROM client_usage
        WHERE client_id = $1 AND usage_period = $2
      `,
      [clientId, period],
    );

    return {
      count: result.rows[0]?.usage_count || 0,
      period,
    };
  }

  const period = getCurrentUsagePeriod();
  const key = getUsageKey(clientId);
  const existing = usageByClientAndMonth.get(key);

  if (existing) {
    return { count: existing.count, period };
  }

  return { count: 0, period };
}

async function incrementUsage(shopId, clientId) {
  if (pool) {
    const period = getCurrentUsagePeriod();
    const result = await pool.query(
      `
        INSERT INTO client_usage (shop_id, client_id, usage_period, usage_count)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (client_id, usage_period)
        DO UPDATE SET
          shop_id = EXCLUDED.shop_id,
          usage_count = client_usage.usage_count + 1,
          updated_at = NOW()
        RETURNING usage_count
      `,
      [shopId, clientId, period],
    );

    return {
      count: result.rows[0]?.usage_count || 1,
      period,
    };
  }

  const key = getUsageKey(clientId);
  const existing = usageByClientAndMonth.get(key);
  const nextCount = existing ? existing.count + 1 : 1;

  usageByClientAndMonth.set(key, {
    count: nextCount,
  });

  return {
    count: nextCount,
    period: getCurrentUsagePeriod(),
  };
}

async function initializeDatabase() {
  if (!pool) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrations = [
    {
      version: "001_initial_usage",
      sql: `
        CREATE TABLE IF NOT EXISTS client_usage (
          client_id TEXT NOT NULL,
          usage_period TEXT NOT NULL,
          usage_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (client_id, usage_period)
        )
      `,
    },
    {
      version: "002_saas_tables",
      sql: `
        CREATE TABLE IF NOT EXISTS plans (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          monthly_generation_limit INTEGER NOT NULL,
          price_cents INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS shops (
          id SERIAL PRIMARY KEY,
          client_id TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS subscriptions (
          id SERIAL PRIMARY KEY,
          shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          plan_id INTEGER NOT NULL REFERENCES plans(id),
          status TEXT NOT NULL DEFAULT 'active',
          current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          current_period_end TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (shop_id)
        );

        CREATE TABLE IF NOT EXISTS usage_events (
          id SERIAL PRIMARY KEY,
          shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          usage_period TEXT NOT NULL,
          event_type TEXT NOT NULL DEFAULT 'generation',
          product_title TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `,
    },
    {
      version: "003_client_usage_shop_id",
      sql: `
        ALTER TABLE client_usage
        ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE
      `,
    },
    {
      version: "004_plan_requests",
      sql: `
        CREATE TABLE IF NOT EXISTS plan_requests (
          id SERIAL PRIMARY KEY,
          shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          current_plan_id INTEGER REFERENCES plans(id),
          requested_plan_id INTEGER NOT NULL REFERENCES plans(id),
          status TEXT NOT NULL DEFAULT 'pending',
          contact_name TEXT,
          contact_channel TEXT NOT NULL DEFAULT '',
          payment_method TEXT,
          payment_reference TEXT,
          customer_notes TEXT,
          admin_notes TEXT,
          proof_file_name TEXT,
          proof_mime_type TEXT,
          proof_data_url TEXT,
          resolved_by TEXT,
          resolved_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    },
    {
      version: "005_shop_profiles",
      sql: `
        CREATE TABLE IF NOT EXISTS shop_profiles (
          shop_id INTEGER PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
          business_type TEXT NOT NULL DEFAULT '',
          brand_tone TEXT NOT NULL DEFAULT '',
          target_audience TEXT NOT NULL DEFAULT '',
          description_style TEXT NOT NULL DEFAULT '',
          brand_guidelines TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    },
    {
      version: "006_plan_descriptions",
      sql: `
        ALTER TABLE plans
        ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''
      `,
    },
    {
      version: "007_content_presets",
      sql: `
        CREATE TABLE IF NOT EXISTS content_presets (
          id SERIAL PRIMARY KEY,
          shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'conversion',
          language TEXT NOT NULL DEFAULT 'English',
          instructions TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    },
  ];

  for (const migration of migrations) {
    const alreadyApplied = await pool.query(
      `
        SELECT version
        FROM schema_migrations
        WHERE version = $1
      `,
      [migration.version],
    );

    if (alreadyApplied.rows[0]) {
      continue;
    }

    await pool.query("BEGIN");

    try {
      await pool.query(migration.sql);
      await pool.query(
        `
          INSERT INTO schema_migrations (version)
          VALUES ($1)
        `,
        [migration.version],
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }

  await seedPlans();
  await syncLegacyPlanAssignments();
}

async function listPlans() {
  if (!pool) {
    return [enrichPlan(buildFallbackFreePlan())];
  }

  const result = await pool.query(
    `
      SELECT id, name, description, monthly_generation_limit, price_cents, is_active
      FROM plans
      WHERE is_active = TRUE
      ORDER BY price_cents ASC, id ASC
    `,
  );

  return result.rows.map((plan) => enrichPlan(plan));
}

async function getPlanByName(name) {
  if (!pool) {
    if (name === freePlanName) {
      return enrichPlan(buildFallbackFreePlan());
    }

    return null;
  }

  const result = await pool.query(
    `
      SELECT id, name, description, monthly_generation_limit, price_cents, is_active
      FROM plans
      WHERE name = $1
      LIMIT 1
    `,
    [name],
  );

  return result.rows[0] ? enrichPlan(result.rows[0]) : null;
}

async function seedPlans() {
  if (!pool) {
    return;
  }

  await pool.query(`
    INSERT INTO plans (name, description, monthly_generation_limit, price_cents)
    VALUES
      (
        'free',
        '5 generations per month for trying the app. Includes single-product generation only. Bulk tools and saved presets are not included.',
        5,
        0
      ),
      (
        'starter',
        '300 generations per month for steady single-product work. Best for small catalogs that do not need bulk generation or saved presets yet.',
        300,
        900
      ),
      (
        'growth',
        '1,000 generations per month with bulk generation, saved presets, audit filters, previews, and multilingual workflows.',
        1000,
        2400
      ),
      (
        'scale',
        '3,000 generations per month with full access to bulk workflows, saved presets, multilingual generation, and advanced catalog optimization.',
        3000,
        4900
      )
    ON CONFLICT (name) DO UPDATE SET
      description = EXCLUDED.description,
      monthly_generation_limit = EXCLUDED.monthly_generation_limit,
      price_cents = EXCLUDED.price_cents,
      is_active = TRUE,
      updated_at = NOW()
  `);

  await pool.query(`
    UPDATE plans
    SET is_active = FALSE, updated_at = NOW()
    WHERE name = 'agency'
  `);
}

async function syncLegacyPlanAssignments() {
  if (!pool) {
    return;
  }

  const legacyPlanMappings = [
    { legacyName: "pro", currentName: "growth" },
    { legacyName: "agency", currentName: "scale" },
  ];

  for (const mapping of legacyPlanMappings) {
    const result = await pool.query(
      `
        SELECT
          legacy.id AS legacy_id,
          current_plan.id AS current_id
        FROM plans AS legacy
        JOIN plans AS current_plan
          ON current_plan.name = $2
        WHERE legacy.name = $1
        LIMIT 1
      `,
      [mapping.legacyName, mapping.currentName],
    );

    const legacyId = result.rows[0]?.legacy_id;
    const currentId = result.rows[0]?.current_id;

    if (!legacyId || !currentId || legacyId === currentId) {
      continue;
    }

    await pool.query(
      `
        UPDATE subscriptions
        SET
          plan_id = $2,
          updated_at = NOW()
        WHERE plan_id = $1
      `,
      [legacyId, currentId],
    );

    await pool.query(
      `
        UPDATE plan_requests
        SET
          requested_plan_id = $2,
          updated_at = NOW()
        WHERE requested_plan_id = $1
      `,
      [legacyId, currentId],
    );

    await pool.query(
      `
        UPDATE plan_requests
        SET
          current_plan_id = $2,
          updated_at = NOW()
        WHERE current_plan_id = $1
      `,
      [legacyId, currentId],
    );

    await pool.query(
      `
        UPDATE plans
        SET
          is_active = FALSE,
          updated_at = NOW()
        WHERE id = $1
      `,
      [legacyId],
    );
  }
}

async function ensureShop(clientId) {
  if (!pool) {
    return {
      id: 0,
      client_id: clientId,
      display_name: clientId,
      is_active: true,
    };
  }

  const existingShop = await pool.query(
    `
      SELECT id, client_id, display_name, is_active
      FROM shops
      WHERE client_id = $1
    `,
    [clientId],
  );

  if (existingShop.rows[0]) {
    const shop = existingShop.rows[0];
    await ensureSubscription(shop.id);
    return shop;
  }

  const insertedShop = await pool.query(
    `
      INSERT INTO shops (client_id, display_name)
      VALUES ($1, $2)
      RETURNING id, client_id, display_name, is_active
    `,
    [clientId, clientId.replace(/^shopify-store:/, "")],
  );

  const shop = insertedShop.rows[0];
  await ensureSubscription(shop.id);
  return shop;
}

async function ensureSubscription(shopId) {
  if (!pool) {
    return;
  }

  const existing = await pool.query(
    `
      SELECT id
      FROM subscriptions
      WHERE shop_id = $1
    `,
    [shopId],
  );

  if (existing.rows[0]) {
    return;
  }

  const defaultPlan = await pool.query(
    `
      SELECT id
      FROM plans
      WHERE name = $1
      LIMIT 1
    `,
    [freePlanName],
  );

  const planId = defaultPlan.rows[0]?.id;

  if (!planId) {
    throw new Error(`Default plan "${freePlanName}" was not found.`);
  }

  await pool.query(
    `
      INSERT INTO subscriptions (shop_id, plan_id, status)
      VALUES ($1, $2, 'active')
      ON CONFLICT (shop_id) DO NOTHING
    `,
    [shopId, planId],
  );
}

async function getPlanForShop(shopId) {
  if (!pool) {
    return enrichPlan({
      ...buildFallbackFreePlan(),
      status: "active",
    });
  }

  const result = await pool.query(
    `
      SELECT
        plans.id,
        plans.name,
        plans.description,
        plans.monthly_generation_limit,
        plans.price_cents,
        plans.is_active,
        subscriptions.status
      FROM subscriptions
      JOIN plans ON plans.id = subscriptions.plan_id
      WHERE subscriptions.shop_id = $1
      LIMIT 1
    `,
    [shopId],
  );

  if (result.rows[0]) {
    return enrichPlan(result.rows[0]);
  }

  return enrichPlan({
    ...buildFallbackFreePlan(),
    status: "active",
  });
}

function buildFallbackFreePlan() {
  return {
    id: 0,
    name: freePlanName,
    description:
      "5 generations per month for trying the app. Includes single-product generation only. Bulk tools and saved presets are not included.",
    monthly_generation_limit: monthlyGenerationLimit,
    price_cents: 0,
    is_active: true,
  };
}

function getPlanFeatureFlags(planName) {
  const normalized = String(planName || "").trim().toLowerCase();

  if (normalized === "growth" || normalized === "scale") {
    return {
      presetsEnabled: true,
      bulkGenerationEnabled: true,
      multilingualEnabled: true,
      advancedModesEnabled: true,
    };
  }

  return {
    presetsEnabled: false,
    bulkGenerationEnabled: false,
    multilingualEnabled: false,
    advancedModesEnabled: false,
  };
}

function enrichPlan(plan) {
  const features = getPlanFeatureFlags(plan?.name);
  const featuresList = getPlanFeatureList(plan?.name);

  return {
    ...plan,
    features,
    features_list: featuresList,
  };
}

function hasPlanFeature(plan, featureName) {
  return Boolean(enrichPlan(plan)?.features?.[featureName]);
}

function getPlanFeatureList(planName) {
  const normalized = String(planName || "").trim().toLowerCase();

  if (normalized === "free") {
    return [
      "5 generations per month",
      "Single-product generation",
      "Bulk generation locked",
      "Saved presets locked",
    ];
  }

  if (normalized === "starter") {
    return [
      "300 generations per month",
      "Single-product generation",
      "Catalog audit visibility",
      "Bulk generation locked",
      "Saved presets locked",
    ];
  }

  if (normalized === "growth") {
    return [
      "1,000 generations per month",
      "Bulk generation and preview",
      "Saved presets",
      "Multilingual generation",
      "Advanced generation modes",
    ];
  }

  if (normalized === "scale") {
    return [
      "3,000 generations per month",
      "Bulk generation and preview",
      "Saved presets",
      "Multilingual generation",
      "Advanced generation modes",
    ];
  }

  return [];
}

async function getLatestPlanRequestForShop(shopId) {
  if (!pool || !shopId) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT
        plan_requests.id,
        plan_requests.status,
        plan_requests.contact_name,
        plan_requests.contact_channel,
        plan_requests.payment_method,
        plan_requests.payment_reference,
        plan_requests.customer_notes,
        plan_requests.created_at,
        plan_requests.updated_at,
        requested_plans.name AS requested_plan_name,
        requested_plans.description AS requested_plan_description,
        requested_plans.price_cents AS requested_plan_price_cents
      FROM plan_requests
      JOIN plans AS requested_plans
        ON requested_plans.id = plan_requests.requested_plan_id
      WHERE plan_requests.shop_id = $1
      ORDER BY plan_requests.created_at DESC
      LIMIT 1
    `,
    [shopId],
  );

  return result.rows[0] || null;
}

async function getShopProfile(shopId) {
  const emptyProfile = {
    business_type: "",
    brand_tone: "",
    target_audience: "",
    description_style: "",
    brand_guidelines: "",
  };

  if (!pool || !shopId) {
    return emptyProfile;
  }

  const result = await pool.query(
    `
      SELECT
        business_type,
        brand_tone,
        target_audience,
        description_style,
        brand_guidelines
      FROM shop_profiles
      WHERE shop_id = $1
      LIMIT 1
    `,
    [shopId],
  );

  return result.rows[0] || emptyProfile;
}

async function upsertShopProfile(shopId, profile) {
  if (!pool) {
    return {
      business_type: profile.businessType || "",
      brand_tone: profile.brandTone || "",
      target_audience: profile.targetAudience || "",
      description_style: profile.descriptionStyle || "",
      brand_guidelines: profile.brandGuidelines || "",
    };
  }

  const result = await pool.query(
    `
      INSERT INTO shop_profiles (
        shop_id,
        business_type,
        brand_tone,
        target_audience,
        description_style,
        brand_guidelines
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (shop_id)
      DO UPDATE SET
        business_type = EXCLUDED.business_type,
        brand_tone = EXCLUDED.brand_tone,
        target_audience = EXCLUDED.target_audience,
        description_style = EXCLUDED.description_style,
        brand_guidelines = EXCLUDED.brand_guidelines,
        updated_at = NOW()
      RETURNING
        business_type,
        brand_tone,
        target_audience,
        description_style,
        brand_guidelines
    `,
    [
      shopId,
      profile.businessType || "",
      profile.brandTone || "",
      profile.targetAudience || "",
      profile.descriptionStyle || "",
      profile.brandGuidelines || "",
    ],
  );

  return result.rows[0];
}

async function listContentPresetsForShop(shopId, clientId) {
  if (!pool) {
    return contentPresetsByClient.get(clientId) || [];
  }

  const result = await pool.query(
    `
      SELECT id, name, mode, language, instructions, created_at, updated_at
      FROM content_presets
      WHERE shop_id = $1
      ORDER BY updated_at DESC, id DESC
    `,
    [shopId],
  );

  return result.rows;
}

async function createContentPresetForShop(shopId, clientId, preset) {
  if (!preset.name) {
    throw new Error("Preset name is required.");
  }

  if (!pool) {
    const existing = contentPresetsByClient.get(clientId) || [];
    const nextPreset = {
      id: existing.length + 1,
      name: preset.name,
      mode: preset.mode,
      language: preset.language,
      instructions: preset.instructions,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    contentPresetsByClient.set(clientId, [nextPreset, ...existing]);
    return nextPreset;
  }

  const result = await pool.query(
    `
      INSERT INTO content_presets (
        shop_id,
        name,
        mode,
        language,
        instructions
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, mode, language, instructions, created_at, updated_at
    `,
    [
      shopId,
      preset.name,
      preset.mode,
      preset.language,
      preset.instructions,
    ],
  );

  return result.rows[0];
}

async function deleteContentPresetForShop(shopId, clientId, presetId) {
  if (!pool) {
    const existing = contentPresetsByClient.get(clientId) || [];
    contentPresetsByClient.set(
      clientId,
      existing.filter((preset) => preset.id !== presetId),
    );
    return;
  }

  const result = await pool.query(
    `
      DELETE FROM content_presets
      WHERE id = $1 AND shop_id = $2
      RETURNING id
    `,
    [presetId, shopId],
  );

  if (!result.rows[0]) {
    throw new Error("Preset not found.");
  }
}

async function getPendingPlanRequestForShop(shopId, requestedPlanId) {
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT id
      FROM plan_requests
      WHERE shop_id = $1
        AND requested_plan_id = $2
        AND status = 'pending'
      LIMIT 1
    `,
    [shopId, requestedPlanId],
  );

  return result.rows[0] || null;
}

async function createPlanRequest({
  shopId,
  currentPlanId,
  requestedPlanId,
  contactName,
  contactChannel,
  paymentMethod,
  paymentReference,
  customerNotes,
  proofFileName,
  proofMimeType,
  proofDataUrl,
}) {
  if (!pool) {
    throw new Error("Manual plan requests require a database connection.");
  }

  const result = await pool.query(
    `
      INSERT INTO plan_requests (
        shop_id,
        current_plan_id,
        requested_plan_id,
        status,
        contact_name,
        contact_channel,
        payment_method,
        payment_reference,
        customer_notes,
        proof_file_name,
        proof_mime_type,
        proof_data_url
      )
      VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, status, created_at
    `,
    [
      shopId,
      currentPlanId,
      requestedPlanId,
      contactName,
      contactChannel,
      paymentMethod,
      paymentReference,
      customerNotes,
      proofFileName,
      proofMimeType,
      proofDataUrl,
    ],
  );

  return result.rows[0];
}

async function recordUsageEvent(shopId, usagePeriod, productTitle) {
  if (!pool || !shopId) {
    return;
  }

  await pool.query(
    `
      INSERT INTO usage_events (shop_id, usage_period, event_type, product_title)
      VALUES ($1, $2, 'generation', $3)
    `,
    [shopId, usagePeriod, productTitle],
  );
}

async function listPlanRequests(status) {
  if (!pool) {
    return [];
  }

  const values = [];
  const whereClauses = [];

  if (typeof status === "string" && status.trim()) {
    values.push(status.trim().toLowerCase());
    whereClauses.push(`plan_requests.status = $${values.length}`);
  }

  const whereSql =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const result = await pool.query(
    `
      SELECT
        plan_requests.id,
        plan_requests.status,
        plan_requests.contact_name,
        plan_requests.contact_channel,
        plan_requests.payment_method,
        plan_requests.payment_reference,
        plan_requests.customer_notes,
        plan_requests.admin_notes,
        plan_requests.proof_file_name,
        plan_requests.proof_mime_type,
        plan_requests.proof_data_url,
        plan_requests.resolved_by,
        plan_requests.resolved_at,
        plan_requests.created_at,
        plan_requests.updated_at,
        shops.id AS shop_id,
        shops.client_id,
        shops.display_name,
        current_plans.name AS current_plan_name,
        current_plans.description AS current_plan_description,
        requested_plans.name AS requested_plan_name,
        requested_plans.description AS requested_plan_description,
        requested_plans.price_cents AS requested_plan_price_cents
      FROM plan_requests
      JOIN shops ON shops.id = plan_requests.shop_id
      LEFT JOIN plans AS current_plans
        ON current_plans.id = plan_requests.current_plan_id
      JOIN plans AS requested_plans
        ON requested_plans.id = plan_requests.requested_plan_id
      ${whereSql}
      ORDER BY
        CASE WHEN plan_requests.status = 'pending' THEN 0 ELSE 1 END,
        plan_requests.created_at DESC
    `,
    values,
  );

  return result.rows;
}

async function approvePlanRequest(requestId, adminNotes, resolvedBy) {
  if (!pool) {
    throw new Error("Admin approval requires a database connection.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const requestResult = await client.query(
      `
        SELECT
          plan_requests.id,
          plan_requests.shop_id,
          plan_requests.requested_plan_id,
          plan_requests.status
        FROM plan_requests
        WHERE plan_requests.id = $1
        FOR UPDATE
      `,
      [requestId],
    );

    const requestRow = requestResult.rows[0];

    if (!requestRow) {
      throw new Error("Plan request not found.");
    }

    if (requestRow.status !== "pending") {
      throw new Error("Only pending requests can be approved.");
    }

    await client.query(
      `
        INSERT INTO subscriptions (
          shop_id,
          plan_id,
          status,
          current_period_start,
          current_period_end,
          updated_at
        )
        VALUES ($1, $2, 'active', NOW(), NULL, NOW())
        ON CONFLICT (shop_id)
        DO UPDATE SET
          plan_id = EXCLUDED.plan_id,
          status = 'active',
          current_period_start = NOW(),
          current_period_end = NULL,
          updated_at = NOW()
      `,
      [requestRow.shop_id, requestRow.requested_plan_id],
    );

    await client.query(
      `
        UPDATE plan_requests
        SET
          status = 'approved',
          admin_notes = $2,
          resolved_by = $3,
          resolved_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [requestId, adminNotes, resolvedBy],
    );

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Failed to rollback approvePlanRequest transaction:", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }

  return getPlanRequestById(requestId);
}

async function rejectPlanRequest(requestId, adminNotes, resolvedBy) {
  if (!pool) {
    throw new Error("Admin rejection requires a database connection.");
  }

  const result = await pool.query(
    `
      UPDATE plan_requests
      SET
        status = 'rejected',
        admin_notes = $2,
        resolved_by = $3,
        resolved_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND status = 'pending'
      RETURNING id
    `,
    [requestId, adminNotes, resolvedBy],
  );

  if (!result.rows[0]) {
    throw new Error("Pending plan request not found.");
  }

  return getPlanRequestById(requestId);
}

async function getPlanRequestById(requestId) {
  const requests = await listPlanRequests();
  return requests.find((request) => request.id === requestId) || null;
}

async function getAdminSummary() {
  if (!pool) {
    return {
      pendingRequests: 0,
      approvedRequests: 0,
      activeShops: 0,
      totalUsageEvents: 0,
    };
  }

  const [requestCounts, activeShops, usageEvents] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_requests,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved_requests
      FROM plan_requests
    `),
    pool.query(`
      SELECT COUNT(*) AS active_shops
      FROM shops
      WHERE is_active = TRUE
    `),
    pool.query(`
      SELECT COUNT(*) AS total_usage_events
      FROM usage_events
    `),
  ]);

  return {
    pendingRequests: Number(requestCounts.rows[0]?.pending_requests || 0),
    approvedRequests: Number(requestCounts.rows[0]?.approved_requests || 0),
    activeShops: Number(activeShops.rows[0]?.active_shops || 0),
    totalUsageEvents: Number(usageEvents.rows[0]?.total_usage_events || 0),
  };
}
