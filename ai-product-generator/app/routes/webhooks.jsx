import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, payload);

  if (topic === "SHOP_REDACT" || topic === "APP_UNINSTALLED") {
    await db.session.deleteMany({ where: { shop } });
  }

  if (topic === "APP_SCOPES_UPDATE" && session && payload?.current) {
    await db.session
      .update({
        where: { id: session.id },
        data: { scope: String(payload.current) },
      })
      .catch(() => {});
  }

  return new Response();
};
