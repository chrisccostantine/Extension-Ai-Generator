/* global Buffer */
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useEffect, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useLocation,
  useSubmit,
} from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }) => {
  const cookieState = readBillingStateCookie(request);
  const url = new URL(request.url);
  const queryShopParam = String(url.searchParams.get("shop") || "").trim();
  const queryHostParam = String(url.searchParams.get("host") || "").trim();
  const shopParam = String(queryShopParam || cookieState?.shop || "").trim();
  const hostParam = String(queryHostParam || cookieState?.host || "").trim();

  console.info("[auth.login.loader]", {
    pathname: url.pathname,
    search: url.search,
    shopParam,
    hostParam,
    hasBillingStateCookie: Boolean(cookieState),
    userAgent: request.headers.get("user-agent") || "",
    referer: request.headers.get("referer") || "",
  });

  if (!queryShopParam && cookieState?.shop) {
    const redirectUrl = new URL("/auth/login", url.origin);
    redirectUrl.searchParams.set("shop", shopParam);
    if (hostParam) {
      redirectUrl.searchParams.set("host", hostParam);
    }
    redirectUrl.searchParams.set("embedded", "1");
    console.info("[auth.login.loader.redirect]", {
      destination: redirectUrl.toString(),
    });
    return redirect(redirectUrl.toString(), {
      headers: {
        "Set-Cookie": clearBillingStateCookie(request),
      },
    });
  }

  if (queryShopParam) {
    return {
      errors: {},
    };
  }

  const errors = loginErrorMessage(await login(request));

  console.info("[auth.login.loader.render]", {
    errors,
  });

  return { errors };
};

export const action = async ({ request }) => {
  const url = new URL(request.url);
  const formData = await request.formData();
  const submittedShop = String(formData.get("shop") || "").trim();
  console.info("[auth.login.action]", {
    pathname: url.pathname,
    search: url.search,
    submittedShop,
    referer: request.headers.get("referer") || "",
  });

  const errors = loginErrorMessage(await login(request));

  console.info("[auth.login.action.result]", {
    errors,
  });

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const submit = useSubmit();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;
  const queryParams = new URLSearchParams(location.search);
  const shopParam = queryParams.get("shop") || "";

  useEffect(() => {
    if (!shop && shopParam) {
      setShop(shopParam);
      submit(
        { shop: shopParam },
        { method: "post", action: location.pathname + location.search },
      );
    }
  }, [shop, shopParam, submit, location.pathname, location.search]);

  return (
    <AppProvider embedded={false}>
      <s-page>
        <Form method="post">
          <s-section heading="Log in">
            <s-text-field
              name="shop"
              label="Shop domain"
              details="example.myshopify.com"
              value={shop}
              onChange={(e) => setShop(e.currentTarget.value)}
              autocomplete="on"
              error={errors.shop}
            ></s-text-field>
            <s-button type="submit">Log in</s-button>
          </s-section>
        </Form>
      </s-page>
    </AppProvider>
  );
}

function readBillingStateCookie(request) {
  const raw = request.headers.get("cookie") || "";
  const match = raw.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("billing_state="));
  if (!match) {
    return null;
  }

  const value = match.slice("billing_state=".length);
  try {
    const decoded = Buffer.from(value, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (!parsed?.shop) {
      return null;
    }
    return {
      shop: String(parsed.shop || ""),
      host: String(parsed.host || ""),
    };
  } catch (_error) {
    return null;
  }
}

function clearBillingStateCookie(request) {
  const parts = [
    "billing_state=",
    "Path=/",
    "HttpOnly",
    "SameSite=None",
    "Max-Age=0",
  ];

  if (shouldUseSecureCookie(request.url)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function shouldUseSecureCookie(requestUrl) {
  const rawUrl = String(requestUrl || "").trim();
  const appUrl = String(process.env.SHOPIFY_APP_URL || "").trim();

  return rawUrl.startsWith("https://") || appUrl.startsWith("https://");
}
