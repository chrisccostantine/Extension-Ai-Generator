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
  "Transfers through Whish, BOB Finance, OMT, or Bank Audi Neo must be sent to +961 70 221 936. After payment, submit your transaction reference and proof screenshot in the app.";
const supportContact =
  process.env.SUPPORT_CONTACT ||
  "WhatsApp +961 81 106 116 or email: scalora.socialmedia.agency@gmail.com";
const allowedPaymentMethods = [
  "Whish",
  "OMT Wallet",
  "BOB Finance",
  "Bank Audi Neo",
];
const maxProofDataUrlLength = 2500000;
const maxImageAssetDataUrlLength = 15000000;
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
    const imageUsage = await getImageUsageForShop(shop.id);
    const latestRequest = await getLatestPlanRequestForShop(shop.id);
    const profile = await getShopProfile(shop.id);

    return res.json({
      clientId,
      shop,
      plan,
      usage,
      imageUsage,
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
      defaultLanguage: sanitizeText(req.body?.defaultLanguage, 80) || "English",
      bannedWords: sanitizeText(req.body?.bannedWords, 500),
      preferredKeywords: sanitizeText(req.body?.preferredKeywords, 500),
      brandExampleCopy: sanitizeText(req.body?.brandExampleCopy, 4000),
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

app.get("/catalog-jobs", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.query.clientId);
    const shop = await ensureShop(clientId);
    const jobs = await listCatalogJobsForShop(shop.id);
    return res.json({ jobs });
  } catch (error) {
    console.error("Failed to load catalog jobs:", error);
    return res.status(500).json({
      error: error?.message || "Failed to load catalog jobs.",
    });
  }
});

app.post("/catalog-jobs", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.body?.clientId);
    const shop = await ensureShop(clientId);
    const job = await createCatalogJob({
      shopId: shop.id,
      jobType: sanitizeText(req.body?.jobType, 80) || "bulk_apply",
      status: sanitizeText(req.body?.status, 80) || "completed",
      mode: normalizeGenerationMode(req.body?.mode),
      language: normalizeGenerationLanguage(req.body?.language),
      scopeSummary: sanitizeText(req.body?.scopeSummary, 200),
      totalProducts: Number(req.body?.totalProducts || 0),
      processedProducts: Number(req.body?.processedProducts || 0),
      failedProducts: Number(req.body?.failedProducts || 0),
      lastError: sanitizeText(req.body?.lastError, 400),
    });

    return res.status(201).json({
      message: "Catalog job recorded.",
      job,
    });
  } catch (error) {
    console.error("Failed to record catalog job:", error);
    return res.status(500).json({
      error: error?.message || "Failed to record catalog job.",
    });
  }
});

app.post("/catalog-jobs/:id/update", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.body?.clientId);
    const shop = await ensureShop(clientId);
    const jobId = Number(req.params.id);

    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ error: "Invalid catalog job id." });
    }

    const job = await updateCatalogJob({
      shopId: shop.id,
      jobId,
      status: sanitizeText(req.body?.status, 80),
      processedProducts: Number(req.body?.processedProducts || 0),
      failedProducts: Number(req.body?.failedProducts || 0),
      lastError: sanitizeText(req.body?.lastError, 400),
    });

    return res.json({
      message: "Catalog job updated.",
      job,
    });
  } catch (error) {
    console.error("Failed to update catalog job:", error);
    return res.status(500).json({
      error: error?.message || "Failed to update catalog job.",
    });
  }
});

app.get("/image-jobs", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const clientId = normalizeClientId(req.query.clientId);
    const shop = await ensureShop(clientId);
    const jobs = await listImageJobsForShop(shop.id);
    return res.json({ jobs });
  } catch (error) {
    console.error("Failed to load image jobs:", error);
    return res.status(500).json({
      error: error?.message || "Failed to load image jobs.",
    });
  }
});

