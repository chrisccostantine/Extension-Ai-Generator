/* global Buffer, process */
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session, cors } = await authenticate.admin(request);
  const backend = getBackendConfig();

  if (!backend.baseUrl) {
    return cors(
      Response.json(
        { error: "BACKEND_API_URL is not configured in the Shopify app." },
        { status: 500 },
      ),
    );
  }

  try {
    const clientId = toClientId(session.shop);
    const statusResponse = await fetch(
      `${backend.baseUrl}/shop-status?clientId=${encodeURIComponent(clientId)}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(backend.extensionToken ? { "x-extension-token": backend.extensionToken } : {}),
        },
      },
    );
    const statusPayload = await statusResponse.json();

    if (!statusResponse.ok) {
      throw new Error(statusPayload.error || "Could not load image availability.");
    }

    const limit = Number(statusPayload?.plan?.monthly_image_limit || 0);
    const used = Number(statusPayload?.imageUsage?.count || 0);
    const remaining = Math.max(0, limit - used);
    const imageGenerationEnabled = Boolean(statusPayload?.plan?.features?.imageGenerationEnabled);

    return cors(
      Response.json({
        ok: true,
        imageGenerationEnabled,
        imageUsage: {
          count: used,
          limit,
          remaining,
        },
      }),
    );
  } catch (error) {
    return cors(
      Response.json(
        { error: error?.message || "Could not load image availability." },
        { status: 500 },
      ),
    );
  }
};

export const action = async ({ request }) => {
  const { admin, session, cors } = await authenticate.admin(request);
  const backend = getBackendConfig();

  if (!backend.baseUrl) {
    return cors(
      Response.json(
        { error: "BACKEND_API_URL is not configured in the Shopify app." },
        { status: 500 },
      ),
    );
  }

  try {
    const parsed = await parseRequestPayload(request);

    if (parsed.intent === "save") {
      const productId = String(parsed.productId || "").trim();
      const images = Array.isArray(parsed.images) ? parsed.images : [];

      if (!productId) {
        return cors(Response.json({ error: "Product id is required." }, { status: 400 }));
      }

      if (!images.length) {
        return cors(
          Response.json({ error: "No generated images were provided." }, { status: 400 }),
        );
      }

      await addImagesToShopifyProduct(admin, { productId, images });

      return cors(
        Response.json({
          ok: true,
          message: `Saved ${images.length} image${images.length === 1 ? "" : "s"} to the selected product.`,
        }),
      );
    }

    const productId = String(parsed.productId || "").trim();
    const instructionText = String(parsed.imageInstructions || "").trim();
    const stylePreset = String(parsed.imageStylePreset || "clean-studio").trim();
    const outputSize = String(parsed.imageOutputSize || "1024x1024").trim();
    const backgroundStyle = String(parsed.imageBackgroundStyle || "white").trim();
    const imageCount = normalizeImageCount(parsed.imageCount);
    const files = Array.isArray(parsed.productImages) ? parsed.productImages : [];

    if (!productId) {
      return cors(Response.json({ error: "Product id is required." }, { status: 400 }));
    }

    if (!files.length) {
      return cors(
        Response.json({ error: "Upload at least one source image first." }, { status: 400 }),
      );
    }

    const sourceImages = await serializeUploadedImages(files);

    if (!sourceImages.length) {
      return cors(
        Response.json({ error: "Uploaded images were invalid." }, { status: 400 }),
      );
    }

    const response = await fetch(`${backend.baseUrl}/generate-product-images`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backend.extensionToken ? { "x-extension-token": backend.extensionToken } : {}),
      },
      body: JSON.stringify({
        clientId: toClientId(session.shop),
        instructionText,
        stylePreset,
        outputSize,
        backgroundStyle,
        imageCount,
        sourceImages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Backend image generation failed.");
    }

    return cors(
      Response.json({
        ok: true,
        message: data.message || "Images generated successfully.",
        images: data.images || [],
        imageUsage: {
          count: Number(data?.imageUsage?.count || 0),
          limit: Number(data?.imageUsage?.limit || 0),
          remaining: Math.max(
            0,
            Number(data?.imageUsage?.limit || 0) - Number(data?.imageUsage?.count || 0),
          ),
          period: data?.imageUsage?.period || "",
        },
      }),
    );
  } catch (error) {
    return cors(
      Response.json(
        { error: error?.message || "Could not process product image generation." },
        { status: 500 },
      ),
    );
  }
};

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

async function parseRequestPayload(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const payload = await request.json();
    return {
      intent: String(payload.intent || "").trim().toLowerCase(),
      productId: payload.productId,
      images: payload.images,
    };
  }

  const formData = await request.formData();

  return {
    intent: String(formData.get("intent") || "generate").trim().toLowerCase(),
    productId: String(formData.get("productId") || "").trim(),
    imageInstructions: String(formData.get("imageInstructions") || "").trim(),
    imageStylePreset: String(formData.get("imageStylePreset") || "").trim(),
    imageOutputSize: String(formData.get("imageOutputSize") || "").trim(),
    imageBackgroundStyle: String(formData.get("imageBackgroundStyle") || "").trim(),
    imageCount: String(formData.get("imageCount") || "1").trim(),
    productImages: formData
      .getAll("productImages")
      .filter((value) => value && typeof value === "object"),
  };
}

function normalizeImageCount(value) {
  const parsed = Number.parseInt(String(value || "1"), 10);
  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.min(4, Math.max(1, parsed));
}

async function serializeUploadedImages(files) {
  const uploads = [];

  for (const file of files) {
    if (!file?.name || !file?.type) {
      continue;
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString("base64");
    const extension = inferExtension(file.type, file.name);

    uploads.push({
      fileName: file.name,
      mimeType: file.type,
      extension,
      base64,
    });
  }

  return uploads;
}

function inferExtension(mimeType, fallbackName) {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  const fallback = String(fallbackName || "").split(".").pop();
  return fallback || "png";
}

async function addImagesToShopifyProduct(admin, { productId, images }) {
  const mediaInputs = (images || [])
    .filter((image) => Boolean(image?.dataUrl))
    .map((image, index) => ({
      mediaContentType: "IMAGE",
      originalSource: image.dataUrl,
      alt: image.alt || `Generated product image ${index + 1}`,
    }));

  if (!mediaInputs.length) {
    throw new Error("No generated images are available to save.");
  }

  const response = await admin.graphql(
    `#graphql
      mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          mediaUserErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        productId,
        media: mediaInputs,
      },
    },
  );
  const payload = await response.json();
  const mediaUserErrors = payload?.data?.productCreateMedia?.mediaUserErrors || [];

  if (mediaUserErrors.length > 0) {
    throw new Error(mediaUserErrors[0]?.message || "Shopify rejected the generated images.");
  }
}
