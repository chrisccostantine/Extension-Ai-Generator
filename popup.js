const generateButton = document.getElementById("generateBtn");
const inspectButton = document.getElementById("inspectBtn");
const backendUrlInput = document.getElementById("backendUrl");
const statusElement = document.getElementById("status");
const DEFAULT_BACKEND_URL = "http://localhost:5000/generate-product-content";

initializeSettings();

generateButton.addEventListener("click", async () => {
  await runAction("generateDescription", "Generating content...");
});

inspectButton.addEventListener("click", async () => {
  await runAction("inspectEditor", "Inspecting Shopify editor...");
});

async function runAction(action, loadingMessage) {
  await saveSettings();
  setStatus(loadingMessage);
  generateButton.disabled = true;
  inspectButton.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.id) {
      throw new Error("No active tab found.");
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action });
    setStatus(response?.message || "Request completed.");

    if (response?.diagnostics) {
      console.log("Shopify editor diagnostics:", response.diagnostics);
    }
  } catch (error) {
    const fallbackMessage = error?.message?.includes(
      "Receiving end does not exist",
    )
      ? "Open a Shopify admin product page, then try again."
      : error?.message || "Request failed.";

    setStatus(fallbackMessage);
    console.error("Popup request failed:", error);
  } finally {
    generateButton.disabled = false;
    inspectButton.disabled = false;
  }
}

function setStatus(message) {
  statusElement.textContent = message;
}

function initializeSettings() {
  chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND_URL }, (result) => {
    backendUrlInput.value = result.backendUrl || DEFAULT_BACKEND_URL;
  });
}

function saveSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        backendUrl: backendUrlInput.value.trim() || DEFAULT_BACKEND_URL,
      },
      resolve,
    );
  });
}
