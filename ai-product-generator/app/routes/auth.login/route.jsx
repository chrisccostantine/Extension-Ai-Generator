import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useLocation, useSubmit } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

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
