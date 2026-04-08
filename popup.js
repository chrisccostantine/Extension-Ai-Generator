const generateButton = document.getElementById("generateBtn");
const inspectButton = document.getElementById("inspectBtn");
const refreshStatusButton = document.getElementById("refreshStatusBtn");
const toggleRequestButton = document.getElementById("toggleRequestBtn");
const submitRequestButton = document.getElementById("submitRequestBtn");
const openAdminButton = document.getElementById("openAdminBtn");
const backendUrlInput = document.getElementById("backendUrl");
const accessTokenInput = document.getElementById("accessToken");
const planSelect = document.getElementById("planSelect");
const contactNameInput = document.getElementById("contactName");
const contactChannelInput = document.getElementById("contactChannel");
const paymentMethodInput = document.getElementById("paymentMethod");
const paymentReferenceInput = document.getElementById("paymentReference");
const requestNotesInput = document.getElementById("requestNotes");
const proofFileInput = document.getElementById("proofFile");
const requestPanel = document.getElementById("requestPanel");
const currentPlanElement = document.getElementById("currentPlan");
const usageSummaryElement = document.getElementById("usageSummary");
const requestSummaryElement = document.getElementById("requestSummary");
const paymentInstructionsElement = document.getElementById("paymentInstructions");
const statusElement = document.getElementById("status");

const DEFAULT_BACKEND_URL = "http://localhost:5000/generate-product-content";
let currentClientId = "";
let currentBackendBaseUrl = "";

initializeSettings();

generateButton.addEventListener("click", async () => {
  await runAction("generateDescription", "Generating content...");
  await loadStoreStatus();
});

inspectButton.addEventListener("click", async () => {
  await runAction("inspectEditor", "Inspecting Shopify editor...");
});

refreshStatusButton.addEventListener("click", async () => {
  await loadStoreStatus();
});

toggleRequestButton.addEventListener("click", () => {
  requestPanel.classList.toggle("hidden");
});

submitRequestButton.addEventListener("click", async () => {
  await submitPlanRequest();
});

openAdminButton.addEventListener("click", async () => {
  await saveSettings();

  if (!currentBackendBaseUrl) {
    setStatus("Set a valid backend URL first.");
    return;
  }

  chrome.tabs.create({ url: `${currentBackendBaseUrl}/admin` });
});

backendUrlInput.addEventListener("change", async () => {
  await saveSettings();
  await loadStoreStatus();
});

accessTokenInput.addEventListener("change", async () => {
  await saveSettings();
  await loadStoreStatus();
});

async function runAction(action, loadingMessage) {
  await saveSettings();
  setStatus(loadingMessage);
  setBusyState(true);

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
    setBusyState(false);
  }
}

async function loadStoreStatus() {
  setStatus("Loading store status...");

  try {
    await saveSettings();
    const settings = await getSettings();
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    currentClientId = getClientIdFromTab(tab);
    if (!currentClientId) {
      throw new Error("Open a Shopify product page to load the store plan.");
    }

    const backendUrl = normalizeBackendUrl(settings.backendUrl);
    currentBackendBaseUrl = backendUrl.origin;

    const [plansResponse, statusResponse] = await Promise.all([
      fetchJson(`${currentBackendBaseUrl}/plans`, settings.accessToken),
      fetchJson(
        `${currentBackendBaseUrl}/shop-status?clientId=${encodeURIComponent(currentClientId)}`,
        settings.accessToken,
      ),
    ]);

    renderPlans(plansResponse.plans || []);
    renderStoreStatus(statusResponse, plansResponse);
    setStatus("Store status loaded.");
  } catch (error) {
    currentPlanElement.textContent = "Unavailable";
    usageSummaryElement.textContent =
      "Could not load the current plan for this store.";
    requestSummaryElement.textContent = "";
    paymentInstructionsElement.textContent = "";
    setStatus(error.message || "Could not load store status.");
  }
}

