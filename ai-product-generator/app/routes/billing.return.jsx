/* global Buffer */
import { redirect } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = String(url.searchParams.get("shop") || "").trim();
  const host = String(url.searchParams.get("host") || "").trim();
  const embedded = String(url.searchParams.get("embedded") || "1").trim() || "1";
  const chargeId = String(url.searchParams.get("charge_id") || "").trim();

  console.info("[billing.return.loader]", {
    pathname: url.pathname,
    search: url.search,
    shop,
    host,
    embedded,
    chargeId,
    referer: request.headers.get("referer") || "",
    userAgent: request.headers.get("user-agent") || "",
  });

  const redirectUrl = new URL("/auth", url.origin);
  if (shop) {
    redirectUrl.searchParams.set("shop", shop);
  }
  if (host) {
    redirectUrl.searchParams.set("host", host);
  }
  redirectUrl.searchParams.set("embedded", embedded);

  const headers = new Headers();
  const billingStateCookie = buildBillingStateCookie({
    shop,
    host,
    requestUrl: request.url,
  });
  if (billingStateCookie) {
    headers.append("Set-Cookie", billingStateCookie);
  }

  return redirect(redirectUrl.toString(), { headers });
};

function buildBillingStateCookie({ shop, host, requestUrl }) {
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
