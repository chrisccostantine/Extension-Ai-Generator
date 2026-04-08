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
      const query = new URLSearchParams({ productId: selectedProductId });
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
      <s-button slot="secondary-actions" onClick={close}>
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
