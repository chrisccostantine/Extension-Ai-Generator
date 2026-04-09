import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { close, data, i18n } = shopify;
  const selectedProductId = data?.selected?.[0]?.id || "";
  const [productTitle, setProductTitle] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stylePreset, setStylePreset] = useState("clean-studio");
  const [outputSize, setOutputSize] = useState("1024x1024");
  const [backgroundStyle, setBackgroundStyle] = useState("white");
  const [instructions, setInstructions] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [generatedImages, setGeneratedImages] = useState([]);

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

  async function handleGenerate() {
    if (!selectedProductId) {
      setMessage("No product was selected.");
      return;
    }

    if (!selectedFiles.length) {
      setMessage("Upload at least one source image before generating.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("intent", "generate");
      formData.append("productId", selectedProductId);
      formData.append("imageStylePreset", stylePreset);
      formData.append("imageOutputSize", outputSize);
      formData.append("imageBackgroundStyle", backgroundStyle);
      formData.append("imageInstructions", instructions);

      selectedFiles.forEach((file) => {
        formData.append("productImages", file);
      });

      const response = await fetch("/api/generate-product-images", {
        method: "POST",
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Image generation failed.");
      }

      setGeneratedImages(payload.images || []);
      setMessage("Images generated successfully. Save them to the product when ready.");
    } catch (error) {
      setMessage(error.message || "Could not generate images.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!selectedProductId) {
      setMessage("No product was selected.");
      return;
    }

    if (!generatedImages.length) {
      setMessage("Generate images first, then save them to the product.");
      return;
    }

    setSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/generate-product-images", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          intent: "save",
          productId: selectedProductId,
          images: generatedImages,
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Could not save images.");
      }

      setMessage(payload.message || "Images saved to the selected product.");
    } catch (error) {
      setMessage(error.message || "Could not save images.");
    } finally {
      setSaving(false);
    }
  }

  function handleRegenerate() {
    setGeneratedImages([]);
    setInstructions("");
    setSelectedFiles([]);
    setMessage("Add your new requirements and images, then generate again.");
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
            <label htmlFor="imageStylePreset">Style preset</label>
            <select
              id="imageStylePreset"
              value={stylePreset}
              onChange={(event) => setStylePreset(event.target.value)}
            >
              <option value="clean-studio">Clean studio</option>
              <option value="luxury-studio">Luxury studio</option>
              <option value="white-background">White background</option>
              <option value="soft-shadow">Soft shadow</option>
              <option value="social-ready">Social ready</option>
            </select>

            <label htmlFor="imageOutputSize">Output size</label>
            <select
              id="imageOutputSize"
              value={outputSize}
              onChange={(event) => setOutputSize(event.target.value)}
            >
              <option value="1024x1024">Square</option>
              <option value="1536x1024">Landscape</option>
              <option value="1024x1536">Portrait</option>
            </select>

            <label htmlFor="imageBackgroundStyle">Background</label>
            <select
              id="imageBackgroundStyle"
              value={backgroundStyle}
              onChange={(event) => setBackgroundStyle(event.target.value)}
            >
              <option value="white">White</option>
              <option value="soft-gray">Soft gray</option>
              <option value="transparent">Transparent</option>
            </select>

            <label htmlFor="imageInstructions">Image instructions</label>
            <textarea
              id="imageInstructions"
              rows="4"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />

            <label htmlFor="productImages">Source images</label>
            <input
              id="productImages"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                setSelectedFiles(files);
              }}
            />
            {selectedFiles.length ? (
              <s-paragraph>{selectedFiles.length} source image(s) selected.</s-paragraph>
            ) : null}
          </s-stack>
        </s-box>

        {message ? <s-paragraph>{message}</s-paragraph> : null}

        {generatedImages.length ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="tight">
              {generatedImages.map((image, index) => (
                <img
                  key={image.id || `generated-${index}`}
                  src={image.dataUrl}
                  alt={`Generated product visual ${index + 1}`}
                  style={imagePreviewStyle}
                />
              ))}
            </s-stack>
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
      <s-button
        slot="secondary-actions"
        onClick={handleSave}
        {...(saving || !generatedImages.length ? { loading: saving, disabled: true } : {})}
      >
        {saving ? i18n.translate("saving") : i18n.translate("save")}
      </s-button>
      <s-button slot="secondary-actions" onClick={handleRegenerate} disabled={loading || saving}>
        {i18n.translate("regenerate")}
      </s-button>
      <s-button slot="secondary-actions" onClick={handleClose} disabled={loading || saving}>
        {i18n.translate("close")}
      </s-button>
    </s-admin-action>
  );
}

const imagePreviewStyle = {
  display: "block",
  width: "100%",
  maxWidth: "340px",
  borderRadius: "10px",
  marginBottom: "10px",
};
