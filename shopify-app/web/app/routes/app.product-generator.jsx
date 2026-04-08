export const loader = async () => {
  return null;
};

export default function ProductGeneratorRoute() {
  return (
    <main style={{ padding: "24px", fontFamily: "Inter, sans-serif" }}>
      <h1>AI Product Generator</h1>
      <p>
        This route is the embedded-app target for the current extension
        workflow. When the real Shopify app is bootstrapped with Shopify CLI,
        move the current plan status, generation, and manual-upgrade request UI
        into this route or into an admin action extension.
      </p>
      <section style={{ marginTop: "24px" }}>
        <h2>Backend contract</h2>
        <ul>
          <li>`GET /shop-status`</li>
          <li>`GET /plans`</li>
          <li>`POST /plan-requests`</li>
          <li>`POST /generate-product-content`</li>
        </ul>
      </section>
    </main>
  );
}
