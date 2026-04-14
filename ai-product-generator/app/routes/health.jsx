export const loader = async () => {
  return Response.json({
    ok: true,
    app: "ai-product-generator",
    timestamp: new Date().toISOString(),
  });
};

export default function HealthRoute() {
  return null;
}