app.post("/generate-product-images", async (req, res) => {
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
    const clientId = normalizeClientId(req.body?.clientId);
    const shop = await ensureShop(clientId);
    const plan = await getPlanForShop(shop.id);
    const imageUsage = await getImageUsageForShop(shop.id);
    const instructionText = sanitizeText(req.body?.instructionText, 1200);
    const stylePreset = sanitizeImageStylePreset(req.body?.stylePreset);
    const outputSize = sanitizeImageOutputSize(req.body?.outputSize);
    const backgroundStyle = sanitizeImageBackgroundStyle(req.body?.backgroundStyle);
    const imageCount = sanitizeImageCount(req.body?.imageCount);
    const sourceImages = sanitizeImageDataUrls(req.body?.sourceImages);
    const monthlyImageLimit = Number(plan.monthly_image_limit || 0);
    const remainingImageCredits = Math.max(0, monthlyImageLimit - imageUsage.count);

    if (!hasPlanFeature(plan, "imageGenerationEnabled")) {
      return res.status(403).json({
        error: "Upgrade to Growth or Scale to generate product images.",
      });
    }

    if (imageUsage.count >= monthlyImageLimit) {
      return res.status(429).json({
        error: "Monthly image generation limit reached for this shop.",
        imageUsage: {
          count: imageUsage.count,
          limit: monthlyImageLimit,
          period: imageUsage.period,
        },
      });
    }

    if (!sourceImages.length) {
      return res.status(400).json({
        error: "Upload at least one source product image.",
      });
    }

    const uploadables = await Promise.all(
      sourceImages.map((image, index) =>
        OpenAI.toFile(
          Buffer.from(image.base64, "base64"),
          image.fileName || `product-image-${index + 1}.${image.extension}`,
          { type: image.mimeType },
        ),
      ),
    );

    const imagePrompt = buildImageEditPrompt({
      instructionText,
      stylePreset,
      backgroundStyle,
    });

    const response = await openai.images.edit({
      model: "gpt-image-1",
      image: uploadables,
      prompt: imagePrompt,
      n: Math.min(imageCount, remainingImageCredits || imageCount),
      quality: "high",
      size: outputSize,
      background: backgroundStyle === "transparent" ? "transparent" : "opaque",
    });

    const generatedImages = (response.data || [])
      .map((item, index) =>
        item?.b64_json
          ? {
              id: `${Date.now()}-${index + 1}`,
              mimeType: "image/png",
              dataUrl: `data:image/png;base64,${item.b64_json}`,
            }
          : null,
      )
      .filter(Boolean);

    if (!generatedImages.length) {
      throw new Error("No image outputs were returned by the model.");
    }

    const job = await createImageJob({
      shopId: shop.id,
      status: "completed",
      instructionText,
      stylePreset,
      outputSize,
      backgroundStyle,
      sourceImageCount: sourceImages.length,
      outputImages: generatedImages,
      lastError: "",
    });
    const consumedCredits = generatedImages.length;
    for (let index = 0; index < consumedCredits; index += 1) {
      await recordImageUsageEvent(
        shop.id,
        imageUsage.period,
        `${stylePreset}:${sourceImages.length}:${index + 1}`,
      );
    }

    return res.json({
      message: "Product images generated successfully.",
      job,
      images: generatedImages,
      imageUsage: {
        count: imageUsage.count + consumedCredits,
        limit: monthlyImageLimit,
        period: imageUsage.period,
      },
    });
  } catch (error) {
    console.error("Failed to generate product images:", error);
    return res.status(500).json({
      error: error?.message || "Failed to generate product images.",
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
    const billingInterval = normalizeBillingInterval(req.body?.billingInterval);
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

    if (!allowedPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({
        error:
          "Please choose one of the supported payment methods: Whish, OMT Wallet, BOB Finance, or Bank Audi Neo.",
      });
    }

    if (!proofDataUrl) {
      return res.status(400).json({
        error: "Please attach a transaction screenshot before submitting your request.",
      });
    }

    const shop = await ensureShop(clientId);
    const currentPlan = await getPlanForShop(shop.id);
    const requestedPlan = await getPlanByName(requestedPlanName);

    if (!requestedPlan || !requestedPlan.is_active) {
      return res.status(404).json({ error: "Requested plan was not found." });
    }

    const requestedPlanPriceCents =
      billingInterval === "yearly"
        ? Number(requestedPlan.yearly_price_cents || 0)
        : Number(requestedPlan.price_cents || 0);

    if (requestedPlanPriceCents <= 0) {
      return res.status(400).json({
        error: "Only paid plans can be requested through manual approval.",
      });
    }

    if (
      currentPlan.name === requestedPlan.name &&
      normalizeBillingInterval(currentPlan.billing_interval) === billingInterval &&
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
      billingInterval,
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
      billingInterval,
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
    const [summary, requests, plans] = await Promise.all([
      getAdminSummary(),
      listPlanRequests("pending"),
      listPlans(),
    ]);

    return res.json({
      summary,
      pendingRequests: requests,
      plans,
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

app.get("/admin/api/subscriptions", async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }

  try {
    const subscriptions = await listAdminSubscriptions();
    return res.json({ subscriptions });
  } catch (error) {
    console.error("Failed to load subscriptions:", error);
    return res.status(500).json({
      error: error?.message || "Failed to load subscriptions.",
    });
  }
});

app.get("/admin/api/catalog-jobs", async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }

  try {
    const jobs = await listAdminCatalogJobs();
    return res.json({ jobs });
  } catch (error) {
    console.error("Failed to load admin catalog jobs:", error);
    return res.status(500).json({
      error: error?.message || "Failed to load catalog jobs.",
    });
  }
});

app.post("/admin/api/subscriptions/:shopId/override", async (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }

  try {
    const shopId = Number(req.params.shopId);
    const planName = sanitizeText(req.body?.planName, 80).toLowerCase();
    const billingInterval = normalizeBillingInterval(req.body?.billingInterval);

    if (!Number.isInteger(shopId) || shopId <= 0) {
      return res.status(400).json({ error: "Invalid shop id." });
    }

    if (!planName) {
      return res.status(400).json({ error: "Plan name is required." });
    }

    const subscription = await overrideSubscriptionForShop({
      shopId,
      planName,
      billingInterval,
    });

    return res.json({
      message: "Subscription updated successfully.",
      subscription,
    });
  } catch (error) {
    console.error("Failed to override subscription:", error);
    return res.status(500).json({
      error: error?.message || "Failed to override the subscription.",
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

function sanitizeImageDataUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (!trimmed.startsWith("data:image/")) {
    throw new Error("Uploaded product images must be image files.");
  }

  if (trimmed.length > maxImageAssetDataUrlLength) {
    throw new Error("One of the uploaded images is too large.");
  }

  return trimmed;
}

function sanitizeImageDataUrls(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item, index) => {
      const dataUrl = sanitizeImageDataUrl(item?.dataUrl);

      if (!dataUrl) {
        return null;
      }

      const mimeType = dataUrl.slice(5, dataUrl.indexOf(";")) || "image/png";
      const base64 = dataUrl.split(",")[1] || "";
      const extension = mimeType.split("/")[1] || "png";

      return {
        dataUrl,
        base64,
        mimeType,
        extension,
        fileName: sanitizeText(item?.fileName, 120) || `uploaded-image-${index + 1}.${extension}`,
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function sanitizeImageStylePreset(value) {
  const supported = new Set([
    "clean-studio",
    "luxury-studio",
    "white-background",
    "soft-shadow",
    "social-ready",
  ]);
  const normalized = sanitizeText(value, 80).toLowerCase();
  return supported.has(normalized) ? normalized : "clean-studio";
}

function sanitizeImageOutputSize(value) {
  const supported = new Set(["1024x1024", "1536x1024", "1024x1536"]);
  const normalized = sanitizeText(value, 20);
  return supported.has(normalized) ? normalized : "1024x1024";
}

function sanitizeImageBackgroundStyle(value) {
  const supported = new Set(["white", "transparent", "soft-gray"]);
  const normalized = sanitizeText(value, 40).toLowerCase();
  return supported.has(normalized) ? normalized : "white";
}

function sanitizeImageCount(value) {
  const numeric = Number.parseInt(String(value ?? "1"), 10);
  if (!Number.isFinite(numeric)) {
    return 1;
  }

  return Math.min(4, Math.max(1, numeric));
}

function normalizeBillingInterval(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "yearly" ? "yearly" : "monthly";
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
    "Avoid filler, repetition, and vague claims.",
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
    `- Default language: ${profile.default_language || "English"}`,
    `- Brand guidelines: ${profile.brand_guidelines || "Keep it clean, polished, customer-facing, and specific to the product."}`,
    `- Preferred keywords: ${profile.preferred_keywords || "None provided"}`,
    `- Words to avoid: ${profile.banned_words || "None provided"}`,
    `- Example brand copy: ${profile.brand_example_copy || "None provided"}`,
    presetInstructions
      ? `Saved preset instructions: ${presetInstructions}`
      : "Saved preset instructions:\nNone provided.",
    existingDescription ? `Existing product copy to improve:\n${existingDescription}` : "Existing product copy to improve:\nNone provided.",
    "Create a full content package for this product including description, highlights, composition, SEO metadata, subtitle, and FAQ.",
  ].join("\n");
}

function buildImageEditPrompt({
  instructionText,
  stylePreset,
  backgroundStyle,
}) {
  const styleInstructions = {
    "clean-studio":
      "Create a clean ecommerce studio result with balanced lighting, natural color retention, and tidy composition.",
    "luxury-studio":
      "Create a premium luxury studio result with polished lighting, refined shadows, and elevated presentation.",
    "white-background":
      "Place the product on a pure white ecommerce-ready background with crisp edges and realistic form.",
    "soft-shadow":
      "Use a minimal commercial background with a soft natural shadow under the product.",
    "social-ready":
      "Create a scroll-stopping social-ready product visual while keeping the product faithful and sellable.",
  };

  const backgroundInstructions = {
    white: "Use a bright clean white background suitable for product pages.",
    transparent: "Return a transparent background if possible.",
    "soft-gray": "Use a subtle soft-gray studio background.",
  };

  return [
    "Edit the uploaded product reference images for ecommerce website use.",
    styleInstructions[stylePreset] || styleInstructions["clean-studio"],
    backgroundInstructions[backgroundStyle] || backgroundInstructions.white,
    "Keep the product shape, materials, branding, and core appearance faithful to the original item.",
    "Do not add unrelated props, text overlays, watermarks, or extra products.",
    "The result should feel conversion-ready, polished, and suitable for a Shopify storefront.",
    instructionText ? `Additional merchant instructions: ${instructionText}` : "",
  ].join(" ");
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

async function getImageUsageForShop(shopId) {
  const period = getCurrentUsagePeriod();

  if (!pool || !shopId) {
    return { count: 0, period };
  }

  const result = await pool.query(
    `
      SELECT COUNT(*) AS count
      FROM usage_events
      WHERE shop_id = $1
        AND usage_period = $2
        AND event_type = 'image_generation'
    `,
    [shopId, period],
  );

  return {
    count: Number(result.rows[0]?.count || 0),
    period,
  };
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
          monthly_image_limit INTEGER NOT NULL DEFAULT 0,
          price_cents INTEGER NOT NULL DEFAULT 0,
          yearly_price_cents INTEGER NOT NULL DEFAULT 0,
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
          billing_interval TEXT NOT NULL DEFAULT 'monthly',
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
          billing_interval TEXT NOT NULL DEFAULT 'monthly',
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
    {
      version: "008_subscription_expiry",
      sql: `
        UPDATE subscriptions
        SET
          current_period_end = current_period_start + INTERVAL '1 month',
          updated_at = NOW()
        FROM plans
        WHERE plans.id = subscriptions.plan_id
          AND plans.price_cents > 0
          AND subscriptions.current_period_end IS NULL
      `,
    },
    {
      version: "009_yearly_billing",
      sql: `
        ALTER TABLE plans
        ADD COLUMN IF NOT EXISTS yearly_price_cents INTEGER NOT NULL DEFAULT 0;

        ALTER TABLE subscriptions
        ADD COLUMN IF NOT EXISTS billing_interval TEXT NOT NULL DEFAULT 'monthly';

        ALTER TABLE plan_requests
        ADD COLUMN IF NOT EXISTS billing_interval TEXT NOT NULL DEFAULT 'monthly';
      `,
    },
    {
      version: "010_enhanced_profiles_jobs",
      sql: `
        ALTER TABLE shop_profiles
        ADD COLUMN IF NOT EXISTS default_language TEXT NOT NULL DEFAULT 'English';

        ALTER TABLE shop_profiles
        ADD COLUMN IF NOT EXISTS banned_words TEXT NOT NULL DEFAULT '';

        ALTER TABLE shop_profiles
        ADD COLUMN IF NOT EXISTS preferred_keywords TEXT NOT NULL DEFAULT '';

        ALTER TABLE shop_profiles
        ADD COLUMN IF NOT EXISTS brand_example_copy TEXT NOT NULL DEFAULT '';

        CREATE TABLE IF NOT EXISTS catalog_jobs (
          id SERIAL PRIMARY KEY,
          shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          job_type TEXT NOT NULL DEFAULT 'bulk_apply',
          status TEXT NOT NULL DEFAULT 'completed',
          mode TEXT NOT NULL DEFAULT 'conversion',
          language TEXT NOT NULL DEFAULT 'English',
          scope_summary TEXT NOT NULL DEFAULT '',
          total_products INTEGER NOT NULL DEFAULT 0,
          processed_products INTEGER NOT NULL DEFAULT 0,
          failed_products INTEGER NOT NULL DEFAULT 0,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          last_error TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    },
    {
      version: "011_catalog_job_progress",
      sql: `
        ALTER TABLE catalog_jobs
        ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

        ALTER TABLE catalog_jobs
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

        ALTER TABLE catalog_jobs
        ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT '';
      `,
    },
    {
      version: "012_image_jobs",
      sql: `
        CREATE TABLE IF NOT EXISTS image_jobs (
          id SERIAL PRIMARY KEY,
          shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'completed',
          instruction_text TEXT NOT NULL DEFAULT '',
          style_preset TEXT NOT NULL DEFAULT 'clean-studio',
          output_size TEXT NOT NULL DEFAULT '1024x1024',
          background_style TEXT NOT NULL DEFAULT 'white',
          source_image_count INTEGER NOT NULL DEFAULT 0,
          output_images_json TEXT NOT NULL DEFAULT '[]',
          last_error TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
    },
    {
      version: "013_image_credits",
      sql: `
        ALTER TABLE plans
        ADD COLUMN IF NOT EXISTS monthly_image_limit INTEGER NOT NULL DEFAULT 0
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
      SELECT id, name, description, monthly_generation_limit, monthly_image_limit, price_cents, yearly_price_cents, is_active
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
      SELECT id, name, description, monthly_generation_limit, monthly_image_limit, price_cents, yearly_price_cents, is_active
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
    INSERT INTO plans (name, description, monthly_generation_limit, monthly_image_limit, price_cents, yearly_price_cents)
    VALUES
      (
        'free',
        '5 generations per month for trying the app. Includes single-product generation only. Bulk tools and saved presets are not included.',
        5,
        0,
        0,
        0
      ),
      (
        'starter',
        '300 generations per month for steady single-product work. Best for small catalogs that do not need bulk generation or saved presets yet.',
        300,
        0,
        900,
        9000
      ),
      (
        'growth',
        '1,000 generations per month, 20 image credits, bulk generation, saved presets, audit filters, previews, and multilingual workflows.',
        1000,
        20,
        3900,
        39000
      ),
      (
        'scale',
        '3,000 generations per month, 75 image credits, and full access to bulk workflows, saved presets, multilingual generation, image generation, and advanced catalog optimization.',
        3000,
        75,
        7900,
        79000
      )
    ON CONFLICT (name) DO UPDATE SET
      description = EXCLUDED.description,
      monthly_generation_limit = EXCLUDED.monthly_generation_limit,
      monthly_image_limit = EXCLUDED.monthly_image_limit,
      price_cents = EXCLUDED.price_cents,
      yearly_price_cents = EXCLUDED.yearly_price_cents,
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

  const planId = await getPlanIdByName(freePlanName);

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

  await reconcileSubscriptionForShop(shopId);

  const result = await pool.query(
    `
      SELECT
        plans.id,
        plans.name,
        plans.description,
        plans.monthly_generation_limit,
        plans.price_cents,
        plans.yearly_price_cents,
        plans.is_active,
        subscriptions.status,
        subscriptions.billing_interval,
        subscriptions.current_period_start,
        subscriptions.current_period_end
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

async function getPlanIdByName(planName) {
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT id
      FROM plans
      WHERE name = $1
      LIMIT 1
    `,
    [planName],
  );

  return result.rows[0]?.id || null;
}

async function reconcileSubscriptionForShop(shopId) {
  if (!pool) {
    return;
  }

  const subscriptionResult = await pool.query(
    `
      SELECT
        subscriptions.id,
        subscriptions.shop_id,
        subscriptions.plan_id,
        subscriptions.billing_interval,
        subscriptions.current_period_end,
        plans.price_cents
      FROM subscriptions
      JOIN plans ON plans.id = subscriptions.plan_id
      WHERE subscriptions.shop_id = $1
      LIMIT 1
    `,
    [shopId],
  );

  const subscription = subscriptionResult.rows[0];

  if (!subscription) {
    return;
  }

  const isPaidPlan = Number(subscription.price_cents || 0) > 0;
  const hasEnded =
    subscription.current_period_end &&
    new Date(subscription.current_period_end).getTime() <= Date.now();

  if (!isPaidPlan || !hasEnded) {
    return;
  }

  const freePlanId = await getPlanIdByName(freePlanName);

  if (!freePlanId) {
    throw new Error(`Default plan "${freePlanName}" was not found.`);
  }

  await pool.query(
    `
      UPDATE subscriptions
      SET
        plan_id = $2,
        status = 'active',
        billing_interval = 'monthly',
        current_period_start = NOW(),
        current_period_end = NULL,
        updated_at = NOW()
      WHERE shop_id = $1
    `,
    [shopId, freePlanId],
  );
}

async function reconcileExpiredSubscriptions() {
  if (!pool) {
    return;
  }

  const freePlanId = await getPlanIdByName(freePlanName);

  if (!freePlanId) {
    throw new Error(`Default plan "${freePlanName}" was not found.`);
  }

  await pool.query(
    `
      UPDATE subscriptions
      SET
        plan_id = $1,
        status = 'active',
        billing_interval = 'monthly',
        current_period_start = NOW(),
        current_period_end = NULL,
        updated_at = NOW()
      FROM plans
      WHERE plans.id = subscriptions.plan_id
        AND plans.price_cents > 0
        AND subscriptions.current_period_end IS NOT NULL
        AND subscriptions.current_period_end <= NOW()
    `,
    [freePlanId],
  );
}

function buildFallbackFreePlan() {
  return {
    id: 0,
    name: freePlanName,
    description:
      "5 generations per month for trying the app. Includes single-product generation only. Bulk tools and saved presets are not included.",
    monthly_generation_limit: monthlyGenerationLimit,
    monthly_image_limit: 0,
    price_cents: 0,
    yearly_price_cents: 0,
    billing_interval: "monthly",
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
      imageGenerationEnabled: true,
    };
  }

  return {
    presetsEnabled: false,
    bulkGenerationEnabled: false,
    multilingualEnabled: false,
    advancedModesEnabled: false,
    imageGenerationEnabled: false,
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
      "20 image generations per month",
      "Bulk generation and preview",
      "Saved presets",
      "Multilingual generation",
      "Advanced generation modes",
      "Product image generation",
    ];
  }

  if (normalized === "scale") {
    return [
      "3,000 generations per month",
      "75 image generations per month",
      "Bulk generation and preview",
      "Saved presets",
      "Multilingual generation",
      "Advanced generation modes",
      "Product image generation",
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
        plan_requests.billing_interval,
        plan_requests.created_at,
        plan_requests.updated_at,
        requested_plans.name AS requested_plan_name,
        requested_plans.description AS requested_plan_description,
        requested_plans.price_cents AS requested_plan_price_cents,
        requested_plans.yearly_price_cents AS requested_plan_yearly_price_cents
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
    default_language: "English",
    banned_words: "",
    preferred_keywords: "",
    brand_example_copy: "",
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
        brand_guidelines,
        default_language,
        banned_words,
        preferred_keywords,
        brand_example_copy
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
      brand_guidelines,
      default_language,
      banned_words,
      preferred_keywords,
      brand_example_copy
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (shop_id)
    DO UPDATE SET
      business_type = EXCLUDED.business_type,
      brand_tone = EXCLUDED.brand_tone,
      target_audience = EXCLUDED.target_audience,
      description_style = EXCLUDED.description_style,
      brand_guidelines = EXCLUDED.brand_guidelines,
      default_language = EXCLUDED.default_language,
      banned_words = EXCLUDED.banned_words,
      preferred_keywords = EXCLUDED.preferred_keywords,
      brand_example_copy = EXCLUDED.brand_example_copy,
      updated_at = NOW()
    RETURNING
      business_type,
      brand_tone,
      target_audience,
      description_style,
      brand_guidelines,
      default_language,
      banned_words,
      preferred_keywords,
      brand_example_copy
  `,
    [
      shopId,
      profile.businessType || "",
      profile.brandTone || "",
      profile.targetAudience || "",
      profile.descriptionStyle || "",
      profile.brandGuidelines || "",
      profile.defaultLanguage || "English",
      profile.bannedWords || "",
      profile.preferredKeywords || "",
      profile.brandExampleCopy || "",
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

async function getPendingPlanRequestForShop(shopId, requestedPlanId, billingInterval) {
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT id
      FROM plan_requests
      WHERE shop_id = $1
        AND requested_plan_id = $2
        AND billing_interval = $3
        AND status = 'pending'
      LIMIT 1
    `,
    [shopId, requestedPlanId, normalizeBillingInterval(billingInterval)],
  );

  return result.rows[0] || null;
}

async function createPlanRequest({
  shopId,
  currentPlanId,
  requestedPlanId,
  billingInterval,
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
        billing_interval,
        contact_name,
        contact_channel,
        payment_method,
        payment_reference,
        customer_notes,
        proof_file_name,
        proof_mime_type,
        proof_data_url
      )
      VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, status, created_at
    `,
    [
      shopId,
      currentPlanId,
      requestedPlanId,
      normalizeBillingInterval(billingInterval),
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

async function createCatalogJob({
  shopId,
  jobType,
  status,
  mode,
  language,
  scopeSummary,
  totalProducts,
  processedProducts,
  failedProducts,
  lastError,
}) {
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      INSERT INTO catalog_jobs (
        shop_id,
        job_type,
        status,
        mode,
        language,
        scope_summary,
        total_products,
        processed_products,
        failed_products,
        started_at,
        completed_at,
        last_error
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        CASE WHEN $3 IN ('running', 'completed', 'completed_with_issues', 'failed') THEN NOW() ELSE NULL END,
        CASE WHEN $3 IN ('completed', 'completed_with_issues', 'failed') THEN NOW() ELSE NULL END,
        $10
      )
      RETURNING id, job_type, status, mode, language, scope_summary, total_products, processed_products, failed_products, started_at, completed_at, last_error, created_at, updated_at
    `,
    [
      shopId,
      jobType,
      status,
      mode,
      language,
      scopeSummary || "",
      Math.max(0, Number(totalProducts || 0)),
      Math.max(0, Number(processedProducts || 0)),
      Math.max(0, Number(failedProducts || 0)),
      lastError || "",
    ],
  );

  return result.rows[0] || null;
}

async function updateCatalogJob({
  shopId,
  jobId,
  status,
  processedProducts,
  failedProducts,
  lastError,
}) {
  if (!pool) {
    return null;
  }

  const normalizedStatus = sanitizeText(status, 80) || "running";
  const result = await pool.query(
    `
      UPDATE catalog_jobs
      SET
        status = $3,
        processed_products = $4,
        failed_products = $5,
        started_at = COALESCE(started_at, NOW()),
        completed_at = CASE
          WHEN $3 IN ('completed', 'completed_with_issues', 'failed') THEN NOW()
          ELSE completed_at
        END,
        last_error = $6,
        updated_at = NOW()
      WHERE id = $1
        AND shop_id = $2
      RETURNING id, job_type, status, mode, language, scope_summary, total_products, processed_products, failed_products, started_at, completed_at, last_error, created_at, updated_at
    `,
    [
      jobId,
      shopId,
      normalizedStatus,
      Math.max(0, Number(processedProducts || 0)),
      Math.max(0, Number(failedProducts || 0)),
      lastError || "",
    ],
  );

  if (!result.rows[0]) {
    throw new Error("Catalog job not found.");
  }

  return result.rows[0];
}

async function listCatalogJobsForShop(shopId) {
  if (!pool) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT
        id,
        job_type,
        status,
        mode,
        language,
        scope_summary,
        total_products,
        processed_products,
        failed_products,
        started_at,
        completed_at,
        last_error,
        created_at,
        updated_at
      FROM catalog_jobs
      WHERE shop_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `,
    [shopId],
  );

  return result.rows;
}

async function createImageJob({
  shopId,
  status,
  instructionText,
  stylePreset,
  outputSize,
  backgroundStyle,
  sourceImageCount,
  outputImages,
  lastError,
}) {
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      INSERT INTO image_jobs (
        shop_id,
        status,
        instruction_text,
        style_preset,
        output_size,
        background_style,
        source_image_count,
        output_images_json,
        last_error
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, status, instruction_text, style_preset, output_size, background_style, source_image_count, output_images_json, last_error, created_at, updated_at
    `,
    [
      shopId,
      status || "completed",
      instructionText || "",
      stylePreset || "clean-studio",
      outputSize || "1024x1024",
      backgroundStyle || "white",
      Math.max(0, Number(sourceImageCount || 0)),
      JSON.stringify(outputImages || []),
      lastError || "",
    ],
  );

  return parseImageJobRow(result.rows[0]);
}

async function listImageJobsForShop(shopId) {
  if (!pool) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT
        id,
        status,
        instruction_text,
        style_preset,
        output_size,
        background_style,
        source_image_count,
        output_images_json,
        last_error,
        created_at,
        updated_at
      FROM image_jobs
      WHERE shop_id = $1
      ORDER BY created_at DESC
      LIMIT 12
    `,
    [shopId],
  );

  return result.rows.map((row) => parseImageJobRow(row));
}

function parseImageJobRow(row) {
  if (!row) {
    return null;
  }

  let outputImages = [];

  try {
    outputImages = JSON.parse(row.output_images_json || "[]");
  } catch (_error) {
    outputImages = [];
  }

  return {
    ...row,
    output_images: Array.isArray(outputImages) ? outputImages : [],
  };
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

async function recordImageUsageEvent(shopId, usagePeriod, productTitle) {
  if (!pool || !shopId) {
    return;
  }

  await pool.query(
    `
      INSERT INTO usage_events (shop_id, usage_period, event_type, product_title)
      VALUES ($1, $2, 'image_generation', $3)
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
        plan_requests.billing_interval,
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
        requested_plans.price_cents AS requested_plan_price_cents,
        requested_plans.yearly_price_cents AS requested_plan_yearly_price_cents
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
          plan_requests.billing_interval,
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

    const requestedPlanResult = await client.query(
      `
        SELECT price_cents, yearly_price_cents
        FROM plans
        WHERE id = $1
        LIMIT 1
      `,
      [requestRow.requested_plan_id],
    );

    const requestedPlan = requestedPlanResult.rows[0];

    if (!requestedPlan) {
      throw new Error("Requested plan not found.");
    }

    await client.query(
      `
        INSERT INTO subscriptions (
          shop_id,
          plan_id,
          status,
          billing_interval,
          current_period_start,
          current_period_end,
          updated_at
        )
        VALUES (
          $1,
          $2,
          'active',
          $3,
          NOW(),
          CASE
            WHEN $4 > 0 AND $3 = 'yearly' THEN NOW() + INTERVAL '1 year'
            WHEN $4 > 0 THEN NOW() + INTERVAL '1 month'
            ELSE NULL
          END,
          NOW()
        )
        ON CONFLICT (shop_id)
        DO UPDATE SET
          plan_id = EXCLUDED.plan_id,
          status = 'active',
          billing_interval = EXCLUDED.billing_interval,
          current_period_start = NOW(),
          current_period_end = EXCLUDED.current_period_end,
          updated_at = NOW()
      `,
      [
        requestRow.shop_id,
        requestRow.requested_plan_id,
        normalizeBillingInterval(requestRow.billing_interval),
        normalizeBillingInterval(requestRow.billing_interval) === "yearly"
          ? Number(requestedPlan.yearly_price_cents || 0)
          : Number(requestedPlan.price_cents || 0),
      ],
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

  await reconcileExpiredSubscriptions();

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

async function listAdminSubscriptions() {
  if (!pool) {
    return [];
  }

  await reconcileExpiredSubscriptions();

  const result = await pool.query(
    `
      SELECT
        subscriptions.id,
        subscriptions.status,
        subscriptions.billing_interval,
        subscriptions.current_period_start,
        subscriptions.current_period_end,
        subscriptions.updated_at,
        shops.id AS shop_id,
        shops.client_id,
        shops.display_name,
        plans.name AS plan_name,
        plans.description AS plan_description,
        plans.price_cents,
        plans.yearly_price_cents,
        plans.monthly_generation_limit,
        latest_requests.contact_name AS latest_contact_name,
        latest_requests.contact_channel AS latest_contact_channel,
        latest_requests.payment_method AS latest_payment_method,
        latest_requests.payment_reference AS latest_payment_reference
      FROM subscriptions
      JOIN shops ON shops.id = subscriptions.shop_id
      JOIN plans ON plans.id = subscriptions.plan_id
      LEFT JOIN LATERAL (
        SELECT
          plan_requests.contact_name,
          plan_requests.contact_channel,
          plan_requests.payment_method,
          plan_requests.payment_reference
        FROM plan_requests
        WHERE plan_requests.shop_id = shops.id
        ORDER BY plan_requests.created_at DESC
        LIMIT 1
      ) AS latest_requests ON TRUE
      ORDER BY
        CASE WHEN plans.price_cents > 0 THEN 0 ELSE 1 END,
        subscriptions.current_period_end NULLS LAST,
        shops.display_name ASC
    `,
  );

  return result.rows;
}

async function listAdminCatalogJobs() {
  if (!pool) {
    return [];
  }

  await reconcileExpiredSubscriptions();

  const result = await pool.query(
    `
      SELECT
        catalog_jobs.id,
        catalog_jobs.job_type,
        catalog_jobs.status,
        catalog_jobs.mode,
        catalog_jobs.language,
        catalog_jobs.scope_summary,
        catalog_jobs.total_products,
        catalog_jobs.processed_products,
        catalog_jobs.failed_products,
        catalog_jobs.started_at,
        catalog_jobs.completed_at,
        catalog_jobs.last_error,
        catalog_jobs.created_at,
        shops.client_id,
        shops.display_name
      FROM catalog_jobs
      JOIN shops ON shops.id = catalog_jobs.shop_id
      ORDER BY catalog_jobs.created_at DESC
      LIMIT 20
    `,
  );

  return result.rows;
}

async function overrideSubscriptionForShop({ shopId, planName, billingInterval }) {
  if (!pool) {
    throw new Error("Admin override requires a database connection.");
  }

  const plan = await getPlanByName(planName);

  if (!plan || !plan.is_active) {
    throw new Error("Requested override plan was not found.");
  }

  const normalizedInterval = normalizeBillingInterval(billingInterval);
  const paidAmount =
    normalizedInterval === "yearly"
      ? Number(plan.yearly_price_cents || 0)
      : Number(plan.price_cents || 0);

  await pool.query(
    `
      INSERT INTO subscriptions (
        shop_id,
        plan_id,
        status,
        billing_interval,
        current_period_start,
        current_period_end,
        updated_at
      )
      VALUES (
        $1,
        $2,
        'active',
        $3,
        NOW(),
        CASE
          WHEN $4 > 0 AND $3 = 'yearly' THEN NOW() + INTERVAL '1 year'
          WHEN $4 > 0 THEN NOW() + INTERVAL '1 month'
          ELSE NULL
        END,
        NOW()
      )
      ON CONFLICT (shop_id)
      DO UPDATE SET
        plan_id = EXCLUDED.plan_id,
        status = 'active',
        billing_interval = EXCLUDED.billing_interval,
        current_period_start = NOW(),
        current_period_end = EXCLUDED.current_period_end,
        updated_at = NOW()
    `,
    [shopId, plan.id, normalizedInterval, paidAmount],
  );

  const subscriptions = await listAdminSubscriptions();
  return subscriptions.find((subscription) => subscription.shop_id === shopId) || null;
}
