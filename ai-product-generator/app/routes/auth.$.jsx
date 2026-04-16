/* global Buffer */
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = String(url.searchParams.get("shop") || "").trim();
  const host = String(url.searchParams.get("host") || "").trim();
  console.info("[auth.loader]", {
    pathname: url.pathname,
    search: url.search,
    shop,
    host,
    embedded: url.searchParams.get("embedded") || "",
    idTokenPresent: Boolean(url.searchParams.get("id_token")),
    referer: request.headers.get("referer") || "",
    userAgent: request.headers.get("user-agent") || "",
  });

  try {
    await authenticate.admin(request);
  } catch (error) {
    if (error instanceof Response) {
      const headers = new Headers(error.headers);
      const authStateCookie = buildAuthStateCookie({
        shop,
        host,
        requestUrl: request.url,
      });

      if (authStateCookie) {
        headers.append("Set-Cookie", authStateCookie);
      }

      throw new Response(error.body, {
        status: error.status,
        statusText: error.statusText,
        headers,
      });
    }

    throw error;
  }

  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function buildAuthStateCookie({ shop, host, requestUrl }) {
  if (!shop) {
    return "";
  }

  const payload = Buffer.from(
    JSON.stringify({
      shop,
      host: host || "",
    }),
  ).toString("base64");

  const isSecure = shouldUseSecureCookie(requestUrl);
  const parts = [
    `billing_state=${payload}`,
    "Path=/",
    "HttpOnly",
    "SameSite=None",
    "Max-Age=900",
  ];

  if (isSecure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function shouldUseSecureCookie(requestUrl) {
  const rawUrl = String(requestUrl || "").trim();
  const appUrl = String(process.env.SHOPIFY_APP_URL || "").trim();

  return rawUrl.startsWith("https://") || appUrl.startsWith("https://");
}
