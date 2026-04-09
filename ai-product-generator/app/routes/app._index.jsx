/* global Buffer, process */
import { useMemo } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const PAYMENT_INSTRUCTIONS_TEXT =
  "Transfers through Whish, BOB Finance, or OMT must be sent to +961 70 221 936. After payment, submit your transaction reference and optional proof screenshot in the app.";
const SUPPORT_CONTACT_TEXT =
  "WhatsApp +961 81 106 116 or email: scalora.socialmedia.agency@gmail.com";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const backend = getBackendConfig();
  const clientId = toClientId(session.shop);
  const auditFilters = getAuditFiltersFromRequest(request);
  const audit = await getCatalogAudit(admin, auditFilters);

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
      auditFilters,
      presets: [],
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
    const presetsPayload = shopStatus?.plan?.features?.presetsEnabled
      ? await backendRequest({
          backend,
          pathname: "/content-presets",
          method: "GET",
          clientId,
        })
      : { presets: [] };

    return {
      backendConfigured: true,
      shopDomain: session.shop,
      clientId,
      shopStatus,
      plans: plansPayload.plans || [],
      paymentInstructions: plansPayload.paymentInstructions || "",
      supportContact: plansPayload.supportContact || "",
      audit,
      auditFilters,
      presets: presetsPayload.presets || [],
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
      auditFilters,
      presets: [],
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
    const planFeatures = await getPlanAccess(backend, clientId);

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
      const bulkGenerationInput = await buildBulkGenerationInput({
        admin,
        backend,
        clientId,
        formData,
      });

      if (bulkGenerationInput.errorMessage) {
        return {
          ok: false,
          intent,
          message: bulkGenerationInput.errorMessage,
        };
      }

      let successCount = 0;
      const failedTitles = [];

      for (const preview of bulkGenerationInput.previews) {
        try {
          await updateShopifyProduct(admin, {
            productId: preview.productId,
            generated: preview.generated,
          });
          successCount += 1;
        } catch (_error) {
          failedTitles.push(preview.title);
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

    if (intent === "preview-bulk-generate-audit") {
      const bulkGenerationInput = await buildBulkGenerationInput({
        admin,
        backend,
        clientId,
        formData,
      });

      if (bulkGenerationInput.errorMessage) {
        return {
          ok: false,
          intent,
          message: bulkGenerationInput.errorMessage,
        };
      }

      return {
        ok: true,
        intent,
        message: `Generated ${bulkGenerationInput.previews.length} preview${
          bulkGenerationInput.previews.length === 1 ? "" : "s"
        }. Review them below before applying.`,
        previews: bulkGenerationInput.previews,
      };
    }

    if (intent === "apply-preview-batch") {
      if (!planFeatures.bulkGenerationEnabled) {
        return {
          ok: false,
          intent,
          message: "Upgrade to Growth or Scale to apply bulk previews.",
        };
      }

      const previewsJson = String(formData.get("previewsJson") || "").trim();

      if (!previewsJson) {
        return {
          ok: false,
          intent,
          message: "No previews were provided to apply.",
        };
      }

      const previews = JSON.parse(previewsJson);
      const selectedProductIds = formData
        .getAll("selectedPreviewProductIds")
        .map((value) => String(value || "").trim())
        .filter(Boolean);

      const previewsToApply = selectedProductIds.length
        ? previews.filter((preview) => selectedProductIds.includes(preview.productId))
        : previews;

      if (!previewsToApply.length) {
        return {
          ok: false,
          intent,
          message: "Select at least one preview to apply.",
        };
      }

      let successCount = 0;
      const failedTitles = [];

      for (const preview of previewsToApply) {
        try {
          await updateShopifyProduct(admin, {
            productId: preview.productId,
            generated: preview.generated,
          });
          successCount += 1;
        } catch (_error) {
          failedTitles.push(preview.title);
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

    if (intent === "save-preset") {
      if (!planFeatures.presetsEnabled) {
        return {
          ok: false,
          intent,
          message: "Upgrade to Growth or Scale to save presets.",
        };
      }

      const name = String(formData.get("presetName") || "").trim();
      const mode = String(formData.get("presetMode") || "").trim().toLowerCase();
      const language = String(formData.get("presetLanguage") || "").trim();
      const instructions = String(formData.get("presetInstructions") || "").trim();

      const result = await backendRequest({
        backend,
        pathname: "/content-presets",
        method: "POST",
        body: {
          clientId,
          name,
          mode,
          language,
          instructions,
        },
      });

      return {
        ok: true,
        intent,
        message: result.message || "Preset saved successfully.",
      };
    }

    if (intent === "delete-preset") {
      if (!planFeatures.presetsEnabled) {
        return {
          ok: false,
          intent,
          message: "Your current plan does not include saved presets.",
        };
      }

      const presetId = String(formData.get("presetId") || "").trim();

      if (!presetId) {
        return {
          ok: false,
          intent,
          message: "Preset id is required.",
        };
      }

      const result = await backendRequest({
        backend,
        pathname: `/content-presets/${presetId}/delete`,
        method: "POST",
        body: { clientId },
      });

      return {
        ok: true,
        intent,
        message: result.message || "Preset deleted successfully.",
      };
    }

    if (intent === "request-plan") {
      const requestedPlanName = String(formData.get("requestedPlanName") || "")
        .trim()
        .toLowerCase();
      const contactName = String(formData.get("contactName") || "").trim();
      const phoneNumber = String(formData.get("phoneNumber") || "").trim();
      const email = String(formData.get("email") || "").trim();
      const paymentMethod = String(formData.get("paymentMethod") || "").trim();
      const paymentReference = String(
        formData.get("paymentReference") || "",
      ).trim();
      const notes = String(formData.get("notes") || "").trim();
      const proofFile = formData.get("proofFile");

      if (!contactName) {
        return {
          ok: false,
          intent,
          message: "Your name is required.",
        };
      }

      if (!phoneNumber) {
        return {
          ok: false,
          intent,
          message: "Phone number is required.",
        };
      }

      const proofPayload = await serializeUploadedProof(proofFile);

      const result = await backendRequest({
        backend,
        pathname: "/plan-requests",
        method: "POST",
        body: {
          clientId,
          requestedPlanName,
          contactName,
          phoneNumber,
          email,
          paymentMethod,
          paymentReference,
          notes,
          ...proofPayload,
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
  const presets = data.presets || [];
  const auditFilters = data.auditFilters || emptyAuditFilters;
  const planFeatures = data.shopStatus?.plan?.features || emptyPlanFeatures;
  const defaultRequestedPlanName =
    paidPlans.find((plan) => plan.name !== currentPlanName)?.name ||
    paidPlans[0]?.name ||
    "";
  const auditItems = data.audit?.items || [];
  const previewItems =
    actionData?.intent === "preview-bulk-generate-audit" ? actionData.previews || [] : [];

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

      <s-section heading="Saved presets">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Save reusable generation recipes for tone, language, and special instructions so your team can apply them across the catalog quickly.
          </s-paragraph>
        </s-stack>
        {!planFeatures.presetsEnabled ? (
          <div style={getNoticeStyle(false)}>
            Saved presets are available on the Growth and Scale plans.
          </div>
        ) : (
          <>
            <Form method="post" action="?index">
              <input type="hidden" name="intent" value="save-preset" />
              <div style={presetFormGridStyle}>
                <div>
                  <label htmlFor="presetName">Preset name</label>
                  <input
                    id="presetName"
                    name="presetName"
                    type="text"
                    placeholder="Luxury sneakers in Arabic"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label htmlFor="presetMode">Mode</label>
                  <select id="presetMode" name="presetMode" style={inputStyle} defaultValue="conversion">
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
                  <label htmlFor="presetLanguage">Language</label>
                  <select id="presetLanguage" name="presetLanguage" style={inputStyle} defaultValue="English">
                    <option value="English">English</option>
                    <option value="Arabic">Arabic</option>
                    <option value="French">French</option>
                  </select>
                </div>
              </div>

              <label htmlFor="presetInstructions">Extra instructions</label>
              <textarea
                id="presetInstructions"
                name="presetInstructions"
                rows="4"
                placeholder="Example: Keep a refined premium tone, mention craftsmanship, and avoid playful language."
                style={inputStyle}
              />

              <s-button type="submit" variant="secondary">Save preset</s-button>
            </Form>

            {actionData?.message && actionData.intent === "save-preset" && (
              <div style={getNoticeStyle(actionData.ok)}>{actionData.message}</div>
            )}

            {presets.length ? (
              <div style={presetListStyle}>
                {presets.map((preset) => (
                  <div key={preset.id} style={presetCardStyle}>
                    <div style={presetCardHeaderStyle}>
                      <strong>{preset.name}</strong>
                      <span style={presetTagStyle}>
                        {capitalizePlanName(preset.mode)} | {preset.language}
                      </span>
                    </div>
                    <p style={presetDescriptionTextStyle}>
                      {preset.instructions || "No extra instructions for this preset."}
                    </p>
                    <Form method="post" action="?index">
                      <input type="hidden" name="intent" value="delete-preset" />
                      <input type="hidden" name="presetId" value={preset.id} />
                      <s-button type="submit" variant="secondary">Delete preset</s-button>
                    </Form>
                  </div>
                ))}
              </div>
            ) : (
              <div style={getNoticeStyle(false)}>
                No presets saved yet. Create one to reuse your favorite generation setup.
              </div>
            )}

            {actionData?.message && actionData.intent === "delete-preset" && (
              <div style={getNoticeStyle(actionData.ok)}>{actionData.message}</div>
            )}
          </>
        )}
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

        {!planFeatures.bulkGenerationEnabled && (
          <div style={getNoticeStyle(false)}>
            Bulk generation, preview, and bulk apply are available on the Growth and Scale plans.
          </div>
        )}

        <Form method="get">
          <div style={auditFilterGridStyle}>
            <div>
              <label htmlFor="q">Search</label>
              <input
                id="q"
                name="q"
                type="text"
                placeholder="Search by product title"
                defaultValue={auditFilters.q}
                style={inputStyle}
              />
            </div>
            <div>
              <label htmlFor="issueType">Issue type</label>
              <select
                id="issueType"
                name="issueType"
                style={inputStyle}
                defaultValue={auditFilters.issueType}
              >
                <option value="">All issues</option>
                <option value="description">Description</option>
                <option value="seo-title">SEO title</option>
                <option value="seo-description">SEO description</option>
              </select>
            </div>
            <div>
              <label htmlFor="vendor">Vendor</label>
              <select
                id="vendor"
                name="vendor"
                style={inputStyle}
                defaultValue={auditFilters.vendor}
              >
                <option value="">All vendors</option>
                {(data.audit?.availableVendors || []).map((vendor) => (
                  <option key={vendor} value={vendor}>
                    {vendor}
                  </option>
                ))}
              </select>
            </div>
              <div>
                <label htmlFor="productType">Product type</label>
                <select
                  id="productType"
                  name="productType"
                style={inputStyle}
                defaultValue={auditFilters.productType}
              >
                <option value="">All product types</option>
                {(data.audit?.availableProductTypes || []).map((productType) => (
                  <option key={productType} value={productType}>
                    {productType}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="collectionId">Collection</label>
              <select
                id="collectionId"
                name="collectionId"
                style={inputStyle}
                defaultValue={auditFilters.collectionId}
              >
                <option value="">All collections</option>
                {(data.audit?.availableCollections || []).map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <s-button type="submit" variant="secondary">Apply filters</s-button>
        </Form>

        <Form method="post" action="?index" encType="multipart/form-data">
          <input type="hidden" name="intent" value="bulk-generate-audit" />
          <s-stack direction="block" gap="base">
            {needsProfile && (
              <div style={getNoticeStyle(false)}>
                Save your business profile first so bulk generation matches your store voice.
              </div>
            )}

            <div style={bulkControlsStyle}>
              <div>
                <label htmlFor="presetId">Saved preset</label>
                <select
                  id="presetId"
                  name="presetId"
                  style={inputStyle}
                  defaultValue=""
                  disabled={!planFeatures.presetsEnabled}
                >
                  <option value="">No preset</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="mode">Rewrite mode</label>
                <select
                  id="mode"
                  name="mode"
                  style={inputStyle}
                  defaultValue="conversion"
                  disabled={!planFeatures.bulkGenerationEnabled}
                >
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
                <select
                  id="language"
                  name="language"
                  style={inputStyle}
                  defaultValue="English"
                  disabled={!planFeatures.bulkGenerationEnabled}
                >
                  <option value="English">English</option>
                  <option value="Arabic">Arabic</option>
                  <option value="French">French</option>
                </select>
              </div>
            </div>

            <label htmlFor="bulkPresetInstructions">Extra instructions</label>
            <textarea
              id="bulkPresetInstructions"
              name="presetInstructions"
              rows="4"
              placeholder="Optional extra guidance for this bulk run"
              style={inputStyle}
              disabled={!planFeatures.bulkGenerationEnabled}
            />

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
                    <p style={auditMetaStyle}>
                      Collections: {item.collectionTitles.length ? item.collectionTitles.join(", ") : "No collections"}
                    </p>
                  </label>
                ))}
              </div>
            ) : (
              <div style={getNoticeStyle(true)}>
                Your recent catalog looks healthy. No weak or missing content was flagged.
              </div>
            )}

            <div style={bulkActionRowStyle}>
              <s-button
                type="submit"
                name="_action"
                value="preview"
                variant="secondary"
                formaction="?index"
                onClick={(event) => {
                  event.currentTarget.form.elements.intent.value =
                    "preview-bulk-generate-audit";
                }}
                disabled={
                  needsProfile ||
                  !auditItems.length ||
                  !planFeatures.bulkGenerationEnabled
                }
              >
                Preview selected products
              </s-button>
              <s-button
                type="submit"
                name="_action"
                value="apply"
                variant="secondary"
                formaction="?index"
                onClick={(event) => {
                  event.currentTarget.form.elements.intent.value =
                    "bulk-generate-audit";
                }}
                disabled={
                  needsProfile ||
                  !auditItems.length ||
                  !planFeatures.bulkGenerationEnabled
                }
              >
                Generate and apply to selected products
              </s-button>
            </div>
          </s-stack>
        </Form>

        {actionData?.message &&
          (actionData.intent === "bulk-generate-audit" ||
            actionData.intent === "preview-bulk-generate-audit" ||
            actionData.intent === "apply-preview-batch") && (
          <div style={getNoticeStyle(actionData.ok)}>{actionData.message}</div>
        )}

        {previewItems.length ? (
          <s-stack direction="block" gap="base">
            <s-heading>Preview before apply</s-heading>
            <Form method="post" action="?index">
              <input type="hidden" name="intent" value="apply-preview-batch" />
              <input
                type="hidden"
                name="previewsJson"
                value={JSON.stringify(previewItems)}
              />
              <div style={previewListStyle}>
                {previewItems.map((preview) => (
                  <div key={preview.productId} style={previewCardStyle}>
                    <div style={auditCardHeaderStyle}>
                      <input
                        id={`preview-${preview.productId}`}
                        type="checkbox"
                        name="selectedPreviewProductIds"
                        value={preview.productId}
                        defaultChecked
                      />
                      <label htmlFor={`preview-${preview.productId}`}>
                        <strong>{preview.title}</strong>
                      </label>
                    </div>
                    <div style={previewColumnsStyle}>
                      <div style={previewPanelStyle}>
                        <strong>Before</strong>
                        <p style={previewTextStyle}>{preview.beforeDescription}</p>
                        <p style={previewMetaStyle}>
                          SEO title: {preview.beforeSeoTitle || "Missing"}
                        </p>
                        <p style={previewMetaStyle}>
                          SEO description: {preview.beforeSeoDescription || "Missing"}
                        </p>
                      </div>
                      <div style={previewPanelStyle}>
                        <strong>After</strong>
                        <p style={previewMetaHeadlineStyle}>
                          {preview.generated.subtitle || "No subtitle generated"}
                        </p>
                        <p style={previewTextStyle}>{preview.generated.description}</p>
                        <div style={previewListBlockStyle}>
                          <strong>Highlights</strong>
                          <ul style={previewBulletListStyle}>
                            {(preview.generated.highlights || []).map((item) => (
                              <li key={`${preview.productId}-${item}`}>{item}</li>
                            ))}
                          </ul>
                        </div>
                        <div style={previewListBlockStyle}>
                          <strong>Composition</strong>
                          <ul style={previewBulletListStyle}>
                            {(preview.generated.composition || []).map((item) => (
                              <li key={`${preview.productId}-composition-${item}`}>{item}</li>
                            ))}
                          </ul>
                        </div>
                        <div style={previewListBlockStyle}>
                          <strong>FAQ</strong>
                          <div style={previewFaqListStyle}>
                            {(preview.generated.faq || []).map((item) => (
                              <div
                                key={`${preview.productId}-faq-${item.question}`}
                                style={previewFaqItemStyle}
                              >
                                <strong>{item.question}</strong>
                                <p style={previewMetaStyle}>{item.answer}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                        <p style={previewMetaStyle}>
                          SEO title: {preview.generated.metaTitle}
                        </p>
                        <p style={previewMetaStyle}>
                          SEO description: {preview.generated.metaDescription}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <s-button
                type="submit"
                variant="secondary"
                disabled={!planFeatures.bulkGenerationEnabled}
              >
                Apply selected previews
              </s-button>
            </Form>
          </s-stack>
        ) : null}
      </s-section>

      <s-section
        heading={needsProfile ? "Business onboarding" : "Business profile"}
      >
        <Form method="post" action="?index" encType="multipart/form-data">
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
                        {plan.features_list?.length ? (
                          <ul style={planFeatureListStyle}>
                            {plan.features_list.map((feature) => (
                              <li key={`${plan.name}-${feature}`}>{feature}</li>
                            ))}
                          </ul>
                        ) : null}
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

            <div style={paymentNoticeStyle}>
              <strong>Payment destination</strong>
              <p style={paymentNoticeTextStyle}>
                {PAYMENT_INSTRUCTIONS_TEXT}
              </p>
              <p style={paymentNoticeTextStyle}>
                <strong>Confirmation contact:</strong> {SUPPORT_CONTACT_TEXT}
              </p>
            </div>

            <label htmlFor="contactName">Your name</label>
            <input
              id="contactName"
              name="contactName"
              type="text"
              placeholder="Required full name"
              style={inputStyle}
              required
            />

            <label htmlFor="phoneNumber">Phone number</label>
            <input
              id="phoneNumber"
              name="phoneNumber"
              type="text"
              placeholder="Required phone number"
              style={inputStyle}
              required
            />

            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              placeholder="Optional email address"
              style={inputStyle}
            />

            <label htmlFor="paymentMethod">Payment method</label>
            <input
              id="paymentMethod"
              name="paymentMethod"
              type="text"
              placeholder="OMT, Whish, BOB Finance, bank transfer..."
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

            <label htmlFor="proofFile">Transaction screenshot</label>
            <input
              id="proofFile"
              name="proofFile"
              type="file"
              accept="image/*"
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
          {PAYMENT_INSTRUCTIONS_TEXT}
        </s-paragraph>
        <s-paragraph>
          <strong>Contact:</strong> {SUPPORT_CONTACT_TEXT}
        </s-paragraph>
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

async function serializeUploadedProof(file) {
  if (
    !file ||
    typeof file !== "object" ||
    typeof file.arrayBuffer !== "function" ||
    !("size" in file) ||
    file.size === 0
  ) {
    return {};
  }

  const arrayBuffer = await file.arrayBuffer();
  const base64 = bufferToBase64(arrayBuffer);

  return {
    proofFileName: file.name || "",
    proofMimeType: file.type || "",
    proofDataUrl: `data:${file.type || "application/octet-stream"};base64,${base64}`,
  };
}

function bufferToBase64(arrayBuffer) {
  return Buffer.from(arrayBuffer).toString("base64");
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

const planFeatureListStyle = {
  margin: "4px 0 0",
  paddingLeft: "18px",
  color: "#4b5563",
  lineHeight: 1.5,
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

const presetFormGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "12px",
  marginBottom: "12px",
};

const presetListStyle = {
  display: "grid",
  gap: "12px",
  marginTop: "16px",
};

const presetCardStyle = {
  display: "grid",
  gap: "8px",
  padding: "14px",
  borderRadius: "12px",
  border: "1px solid #d9dce1",
  background: "#ffffff",
};

const presetCardHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: "10px",
  flexWrap: "wrap",
  alignItems: "center",
};

const presetTagStyle = {
  color: "#4338ca",
  fontWeight: 600,
};

const presetDescriptionTextStyle = {
  margin: 0,
  color: "#4b5563",
  lineHeight: 1.5,
};

const auditFilterGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "12px",
  marginBottom: "12px",
};

const bulkActionRowStyle = {
  display: "flex",
  gap: "12px",
  flexWrap: "wrap",
};

const previewListStyle = {
  display: "grid",
  gap: "12px",
};

const previewCardStyle = {
  display: "grid",
  gap: "12px",
  padding: "14px",
  borderRadius: "12px",
  border: "1px solid #d9dce1",
  background: "#ffffff",
};

const previewColumnsStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "12px",
};

const previewPanelStyle = {
  display: "grid",
  gap: "8px",
  padding: "12px",
  borderRadius: "10px",
  border: "1px solid #e5e7eb",
  background: "#f9fafb",
};

const previewTextStyle = {
  margin: 0,
  color: "#111827",
  lineHeight: 1.6,
};

const previewMetaHeadlineStyle = {
  margin: 0,
  color: "#111827",
  fontWeight: 600,
  lineHeight: 1.5,
};

const previewMetaStyle = {
  margin: 0,
  color: "#4b5563",
  lineHeight: 1.5,
};

const previewListBlockStyle = {
  display: "grid",
  gap: "6px",
};

const previewBulletListStyle = {
  margin: 0,
  paddingLeft: "18px",
  color: "#111827",
  lineHeight: 1.5,
};

const previewFaqListStyle = {
  display: "grid",
  gap: "8px",
};

const previewFaqItemStyle = {
  display: "grid",
  gap: "4px",
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

const paymentNoticeStyle = {
  display: "grid",
  gap: "8px",
  padding: "14px",
  borderRadius: "12px",
  border: "1px solid #f59e0b",
  background: "#fffbeb",
};

const paymentNoticeTextStyle = {
  margin: 0,
  color: "#111827",
  lineHeight: 1.5,
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

async function getCatalogAudit(admin, filters) {
  const response = await admin.graphql(
    `#graphql
      query AuditProducts {
        products(first: 20, sortKey: UPDATED_AT, reverse: true) {
          nodes {
            id
            title
            productType
            vendor
            descriptionHtml
            collections(first: 10) {
              nodes {
                id
                title
              }
            }
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
  const availableVendors = Array.from(
    new Set(products.map((product) => product.vendor).filter(Boolean)),
  ).sort();
  const availableProductTypes = Array.from(
    new Set(products.map((product) => product.productType).filter(Boolean)),
  ).sort();
  const availableCollections = Array.from(
    new Map(
      products
        .flatMap((product) => product.collections?.nodes || [])
        .filter((collection) => collection?.id && collection?.title)
        .map((collection) => [collection.id, { id: collection.id, title: collection.title }]),
    ).values(),
  ).sort((left, right) => left.title.localeCompare(right.title));
  const items = products
    .map((product) => {
      const descriptionText = stripHtml(product.descriptionHtml || "");
      const issues = [];
      const issueTypes = [];
      const collections = product.collections?.nodes || [];

      if (descriptionText.length < 120) {
        issues.push(
          descriptionText
            ? "Description is too short for strong selling copy."
            : "Description is missing.",
        );
        issueTypes.push("description");
      }

      if (!product.seo?.title) {
        issues.push("SEO title is missing.");
        issueTypes.push("seo-title");
      }

      if (!product.seo?.description) {
        issues.push("SEO description is missing.");
        issueTypes.push("seo-description");
      }

      return {
        id: product.id,
        title: product.title,
        productType: product.productType || "",
        vendor: product.vendor || "",
        collectionIds: collections.map((collection) => collection.id),
        collectionTitles: collections.map((collection) => collection.title).filter(Boolean),
        issueSummary: issues.join(" "),
        currentDescriptionPreview: descriptionText
          ? `${descriptionText.slice(0, 180)}${descriptionText.length > 180 ? "..." : ""}`
          : "No description yet.",
        seoTitle: product.seo?.title || "",
        seoDescription: product.seo?.description || "",
        issueTypes,
        issueCount: issues.length,
      };
    })
    .filter((item) => {
      if (filters.q) {
        const haystack = `${item.title} ${item.vendor} ${item.productType}`.toLowerCase();
        if (!haystack.includes(filters.q.toLowerCase())) {
          return false;
        }
      }

      if (filters.issueType && !item.issueTypes.includes(filters.issueType)) {
        return false;
      }

      if (filters.vendor && item.vendor !== filters.vendor) {
        return false;
      }

      if (filters.productType && item.productType !== filters.productType) {
        return false;
      }

      if (
        filters.collectionId &&
        !item.collectionIds.includes(filters.collectionId)
      ) {
        return false;
      }

      return true;
    })
    .filter((item) => item.issueCount > 0);

  return {
    totalCount: products.length,
    flaggedCount: items.length,
    items,
    availableVendors,
    availableProductTypes,
    availableCollections,
  };
}

function getAuditFiltersFromRequest(request) {
  const url = new URL(request.url);
  return {
    q: String(url.searchParams.get("q") || "").trim(),
    issueType: String(url.searchParams.get("issueType") || "").trim(),
    vendor: String(url.searchParams.get("vendor") || "").trim(),
    productType: String(url.searchParams.get("productType") || "").trim(),
    collectionId: String(url.searchParams.get("collectionId") || "").trim(),
  };
}

async function getPlanAccess(backend, clientId) {
  const shopStatus = await backendRequest({
    backend,
    pathname: "/shop-status",
    method: "GET",
    clientId,
  });

  return shopStatus?.plan?.features || emptyPlanFeatures;
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
            seo {
              title
              description
            }
          }
        }
      }
    `,
    { variables: { ids } },
  );
  const payload = await response.json();
  return (payload?.data?.nodes || []).filter(Boolean);
}

async function buildBulkGenerationInput({ admin, backend, clientId, formData }) {
  const planFeatures = await getPlanAccess(backend, clientId);

  if (!planFeatures.bulkGenerationEnabled) {
    return {
      errorMessage: "Upgrade to Growth or Scale to use bulk generation.",
      previews: [],
    };
  }

  const selectedProductIds = formData
    .getAll("productIds")
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  let mode = String(formData.get("mode") || "").trim().toLowerCase();
  let language = String(formData.get("language") || "").trim();
  let presetInstructions = String(formData.get("presetInstructions") || "").trim();
  const presetId = String(formData.get("presetId") || "").trim();

  if (!selectedProductIds.length) {
    return {
      errorMessage: "Select at least one product from the audit list.",
      previews: [],
    };
  }

  if (presetId) {
    const presetsPayload = await backendRequest({
      backend,
      pathname: "/content-presets",
      method: "GET",
      clientId,
    });
    const selectedPreset = (presetsPayload.presets || []).find(
      (preset) => String(preset.id) === presetId,
    );

    if (selectedPreset) {
      mode = selectedPreset.mode;
      language = selectedPreset.language;
      presetInstructions = selectedPreset.instructions || "";
    }
  }

  const products = await getProductsByIds(admin, selectedProductIds);
  const previews = [];

  for (const product of products) {
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
        presetInstructions,
      },
    });

    previews.push({
      productId: product.id,
      title: product.title,
      beforeDescription: stripHtml(product.descriptionHtml || "") || "No description yet.",
      beforeSeoTitle: product.seo?.title || "",
      beforeSeoDescription: product.seo?.description || "",
      generated,
    });
  }

  return {
    errorMessage: "",
    previews,
  };
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

const emptyAuditFilters = {
  q: "",
  issueType: "",
  vendor: "",
  productType: "",
  collectionId: "",
};

const emptyPlanFeatures = {
  presetsEnabled: false,
  bulkGenerationEnabled: false,
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
