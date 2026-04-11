import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { close, data, i18n } = shopify;
  const selectedProductId = data?.selected?.[0]?.id || "";
  const [productTitle, setProductTitle] = useState("");
  const [generated, setGenerated] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("rewrite");
  const [language, setLanguage] = useState("English");
  const [target, setTarget] = useState("full");

  useEffect(() => {
    if (!selectedProductId) {
      return;
    }

    let active = true;

    (async () => {
      try {
        const response = await fetch("shopify:admin/api/graphql.json", {
          method: "POST",
          body: JSON.stringify({
            query: `query Product($id: ID!) {
              product(id: $id) {
                title
              }
            }`,
            variables: { id: selectedProductId },
          }),
        });

        if (!response.ok) {
          throw new Error("Could not load the current product.");
        }

        const payload = await response.json();

        if (active) {
          setProductTitle(payload?.data?.product?.title || "");
        }
      } catch (error) {
        if (active) {
          setMessage(error.message || "Could not load the current product.");
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [selectedProductId]);

  const summary = useMemo(() => {
    if (!generated) {
      return null;
    }

    return [
      generated.description,
      "",
      "Highlights:",
      ...(generated.highlights || []).map((item) => `- ${item}`),
      "",
      "Composition:",
      ...(generated.composition || []).map((item) => `- ${item}`),
    ].join("\n");
  }, [generated]);

  async function handleGenerate() {
    if (!selectedProductId) {
      setMessage("No product was selected.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const query = new URLSearchParams({
        productId: selectedProductId,
        mode,
        language,
        target,
      });
      const response = await fetch(`/api/generate-product-description?${query.toString()}`);
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Generation failed.");
      }

      setGenerated(payload);
      setMessage("Description generated and written to the product successfully.");
    } catch (error) {
      setMessage(error.message || "Could not generate the description.");
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    close();
  }

  return (
    <s-admin-action>
      <s-stack direction="block" gap="base">
        <s-heading>{i18n.translate("title")}</s-heading>
        <s-paragraph>
          {productTitle
            ? `${i18n.translate("currentProduct")} ${productTitle}`
            : i18n.translate("loadingProduct")}
        </s-paragraph>
        <s-paragraph>{i18n.translate("description")}</s-paragraph>
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="tight">
            <s-select
              label="Mode"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <s-option value="rewrite">Rewrite</s-option>
              <s-option value="conversion">Conversion focused</s-option>
              <s-option value="seo">SEO optimized</s-option>
              <s-option value="technical">Technical</s-option>
              <s-option value="benefits">Benefits</s-option>
              <s-option value="luxury">Luxury</s-option>
              <s-option value="mobile">Mobile</s-option>
            </s-select>

            <s-select
              label="Language"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <s-option value="English">English</s-option>
              <s-option value="Arabic">Arabic</s-option>
              <s-option value="French">French</s-option>
            </s-select>

            <s-select
              label="Update target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <s-option value="full">Description + SEO</s-option>
              <s-option value="description">Description only</s-option>
              <s-option value="seo">SEO only</s-option>
            </s-select>
          </s-stack>
        </s-box>
        {message ? <s-paragraph>{message}</s-paragraph> : null}
        {summary ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <pre style={preStyle}>{summary}</pre>
          </s-box>
        ) : null}
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleGenerate}
        {...(loading ? { loading: true, disabled: true } : {})}
      >
        {loading ? i18n.translate("generating") : i18n.translate("generate")}
      </s-button>
      <s-button slot="secondary-actions" onClick={handleClose}>
        {i18n.translate("close")}
      </s-button>
    </s-admin-action>
  );
}

const preStyle = {
  margin: 0,
  whiteSpace: "pre-wrap",
  fontFamily: "inherit",
  lineHeight: 1.5,
};
