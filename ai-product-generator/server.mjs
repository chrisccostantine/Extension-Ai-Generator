import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { createRequestHandler } from "@react-router/express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const mode = process.env.NODE_ENV || "production";
const buildPath = path.resolve(__dirname, "build/server/index.js");
const assetsBuildDirectory = path.resolve(__dirname, "build/client");

let buildModule = null;
let startupError = null;

try {
  buildModule = await import(pathToFileURL(buildPath).href);
  console.info("[bootstrap] Server build loaded", {
    buildPath,
    port,
    host,
    mode,
  });
} catch (error) {
  startupError = error;
  console.error("[bootstrap] Failed to load server build", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : "",
    buildPath,
    port,
    host,
    mode,
    hasShopifyApiKey: Boolean(process.env.SHOPIFY_API_KEY),
    hasShopifyApiSecret: Boolean(process.env.SHOPIFY_API_SECRET),
    shopifyAppUrl: process.env.SHOPIFY_APP_URL || "",
    scopes: process.env.SCOPES || "",
    nodeEnv: process.env.NODE_ENV || "",
  });
}

const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: startupError === null,
    appLoaded: buildModule !== null,
    message:
      startupError === null
        ? "Server process is running."
        : "Server process is running, but the app build failed to load.",
    error: startupError ? (startupError.message || String(startupError)) : null,
    hasShopifyApiKey: Boolean(process.env.SHOPIFY_API_KEY),
    hasShopifyApiSecret: Boolean(process.env.SHOPIFY_API_SECRET),
    shopifyAppUrl: process.env.SHOPIFY_APP_URL || "",
    scopes: process.env.SCOPES || "",
  });
});

app.use(
  "/assets",
  express.static(path.join(assetsBuildDirectory, "assets"), {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(express.static(assetsBuildDirectory));
app.use(express.static(path.resolve(__dirname, "public"), { maxAge: "1h" }));

if (buildModule) {
  app.all(
    "*",
    createRequestHandler({
      build: buildModule,
      mode,
    }),
  );
} else {
  app.all("*", (_req, res) => {
    res.status(500).json({
      error: "Application failed to initialize.",
      detail: startupError ? startupError.message || String(startupError) : "Unknown startup error.",
    });
  });
}

app.listen(port, host, () => {
  console.info("[bootstrap] Listening", { host, port, mode });
});
