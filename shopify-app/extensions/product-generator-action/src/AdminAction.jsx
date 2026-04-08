import { useState } from "react";

export default function AdminAction() {
  const [status, setStatus] = useState(
    "This is the Shopify admin-action target for the product generator.",
  );

  async function handleGenerate() {
    setStatus(
      "When this extension is connected to the real Shopify app, generate the description here using the authenticated shop context.",
    );
  }

  return (
    <div style={{ padding: 16, fontFamily: "Inter, sans-serif" }}>
      <h2>AI Product Generator</h2>
      <p>
        Move the current popup flow into this admin action so merchants can run
        generation directly inside Shopify admin without a separate Chrome
        extension.
      </p>
      <button onClick={handleGenerate}>Generate Description</button>
      <p>{status}</p>
    </div>
  );
}
