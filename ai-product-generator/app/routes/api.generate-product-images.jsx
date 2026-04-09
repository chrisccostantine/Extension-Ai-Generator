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

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return cors(
        Response.json(
          { error: data.error || "Backend image generation failed." },
          { status: response.status || 500 },
        ),
      );
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
    if (!file || typeof file.arrayBuffer !== "function" || !file?.name) {
      continue;
    }

    const arrayBuffer = await file.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      continue;
    }
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString("base64");
    const mimeType = String(file.type || guessMimeTypeFromFileName(file.name) || "image/png");
    const extension = inferExtension(mimeType, file.name);

    uploads.push({
      fileName: file.name,
      dataUrl: `data:${mimeType};base64,${base64}`,
      mimeType,
      extension,
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

function guessMimeTypeFromFileName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (lower.endsWith(".png")) {
    return "image/png";
  }

  if (lower.endsWith(".webp")) {
    return "image/webp";
  }

  return "";
}

async function addImagesToShopifyProduct(admin, { productId, images }) {
  const validImages = (images || []).filter((image) => Boolean(image?.dataUrl));

  if (!validImages.length) {
    throw new Error("No generated images are available to save.");
  }

  const stagedInputs = validImages.map((image, index) => {
    const parsed = parseImageDataUrl(image.dataUrl);
    const extension = inferExtension(parsed.mimeType, "");

    return {
      filename: `generated-product-image-${Date.now()}-${index + 1}.${extension}`,
      mimeType: parsed.mimeType,
      fileSize: String(parsed.buffer.length),
      httpMethod: "POST",
      resource: "IMAGE",
    };
  });

  const stagedResponse = await admin.graphql(
    `#graphql
      mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        input: stagedInputs,
      },
    },
  );
  const stagedPayload = await stagedResponse.json();
  const stagedErrors = stagedPayload?.data?.stagedUploadsCreate?.userErrors || [];

  if (stagedErrors.length > 0) {
    throw new Error(stagedErrors[0]?.message || "Could not prepare image upload.");
  }

  const stagedTargets = stagedPayload?.data?.stagedUploadsCreate?.stagedTargets || [];

  if (stagedTargets.length !== validImages.length) {
    throw new Error("Could not prepare all generated images for upload.");
  }

  const uploadedMedia = [];

  for (let index = 0; index < validImages.length; index += 1) {
    const image = validImages[index];
    const target = stagedTargets[index];
    const parsed = parseImageDataUrl(image.dataUrl);

    const uploadFormData = new FormData();
    for (const parameter of target.parameters || []) {
      uploadFormData.append(parameter.name, parameter.value);
    }

    const fileName = stagedInputs[index].filename;
    uploadFormData.append(
      "file",
      new Blob([parsed.buffer], { type: parsed.mimeType }),
      fileName,
    );

    const uploadResponse = await fetch(target.url, {
      method: "POST",
      body: uploadFormData,
    });

    if (!uploadResponse.ok) {
      throw new Error("Could not upload generated image to Shopify.");
    }

    uploadedMedia.push({
      mediaContentType: "IMAGE",
      originalSource: target.resourceUrl,
      alt: image.alt || `Generated product image ${index + 1}`,
    });
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
        media: uploadedMedia,
      },
    },
  );
  const payload = await response.json();
  const mediaUserErrors = payload?.data?.productCreateMedia?.mediaUserErrors || [];

  if (mediaUserErrors.length > 0) {
    throw new Error(mediaUserErrors[0]?.message || "Shopify rejected the generated images.");
  }
}

function parseImageDataUrl(dataUrl) {
  const value = String(dataUrl || "").trim();
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

  if (!match) {
    throw new Error("Generated image format is invalid.");
  }

  const mimeType = match[1];
  const base64Payload = match[2];
  const buffer = Buffer.from(base64Payload, "base64");

  if (!buffer.length) {
    throw new Error("Generated image is empty.");
  }

  return { mimeType, buffer };
}
