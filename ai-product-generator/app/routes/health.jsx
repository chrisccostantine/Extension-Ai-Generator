import { json } from "react-router";

export const loader = async () => {
  return json({
    ok: true,
    app: "ai-product-generator",
    timestamp: new Date().toISOString(),
  });
};

export default function HealthRoute() {
  return null;
}
