import { useMemo } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const backend = getBackendConfig();
  const clientId = toClientId(session.shop);

  if (!backend.baseUrl) {
    return {
      backendConfigured: false,
      shopDomain: session.shop,
      clientId,
      shopStatus: null,
      plans: [],
      paymentInstructions: "",
      supportContact: "",
    };
  }

  try {
    const [shopStatus, plansPayload] = await Promise.all([
      backendRequest({
        backend,
        pathname: "/shop-status",
        method: "GET",
        clientId,
      }),
      backendRequest({
        backend,
        pathname: "/plans",
        method: "GET",
      }),
    ]);

    return {
      backendConfigured: true,
      shopDomain: session.shop,
      clientId,
      shopStatus,
      plans: plansPayload.plans || [],
      paymentInstructions: plansPayload.paymentInstructions || "",
      supportContact: plansPayload.supportContact || "",
    };
  } catch (error) {
    return {
      backendConfigured: false,
      backendError: error.message,
      shopDomain: session.shop,
      clientId,
      shopStatus: null,
      plans: [],
      paymentInstructions: "",
      supportContact: "",
    };
  }
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const backend = getBackendConfig();
  const clientId = toClientId(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (!backend.baseUrl) {
    return {
      ok: false,
      intent,
      message:
        "BACKEND_API_URL is not set in the Shopify app environment yet.",
    };
  }

  try {
    if (intent === "generate") {
      const title = String(formData.get("title") || "").trim();

      if (!title) {
        return {
          ok: false,
          intent,
          message: "Enter a product title first.",
        };
      }

      const result = await backendRequest({
        backend,
        pathname: "/generate-product-content",
        method: "POST",
        body: { title, clientId },
      });

      return {
        ok: true,
        intent,
        message: "Description generated successfully.",
        generated: result,
      };
    }

    if (intent === "save-profile") {
      const businessType = String(formData.get("businessType") || "").trim();
      const brandTone = String(formData.get("brandTone") || "").trim();
      const targetAudience = String(formData.get("targetAudience") || "").trim();
      const descriptionStyle = String(
        formData.get("descriptionStyle") || "",
      ).trim();
      const brandGuidelines = String(
        formData.get("brandGuidelines") || "",
      ).trim();

      const result = await backendRequest({
        backend,
        pathname: "/shop-profile",
        method: "POST",
        body: {
          clientId,
          businessType,
          brandTone,
          targetAudience,
          descriptionStyle,
          brandGuidelines,
        },
      });

      return {
        ok: true,
        intent,
        message: result.message || "Shop profile saved successfully.",
      };
    }

    if (intent === "request-plan") {
      const requestedPlanName = String(formData.get("requestedPlanName") || "")
        .trim()
        .toLowerCase();
      const contactName = String(formData.get("contactName") || "").trim();
      const contactChannel = String(formData.get("contactChannel") || "").trim();
      const paymentMethod = String(formData.get("paymentMethod") || "").trim();
      const paymentReference = String(
        formData.get("paymentReference") || "",
      ).trim();
      const notes = String(formData.get("notes") || "").trim();

      const result = await backendRequest({
        backend,
        pathname: "/plan-requests",
        method: "POST",
        body: {
          clientId,
          requestedPlanName,
          contactName,
          contactChannel,
          paymentMethod,
          paymentReference,
          notes,
        },
      });

      return {
        ok: true,
        intent,
        message: result.message || "Upgrade request submitted successfully.",
      };
    }

    return {
      ok: false,
      intent,
      message: "Unknown app action.",
    };
  } catch (error) {
    return {
      ok: false,
      intent,
      message: error.message || "Action failed.",
    };
  }
};

