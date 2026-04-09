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
  const [imageCount, setImageCount] = useState("1");
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
      formData.append("imageCount", imageCount);
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
            <s-select
              id="imageStylePreset"
              label="Style preset"
              value={stylePreset}
              onChange={(event) => setStylePreset(event.currentTarget.value)}
            >
              <s-option value="clean-studio">Clean studio</s-option>
              <s-option value="luxury-studio">Luxury studio</s-option>
              <s-option value="white-background">White background</s-option>
              <s-option value="soft-shadow">Soft shadow</s-option>
              <s-option value="social-ready">Social ready</s-option>
            </s-select>

            <s-select
              id="imageOutputSize"
              label="Output size"
              value={outputSize}
              onChange={(event) => setOutputSize(event.currentTarget.value)}
            >
              <s-option value="1024x1024">Square</s-option>
              <s-option value="1536x1024">Landscape</s-option>
              <s-option value="1024x1536">Portrait</s-option>
            </s-select>

            <s-select
              id="imageBackgroundStyle"
              label="Background"
              value={backgroundStyle}
              onChange={(event) => setBackgroundStyle(event.currentTarget.value)}
            >
              <s-option value="white">White</s-option>
              <s-option value="soft-gray">Soft gray</s-option>
              <s-option value="transparent">Transparent</s-option>
            </s-select>

            <s-select
              id="imageCount"
              label="Number of images"
              value={imageCount}
              onChange={(event) => setImageCount(event.currentTarget.value)}
            >
              <s-option value="1">1 image</s-option>
              <s-option value="2">2 images</s-option>
              <s-option value="3">3 images</s-option>
              <s-option value="4">4 images</s-option>
            </s-select>

            <s-text-area
              id="imageInstructions"
              label="Image instructions"
              placeholder="Clean white background, preserve logo details, add soft natural shadow..."
              rows="4"
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
            />

            <s-drop-zone
              id="productImages"
              label="Source images"
              accept="image/*"
              multiple
              onChange={(event) => {
                setSelectedFiles([...(event.currentTarget.files || [])]);
              }}
              onInput={(event) => {
                setSelectedFiles([...(event.currentTarget.files || [])]);
              }}
            />
            {selectedFiles.length ? (
              <s-paragraph>{selectedFiles.length} source image(s) selected.</s-paragraph>
            ) : (
              <s-paragraph>Upload at least one source image before generating.</s-paragraph>
            )}
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
