/* global process */
import { useMemo } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const backend = getBackendConfig();
  const clientId = toClientId(session.shop);
  const audit = await getCatalogAudit(admin);

  if (!backend.baseUrl) {
    return {
      backendConfigured: false,
      shopDomain: session.shop,
      clientId,
      shopStatus: null,
      plans: [],
      paymentInstructions: "",
      supportContact: "",
      audit,
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
      audit,
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
      audit,
    };
  }
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
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

    if (intent === "bulk-generate-audit") {
      const selectedProductIds = formData
        .getAll("productIds")
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      const mode = String(formData.get("mode") || "").trim().toLowerCase();
      const language = String(formData.get("language") || "").trim();

      if (!selectedProductIds.length) {
        return {
          ok: false,
          intent,
          message: "Select at least one product from the audit list.",
        };
      }

      const products = await getProductsByIds(admin, selectedProductIds);
      let successCount = 0;
      const failedTitles = [];

      for (const product of products) {
        try {
          const generated = await backendRequest({
            backend,
            pathname: "/generate-product-content",
            method: "POST",
            body: {
              clientId,
              title: product.title,
              mode,
              language,
              existingDescription: stripHtml(product.descriptionHtml || ""),
            },
          });

          await updateShopifyProduct(admin, {
            productId: product.id,
            generated,
          });
          successCount += 1;
        } catch (_error) {
          failedTitles.push(product.title);
        }
      }

      return {
        ok: successCount > 0,
        intent,
        message:
          failedTitles.length === 0
            ? `Updated ${successCount} product${successCount === 1 ? "" : "s"} successfully.`
            : `Updated ${successCount} product${successCount === 1 ? "" : "s"}. Failed: ${failedTitles.join(", ")}.`,
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
  const revalidator = useRevalidator();
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
  const auditItems = data.audit?.items || [];

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

      <s-section heading="Catalog audit">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {data.audit
              ? `${data.audit.flaggedCount} of ${data.audit.totalCount} recent products need content improvements.`
              : "Audit data is not available right now."}
          </s-paragraph>
          <s-paragraph>
            Review missing or weak descriptions, missing SEO content, and then generate improved copy in bulk.
          </s-paragraph>
        </s-stack>

        <Form method="post" action="?index">
          <input type="hidden" name="intent" value="bulk-generate-audit" />
          <s-stack direction="block" gap="base">
            {needsProfile && (
              <div style={getNoticeStyle(false)}>
                Save your business profile first so bulk generation matches your store voice.
              </div>
            )}

            <div style={bulkControlsStyle}>
              <div>
                <label htmlFor="mode">Rewrite mode</label>
                <select id="mode" name="mode" style={inputStyle} defaultValue="conversion">
                  <option value="conversion">Conversion-focused</option>
                  <option value="luxury">Luxury</option>
                  <option value="seo">SEO-friendly</option>
                  <option value="technical">Technical</option>
                  <option value="benefits">Benefits-first</option>
                  <option value="mobile">Mobile-friendly</option>
                  <option value="rewrite">Rewrite current copy</option>
                </select>
              </div>
              <div>
                <label htmlFor="language">Language</label>
                <select id="language" name="language" style={inputStyle} defaultValue="English">
                  <option value="English">English</option>
                  <option value="Arabic">Arabic</option>
                  <option value="French">French</option>
                </select>
              </div>
            </div>

            {auditItems.length ? (
              <div style={auditListStyle}>
                {auditItems.map((item) => (
                  <label key={item.id} style={auditCardStyle}>
                    <div style={auditCardHeaderStyle}>
                      <input type="checkbox" name="productIds" value={item.id} defaultChecked />
                      <strong>{item.title}</strong>
                    </div>
                    <p style={auditIssueStyle}>{item.issueSummary}</p>
                    <p style={auditMetaStyle}>
                      Current description: {item.currentDescriptionPreview}
                    </p>
                    <p style={auditMetaStyle}>
                      SEO title: {item.seoTitle || "Missing"} | SEO description:{" "}
                      {item.seoDescription || "Missing"}
                    </p>
                  </label>
                ))}
              </div>
            ) : (
              <div style={getNoticeStyle(true)}>
                Your recent catalog looks healthy. No weak or missing content was flagged.
              </div>
            )}

            <s-button type="submit" variant="secondary" disabled={needsProfile || !auditItems.length}>
              Generate and apply to selected products
            </s-button>
          </s-stack>
        </Form>

        {actionData?.message && actionData.intent === "bulk-generate-audit" && (
          <div style={getNoticeStyle(actionData.ok)}>{actionData.message}</div>
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
            <p style={sectionLabelStyle}>Choose plan</p>
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
          Choose a plan, complete your payment, and send your transaction
          reference so your upgrade can be reviewed and activated.
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

const bulkControlsStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "12px",
};

const auditListStyle = {
  display: "grid",
  gap: "12px",
};

const auditCardStyle = {
  display: "grid",
  gap: "8px",
  padding: "14px",
  borderRadius: "12px",
  border: "1px solid #d9dce1",
  background: "#ffffff",
};

const auditCardHeaderStyle = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  flexWrap: "wrap",
};

const auditIssueStyle = {
  margin: 0,
  color: "#9a3412",
  fontWeight: 600,
};

const auditMetaStyle = {
  margin: 0,
  color: "#4b5563",
  lineHeight: 1.5,
};

const sectionLabelStyle = {
  margin: 0,
  fontWeight: 600,
  color: "#111827",
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

async function getCatalogAudit(admin) {
  const response = await admin.graphql(
    `#graphql
      query AuditProducts {
        products(first: 20, sortKey: UPDATED_AT, reverse: true) {
          nodes {
            id
            title
            descriptionHtml
            seo {
              title
              description
            }
          }
        }
      }
    `,
  );
  const payload = await response.json();
  const products = payload?.data?.products?.nodes || [];
  const items = products
    .map((product) => {
      const descriptionText = stripHtml(product.descriptionHtml || "");
      const issues = [];

      if (descriptionText.length < 120) {
        issues.push(
          descriptionText
            ? "Description is too short for strong selling copy."
            : "Description is missing.",
        );
      }

      if (!product.seo?.title) {
        issues.push("SEO title is missing.");
      }

      if (!product.seo?.description) {
        issues.push("SEO description is missing.");
      }

      return {
        id: product.id,
        title: product.title,
        issueSummary: issues.join(" "),
        currentDescriptionPreview: descriptionText
          ? `${descriptionText.slice(0, 180)}${descriptionText.length > 180 ? "..." : ""}`
          : "No description yet.",
        seoTitle: product.seo?.title || "",
        seoDescription: product.seo?.description || "",
        issueCount: issues.length,
      };
    })
    .filter((item) => item.issueCount > 0);

  return {
    totalCount: products.length,
    flaggedCount: items.length,
    items,
  };
}

async function getProductsByIds(admin, ids) {
  const response = await admin.graphql(
    `#graphql
      query ProductsById($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            descriptionHtml
          }
        }
      }
    `,
    { variables: { ids } },
  );
  const payload = await response.json();
  return (payload?.data?.nodes || []).filter(Boolean);
}

async function updateShopifyProduct(admin, { productId, generated }) {
  const response = await admin.graphql(
    `#graphql
      mutation UpdateProductContent($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        product: {
          id: productId,
          descriptionHtml: buildDescriptionHtml(generated),
          seo: {
            title: generated.metaTitle,
            description: generated.metaDescription,
          },
        },
      },
    },
  );
  const payload = await response.json();
  const userErrors = payload?.data?.productUpdate?.userErrors || [];

  if (userErrors.length > 0) {
    throw new Error(userErrors[0]?.message || "Shopify rejected the update.");
  }
}

function buildDescriptionHtml(data) {
  return [
    `<p><strong>${escapeHtml(data.subtitle || "")}</strong></p>`,
    `<p>${escapeHtml(data.description || "")}</p>`,
    "<p><strong>Highlights:</strong></p>",
    `<ul>${(data.highlights || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`,
    "<p><strong>Composition:</strong></p>",
    ...(data.composition || []).map((item) => `<p>${escapeHtml(item)}</p>`),
    "<p><strong>FAQ:</strong></p>",
    ...(data.faq || []).map(
      (item) =>
        `<p><strong>${escapeHtml(item.question || "")}</strong><br/>${escapeHtml(item.answer || "")}</p>`,
    ),
  ].join("");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
