import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
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
    const url = new URL(request.url);
    const productId = String(url.searchParams.get("productId") || "").trim();

    if (!productId) {
      return cors(
        Response.json({ error: "Product id is required." }, { status: 400 }),
      );
    }

    const productResponse = await admin.graphql(
      `#graphql
        query ProductTitle($id: ID!) {
          product(id: $id) {
            id
            title
          }
        }
      `,
      { variables: { id: productId } },
    );
    const productJson = await productResponse.json();
    const product = productJson?.data?.product;

    if (!product?.title) {
      return cors(
        Response.json(
          { error: "Could not load the selected product title." },
          { status: 404 },
        ),
      );
    }

    const clientId = toClientId(session.shop);
    const generated = await fetchBackendGeneratedContent({
      backend,
      title: product.title,
      clientId,
    });
    const descriptionHtml = buildDescriptionHtml(generated);

    const updateResponse = await admin.graphql(
      `#graphql
        mutation UpdateProductDescription($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product {
              id
              title
              descriptionHtml
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
          product: {
            id: productId,
            descriptionHtml,
          },
        },
      },
    );
    const updateJson = await updateResponse.json();
    const userErrors = updateJson?.data?.productUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      return cors(
        Response.json(
          {
            error: userErrors[0]?.message || "Shopify rejected the update.",
          },
          { status: 422 },
        ),
      );
    }

    return cors(
      Response.json({
        ok: true,
        productTitle: product.title,
        description: generated.description,
        highlights: generated.highlights,
        composition: generated.composition,
      }),
    );
  } catch (error) {
    return cors(
      Response.json(
        { error: error?.message || "Could not generate the product description." },
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

async function fetchBackendGeneratedContent({ backend, title, clientId }) {
  const response = await fetch(`${backend.baseUrl}/generate-product-content`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(backend.extensionToken
        ? { "x-extension-token": backend.extensionToken }
        : {}),
    },
    body: JSON.stringify({ title, clientId }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Backend generation failed.");
  }

  return data;
}

function buildDescriptionHtml(data) {
  return [
    `<p>${escapeHtml(data.description)}</p>`,
    "<p><strong>Highlights:</strong></p>",
    `<ul>${(data.highlights || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`,
    "<p><strong>Composition:</strong></p>",
    ...(data.composition || []).map((item) => `<p>${escapeHtml(item)}</p>`),
  ].join("");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
