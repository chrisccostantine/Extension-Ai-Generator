require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT) || 5000;
const monthlyGenerationLimit =
  Number(process.env.MONTHLY_GENERATION_LIMIT) || 100;
const freePlanName = process.env.DEFAULT_PLAN_NAME || "free";
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
const databaseUrl = process.env.DATABASE_URL || "";
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const usageByClientAndMonth = new Map();
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

      callback(
        isAllowed ? null : new Error("Origin not allowed by CORS"),
        isAllowed,
      );
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
    databaseEnabled: Boolean(pool),
    defaultPlanName: freePlanName,
  });
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

    return res.json({
      clientId,
      shop,
      plan,
      usage,
      remaining: Math.max(plan.monthly_generation_limit - usage.count, 0),
    });
  } catch (error) {
    console.error("Failed to fetch shop status:", error);
    return res.status(500).json({
      error: error?.message || "Failed to fetch shop status.",
    });
  }
});

app.post("/generate-product-content", async (req, res) => {
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const clientId = normalizeClientId(req.body?.clientId);

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
    const updatedUsage = await incrementUsage(shop.id, clientId);
    await recordUsageEvent(shop.id, updatedUsage.period, title);

    return res.json({
      description: parsedOutput.description,
      highlights: parsedOutput.highlights,
      composition: parsedOutput.composition,
      usage: {
        count: updatedUsage.count,
        limit: plan.monthly_generation_limit,
        period: updatedUsage.period,
      },
      plan: {
        id: plan.id,
        name: plan.name,
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
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      monthly_generation_limit INTEGER NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      client_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
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
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_usage (
      shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      usage_period TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (client_id, usage_period)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      usage_period TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'generation',
      product_title TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await seedPlans();
}

async function seedPlans() {
  if (!pool) {
    return;
  }

  await pool.query(`
    INSERT INTO plans (name, monthly_generation_limit, price_cents)
    VALUES
      ('free', 100, 0),
      ('pro', 1000, 1900),
      ('agency', 5000, 4900)
    ON CONFLICT (name) DO UPDATE SET
      monthly_generation_limit = EXCLUDED.monthly_generation_limit,
      price_cents = EXCLUDED.price_cents,
      updated_at = NOW()
  `);
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
    return {
      id: 0,
      name: freePlanName,
      monthly_generation_limit: monthlyGenerationLimit,
      price_cents: 0,
      is_active: true,
      status: "active",
    };
  }

  const result = await pool.query(
    `
      SELECT
        plans.id,
        plans.name,
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
    return result.rows[0];
  }

  return {
    id: 0,
    name: freePlanName,
    monthly_generation_limit: monthlyGenerationLimit,
    price_cents: 0,
    is_active: true,
    status: "active",
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