export default function AppIndex() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isSubmitting = navigation.state === "submitting";
  const profile = data.shopStatus?.profile || emptyProfile;
  const needsProfile =
    !profile.business_type ||
    !profile.brand_tone ||
    !profile.target_audience ||
    !profile.description_style;

  const paidPlans = useMemo(
    () => (data.plans || []).filter((plan) => plan.isPaid),
    [data.plans],
  );
  const currentPlanName = data.shopStatus?.plan?.name || "";
  const defaultRequestedPlanName =
    paidPlans.find((plan) => plan.name !== currentPlanName)?.name ||
    paidPlans[0]?.name ||
    "";

  const generated = actionData?.intent === "generate" ? actionData.generated : null;

  return (
    <s-page heading="AI Product Generator">
      <s-button
        slot="primary-action"
        variant="secondary"
        onClick={() => revalidator.revalidate()}
      >
        Refresh status
      </s-button>

      <s-section heading="Store status">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>Shop: </s-text>
            <strong>{data.shopDomain}</strong>
          </s-paragraph>
          <s-paragraph>
            <s-text>Current plan: </s-text>
            <strong>{data.shopStatus?.plan?.name || "Unavailable"}</strong>
          </s-paragraph>
          {data.shopStatus?.plan?.description && (
            <s-paragraph>{data.shopStatus.plan.description}</s-paragraph>
          )}
          <s-paragraph>
            {data.shopStatus
              ? `Used ${data.shopStatus.usage?.count || 0} of ${data.shopStatus.plan?.monthly_generation_limit || 0} generations this month.`
              : data.backendError || "Backend is not connected yet."}
          </s-paragraph>
          {data.shopStatus?.latestRequest && (
            <s-paragraph>
              Latest request: {data.shopStatus.latestRequest.requested_plan_name} (
              {data.shopStatus.latestRequest.status})
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Generate description">
        <Form method="post" action="?index">
          <input type="hidden" name="intent" value="generate" />
          <s-stack direction="block" gap="base">
            {needsProfile && (
              <div style={getNoticeStyle(false)}>
                Save your business profile below first so the AI can match your
                store's style.
              </div>
            )}
            <label htmlFor="title">Product title</label>
            <input
              id="title"
              name="title"
              type="text"
              placeholder="Adidas Samba OG"
              style={inputStyle}
            />
            <s-button
              type="submit"
              disabled={needsProfile}
              {...(isSubmitting ? { loading: true } : {})}
            >
              Generate content
            </s-button>
          </s-stack>
        </Form>

        {actionData?.message && actionData.intent === "generate" && (
          <div style={getNoticeStyle(actionData.ok)}>{actionData.message}</div>
        )}

        {generated && (
          <s-stack direction="block" gap="base">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <strong>Description</strong>
              <p style={paragraphStyle}>{generated.description}</p>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <strong>Highlights</strong>
              <ul style={listStyle}>
                {generated.highlights?.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <strong>Composition</strong>
              <ul style={listStyle}>
                {generated.composition?.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </s-box>
          </s-stack>
        )}
      </s-section>

      <s-section
        heading={needsProfile ? "Business onboarding" : "Business profile"}
      >
        <Form method="post" action="?index">
          <input type="hidden" name="intent" value="save-profile" />
          <s-stack direction="block" gap="base">
            <label htmlFor="businessType">Business type</label>
            <input
              id="businessType"
              name="businessType"
              type="text"
              placeholder="Footwear, fashion, skincare, home decor..."
              defaultValue={profile.business_type || ""}
              style={inputStyle}
            />

            <label htmlFor="brandTone">Brand tone</label>
            <input
              id="brandTone"
              name="brandTone"
              type="text"
              placeholder="Premium, sporty, playful, technical..."
              defaultValue={profile.brand_tone || ""}
              style={inputStyle}
            />

            <label htmlFor="targetAudience">Target audience</label>
            <input
              id="targetAudience"
              name="targetAudience"
              type="text"
              placeholder="Women, men, athletes, parents, professionals..."
              defaultValue={profile.target_audience || ""}
              style={inputStyle}
            />

            <label htmlFor="descriptionStyle">Description style</label>
            <input
              id="descriptionStyle"
              name="descriptionStyle"
              type="text"
              placeholder="Benefits-first, premium short copy, detailed..."
              defaultValue={profile.description_style || ""}
              style={inputStyle}
            />

            <label htmlFor="brandGuidelines">Brand guidelines</label>
            <textarea
              id="brandGuidelines"
              name="brandGuidelines"
              rows="5"
              placeholder="Example: Write in a polished premium tone. Focus on comfort, materials, and lifestyle. Avoid slang and exaggerated claims."
              defaultValue={profile.brand_guidelines || ""}
              style={inputStyle}
            />

            <s-button type="submit" variant="secondary">
              Save business profile
            </s-button>
          </s-stack>
        </Form>

        {actionData?.message && actionData.intent === "save-profile" && (
          <div style={getNoticeStyle(actionData.ok)}>{actionData.message}</div>
        )}
      </s-section>

      <s-section heading="Request a paid plan">
        <Form method="post" action="?index">
          <input type="hidden" name="intent" value="request-plan" />
          <s-stack direction="block" gap="base">
            <label>Choose plan</label>
            {paidPlans.length ? (
              <div style={planGridStyle}>
                {paidPlans.map((plan) => {
                  const isCurrentPlan = plan.name === currentPlanName;
                  return (
                    <label key={plan.id} style={planCardStyle}>
                      <input
                        type="radio"
                        name="requestedPlanName"
                        value={plan.name}
                        defaultChecked={plan.name === defaultRequestedPlanName}
                      />
                      <div style={planCardContentStyle}>
                        <div style={planCardHeaderStyle}>
                          <strong style={planNameStyle}>{capitalizePlanName(plan.name)}</strong>
                          <strong>${(plan.price_cents / 100).toFixed(2)} / month</strong>
                        </div>
                        <p style={planDescriptionStyle}>
                          {plan.description ||
                            "Monthly access to AI product generation for your store."}
                        </p>
                        <p style={planMetaStyle}>
                          {plan.monthly_generation_limit.toLocaleString()} generations per month
                        </p>
                        {isCurrentPlan && (
                          <p style={planCurrentBadgeStyle}>Current plan</p>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div style={getNoticeStyle(false)}>No paid plans available right now.</div>
            )}

            <label htmlFor="contactName">Your name</label>
            <input
              id="contactName"
              name="contactName"
              type="text"
              placeholder="Optional name"
              style={inputStyle}
            />

            <label htmlFor="contactChannel">WhatsApp / Email / Phone</label>
            <input
              id="contactChannel"
              name="contactChannel"
              type="text"
              placeholder="Required contact info"
              style={inputStyle}
            />

            <label htmlFor="paymentMethod">Payment method</label>
            <input
              id="paymentMethod"
              name="paymentMethod"
              type="text"
              placeholder="OMT, bank transfer, cash, Whish..."
              style={inputStyle}
            />

            <label htmlFor="paymentReference">Payment reference</label>
            <input
              id="paymentReference"
              name="paymentReference"
              type="text"
              placeholder="Transaction id or note"
              style={inputStyle}
            />

            <label htmlFor="notes">Notes</label>
            <textarea
              id="notes"
              name="notes"
              rows="4"
              placeholder="Any extra context for the request"
              style={inputStyle}
            />

            <s-button type="submit" variant="secondary">
              Submit upgrade request
            </s-button>
          </s-stack>
        </Form>

        {actionData?.message && actionData.intent === "request-plan" && (
          <div style={getNoticeStyle(actionData.ok)}>{actionData.message}</div>
        )}
      </s-section>

      <s-section slot="aside" heading="Manual billing">
        <s-paragraph>
          {data.paymentInstructions ||
            "Add PAYMENT_INSTRUCTIONS in your Shopify app environment to show local payment guidance here."}
        </s-paragraph>
        {data.supportContact && (
          <s-paragraph>
            <strong>Contact:</strong> {data.supportContact}
          </s-paragraph>
        )}
        <s-paragraph>
          This embedded app now talks to your Railway backend and uses the store
          identity from Shopify, which is the path toward removing manual popup
          configuration entirely.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function getBackendConfig() {
  return {
    baseUrl: (process.env.BACKEND_API_URL || "").trim().replace(/\/$/, ""),
    extensionToken: (process.env.BACKEND_EXTENSION_TOKEN || "").trim(),
  };
}

function toClientId(shopDomain) {
  const handle = String(shopDomain || "")
    .trim()
    .toLowerCase()
    .replace(/\.myshopify\.com$/, "");

  return `shopify-store:${handle}`;
}

async function backendRequest({ backend, pathname, method, clientId, body }) {
  const url = new URL(pathname, backend.baseUrl);

  if (method === "GET" && clientId) {
    url.searchParams.set("clientId", clientId);
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(backend.extensionToken
        ? { "x-extension-token": backend.extensionToken }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Backend request failed.");
  }

  return data;
}

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: "8px",
  border: "1px solid #c9cccf",
  boxSizing: "border-box",
  font: "inherit",
};

const paragraphStyle = {
  margin: "10px 0 0",
  lineHeight: 1.5,
};

const listStyle = {
  margin: "10px 0 0",
  paddingLeft: "18px",
  lineHeight: 1.5,
};

const planGridStyle = {
  display: "grid",
  gap: "12px",
};

const planCardStyle = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: "12px",
  alignItems: "start",
  padding: "14px",
  borderRadius: "12px",
  border: "1px solid #d9dce1",
  background: "#ffffff",
  cursor: "pointer",
};

const planCardContentStyle = {
  display: "grid",
  gap: "6px",
};

const planCardHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  flexWrap: "wrap",
};

const planNameStyle = {
  textTransform: "capitalize",
};

const planDescriptionStyle = {
  margin: 0,
  color: "#4b5563",
  lineHeight: 1.5,
};

const planMetaStyle = {
  margin: 0,
  color: "#111827",
  fontWeight: 600,
};

const planCurrentBadgeStyle = {
  margin: 0,
  color: "#0f766e",
  fontWeight: 600,
};

function getNoticeStyle(isSuccess) {
  return {
    marginTop: "12px",
    padding: "12px 14px",
    borderRadius: "10px",
    border: `1px solid ${isSuccess ? "#98d8b0" : "#f1aeb5"}`,
    background: isSuccess ? "#edf9f0" : "#fff1f2",
    color: "#111827",
  };
}

const emptyProfile = {
  business_type: "",
  brand_tone: "",
  target_audience: "",
  description_style: "",
  brand_guidelines: "",
};

function capitalizePlanName(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