async function submitPlanRequest() {
  setStatus("Sending upgrade request...");
  setBusyState(true);

  try {
    const settings = await getSettings();

    if (!currentClientId) {
      throw new Error("Open a Shopify product page before submitting a request.");
    }

    if (!planSelect.value) {
      throw new Error("Choose a paid plan first.");
    }

    if (!contactChannelInput.value.trim()) {
      throw new Error("Add a contact channel so you can be reached.");
    }

    const backendUrl = normalizeBackendUrl(settings.backendUrl);
    const proofFile = proofFileInput.files?.[0] || null;
    const proofDataUrl = proofFile ? await fileToDataUrl(proofFile) : "";

    const response = await fetch(`${backendUrl.origin}/plan-requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.accessToken ? { "x-extension-token": settings.accessToken } : {}),
      },
      body: JSON.stringify({
        clientId: currentClientId,
        requestedPlanName: planSelect.value,
        contactName: contactNameInput.value.trim(),
        contactChannel: contactChannelInput.value.trim(),
        paymentMethod: paymentMethodInput.value.trim(),
        paymentReference: paymentReferenceInput.value.trim(),
        notes: requestNotesInput.value.trim(),
        proofFileName: proofFile?.name || "",
        proofMimeType: proofFile?.type || "",
        proofDataUrl,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not submit the upgrade request.");
    }

    requestPanel.classList.add("hidden");
    proofFileInput.value = "";
    paymentReferenceInput.value = "";
    requestNotesInput.value = "";
    setStatus(data.message || "Upgrade request sent.");
    await loadStoreStatus();
  } catch (error) {
    setStatus(error.message || "Could not submit the upgrade request.");
  } finally {
    setBusyState(false);
  }
}

function renderPlans(plans) {
  const paidPlans = plans.filter((plan) => plan.isPaid);

  planSelect.innerHTML = paidPlans.length
    ? paidPlans
        .map(
          (plan) =>
            `<option value="${escapeHtml(plan.name)}">${escapeHtml(plan.name)} - ${formatPrice(plan.price_cents)} / month</option>`,
        )
        .join("")
    : '<option value="">No paid plans available</option>';
}

function renderStoreStatus(statusData, planData) {
  const planName = statusData.plan?.name || "free";
  currentPlanElement.textContent = planName.toUpperCase();
  usageSummaryElement.textContent = `Used ${statusData.usage?.count || 0} of ${statusData.plan?.monthly_generation_limit || 0} generations this month.`;
  paymentInstructionsElement.textContent =
    planData.paymentInstructions || statusData.paymentInstructions || "";

  if (statusData.latestRequest) {
    requestSummaryElement.textContent = `Latest request: ${statusData.latestRequest.requested_plan_name} (${statusData.latestRequest.status}).`;
  } else {
    requestSummaryElement.textContent =
      "No paid-plan request submitted yet for this store.";
  }
}

async function fetchJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      ...(accessToken ? { "x-extension-token": accessToken } : {}),
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Backend request failed.");
  }

  return data;
}

function normalizeBackendUrl(value) {
  const candidate = value?.trim() || DEFAULT_BACKEND_URL;
  const parsed = new URL(candidate);

  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/generate-product-content";
  }

  return parsed;
}

function initializeSettings() {
  chrome.storage.sync.get(
    { backendUrl: DEFAULT_BACKEND_URL, accessToken: "" },
    async (result) => {
      backendUrlInput.value = result.backendUrl || DEFAULT_BACKEND_URL;
      accessTokenInput.value = result.accessToken || "";
      await loadStoreStatus();
    },
  );
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { backendUrl: DEFAULT_BACKEND_URL, accessToken: "" },
      (result) => {
        resolve({
          backendUrl: result.backendUrl || DEFAULT_BACKEND_URL,
          accessToken: result.accessToken || "",
        });
      },
    );
  });
}

function saveSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        backendUrl: backendUrlInput.value.trim() || DEFAULT_BACKEND_URL,
        accessToken: accessTokenInput.value.trim(),
      },
      resolve,
    );
  });
}

function getClientIdFromTab(tab) {
  const url = tab?.url || "";
  const match = url.match(/\/store\/([^/]+)/i);

  if (match?.[1]) {
    return `shopify-store:${match[1].toLowerCase()}`;
  }

  return "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () =>
      reject(new Error("Could not read the selected proof file."));
    reader.readAsDataURL(file);
  });
}

function formatPrice(priceCents) {
  if (!priceCents) {
    return "Free";
  }

  return `$${(priceCents / 100).toFixed(2)}`;
}

function setBusyState(isBusy) {
  generateButton.disabled = isBusy;
  inspectButton.disabled = isBusy;
  refreshStatusButton.disabled = isBusy;
  submitRequestButton.disabled = isBusy;
}

function setStatus(message) {
  statusElement.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
