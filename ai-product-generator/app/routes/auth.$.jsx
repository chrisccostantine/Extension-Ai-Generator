import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  console.info("[auth.loader]", {
    pathname: url.pathname,
    search: url.search,
    shop: url.searchParams.get("shop") || "",
    host: url.searchParams.get("host") || "",
    embedded: url.searchParams.get("embedded") || "",
    idTokenPresent: Boolean(url.searchParams.get("id_token")),
    referer: request.headers.get("referer") || "",
    userAgent: request.headers.get("user-agent") || "",
  });

  await authenticate.admin(request);

  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
