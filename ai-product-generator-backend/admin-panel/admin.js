const loginCard = document.getElementById("loginCard");
const dashboard = document.getElementById("dashboard");
const adminTokenInput = document.getElementById("adminToken");
const loginButton = document.getElementById("loginBtn");
const logoutButton = document.getElementById("logoutBtn");
const refreshButton = document.getElementById("refreshBtn");

const storesTabButton = document.getElementById("tabStores");
const requestsTabButton = document.getElementById("tabRequests");
const storesView = document.getElementById("storesView");
const requestsView = document.getElementById("requestsView");

const subscriptionSearchInput = document.getElementById("subscriptionSearch");
const storesListElement = document.getElementById("storesList");
const storeDetailsElement = document.getElementById("storeDetails");
const requestsList = document.getElementById("requestsList");
const auditLogsList = document.getElementById("auditLogsList");
const statusFilterButtons = Array.from(document.querySelectorAll(".statusTab"));
const requestSearchInput = document.getElementById("requestSearch");
const requestSortSelect = document.getElementById("requestSort");
const requestPageSizeSelect = document.getElementById("requestPageSize");
const storeSortSelect = document.getElementById("storeSort");
const storePageSizeSelect = document.getElementById("storePageSize");

const statusElement = document.getElementById("status");
const pendingCountElement = document.getElementById("pendingCount");
const approvedCountElement = document.getElementById("approvedCount");
const activeShopsElement = document.getElementById("activeShops");
const totalUsageElement = document.getElementById("totalUsage");
const paymentInstructionsElement = document.getElementById("paymentInstructions");
const supportContactElement = document.getElementById("supportContact");
const metricGenerationSuccessElement = document.getElementById("metricGenerationSuccess");
const metricTimeoutRateElement = document.getElementById("metricTimeoutRate");
const metricAvgResponseElement = document.getElementById("metricAvgResponse");
const metricSaveSuccessElement = document.getElementById("metricSaveSuccess");

const STORAGE_KEY = "shopify_ai_admin_token";

let availablePlans = [];
let subscriptionsCache = [];
let requestsCache = [];
let catalogJobsCache = [];
let activeView = "stores";
let requestStatusFilter = "pending";
let selectedShopId = null;
let storePage = 1;
let requestPage = 1;
let auditLogsCache = [];

initialize();

loginButton.addEventListener("click", async () => {
  const token = adminTokenInput.value.trim();

  if (!token) {
    setStatus("Enter the admin token first.");
    return;
  }

  localStorage.setItem(STORAGE_KEY, token);
  await loadDashboard();
});

logoutButton.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  loginCard.classList.remove("hidden");
  dashboard.classList.add("hidden");
  adminTokenInput.value = "";

  subscriptionsCache = [];
  requestsCache = [];
  catalogJobsCache = [];
  selectedShopId = null;

  storesListElement.innerHTML = "";
  storeDetailsElement.innerHTML = "";
  requestsList.innerHTML = "";
  auditLogsList.innerHTML = "";
  subscriptionSearchInput.value = "";
  setStatus("Logged out.");
});

refreshButton.addEventListener("click", async () => {
  await loadDashboard();
});

storesTabButton.addEventListener("click", () => {
  switchView("stores");
});

requestsTabButton.addEventListener("click", () => {
  switchView("requests");
});

subscriptionSearchInput.addEventListener("input", () => {
  storePage = 1;
  renderStoresList();
});

storeSortSelect.addEventListener("change", () => {
  storePage = 1;
  renderStoresList();
});

storePageSizeSelect.addEventListener("change", () => {
  storePage = 1;
  renderStoresList();
});

requestSearchInput.addEventListener("input", () => {
  requestPage = 1;
  renderRequests(requestsCache);
});

requestSortSelect.addEventListener("change", () => {
  requestPage = 1;
  renderRequests(requestsCache);
});

requestPageSizeSelect.addEventListener("change", () => {
  requestPage = 1;
  renderRequests(requestsCache);
});

statusFilterButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    requestStatusFilter = button.dataset.status || "";
    requestPage = 1;
    statusFilterButtons.forEach((currentButton) => {
      currentButton.classList.toggle("active", currentButton === button);
    });
    await loadRequests();
  });
});

window.handlePlanRequestActionFromButton = async function handlePlanRequestActionFromButton(
  button,
  action,
  requestId,
) {
  const form = button.closest(".requestActionForm");
  const notesField = form?.querySelector("textarea");
  const adminNotes = notesField?.value?.trim() || "";
  const buttons = form?.querySelectorAll("button") || [];

  setStatus(`${action === "approve" ? "Approving" : "Rejecting"} request...`);

  buttons.forEach((currentButton) => {
    currentButton.disabled = true;
  });

  try {
    await handleRequestAction(action, requestId, adminNotes);
  } finally {
    buttons.forEach((currentButton) => {
      currentButton.disabled = false;
    });
  }
};

window.handleSubscriptionOverride = async function handleSubscriptionOverride() {
  const token = localStorage.getItem(STORAGE_KEY) || "";
  const form = document.getElementById("storeOverrideForm");
  const planName = form?.querySelector('[name="overridePlanName"]')?.value || "";
  const billingInterval =
    form?.querySelector('[name="overrideBillingInterval"]')?.value || "monthly";

  if (!selectedShopId) {
    setStatus("Select a store first.");
    return;
  }

  if (!planName) {
    setStatus("Choose a plan before overriding the subscription.");
    return;
  }

  setStatus("Updating subscription...");

  try {
    const response = await fetch(`/admin/api/subscriptions/${selectedShopId}/override`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token,
      },
      body: JSON.stringify({ planName, billingInterval }),
    });
    const data = await parseApiResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Subscription override failed.");
    }

    await loadDashboard();
    setStatus(data.message || "Subscription updated.");
  } catch (error) {
    setStatus(error.message || "Subscription override failed.");
  }
};

window.selectStoreById = function selectStoreById(shopId) {
  const parsedId = Number(shopId);
  if (!Number.isFinite(parsedId)) {
    return;
  }

  selectedShopId = parsedId;
  renderStoresList();
  renderStoreDetails();
};

window.changeStorePage = function changeStorePage(delta) {
  storePage = Math.max(1, storePage + Number(delta || 0));
  renderStoresList();
};

window.changeRequestPage = function changeRequestPage(delta) {
  requestPage = Math.max(1, requestPage + Number(delta || 0));
  renderRequests(requestsCache);
};

async function initialize() {
  const savedToken = localStorage.getItem(STORAGE_KEY) || "";
  adminTokenInput.value = savedToken;

  if (savedToken) {
    await loadDashboard();
  }
}

async function loadDashboard() {
  const token = localStorage.getItem(STORAGE_KEY) || adminTokenInput.value.trim();

  if (!token) {
    return;
  }

  setStatus("Loading admin dashboard...");

  try {
    const response = await fetch("/admin/api/dashboard", {
      headers: {
        "x-admin-token": token,
      },
    });
    const data = await parseApiResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Could not load the admin dashboard.");
    }

    loginCard.classList.add("hidden");
    dashboard.classList.remove("hidden");

    pendingCountElement.textContent = formatNumber(data.summary?.pendingRequests);
    approvedCountElement.textContent = formatNumber(data.summary?.approvedRequests);
    activeShopsElement.textContent = formatNumber(data.summary?.activeShops);
    totalUsageElement.textContent = formatNumber(data.summary?.totalUsageEvents);

    paymentInstructionsElement.textContent = data.paymentInstructions || "";
    supportContactElement.textContent = data.supportContact || "";

    availablePlans = data.plans || [];

    await Promise.all([
      loadSubscriptions(),
      loadRequests(),
      loadCatalogJobs(),
      loadQualityMetrics(),
      loadAuditLogs(),
    ]);
    switchView(activeView);
    setStatus("Dashboard updated.");
  } catch (error) {
    loginCard.classList.remove("hidden");
    dashboard.classList.add("hidden");
    setStatus(error.message || "Could not load the admin dashboard.");
  }
}

async function loadSubscriptions() {
  const token = localStorage.getItem(STORAGE_KEY) || "";

  const response = await fetch("/admin/api/subscriptions", {
    headers: {
      "x-admin-token": token,
    },
  });
  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || "Could not load subscriptions.");
  }

  subscriptionsCache = data.subscriptions || [];

  if (!selectedShopId && subscriptionsCache.length) {
    selectedShopId = Number(subscriptionsCache[0].shop_id);
  }

  if (
    selectedShopId &&
    !subscriptionsCache.some((subscription) => Number(subscription.shop_id) === Number(selectedShopId))
  ) {
    selectedShopId = subscriptionsCache.length ? Number(subscriptionsCache[0].shop_id) : null;
  }

  renderStoresList();
  renderStoreDetails();
}

async function loadRequests() {
  const token = localStorage.getItem(STORAGE_KEY) || "";
  const query = requestStatusFilter
    ? `?status=${encodeURIComponent(requestStatusFilter)}`
    : "";

  const response = await fetch(`/admin/api/plan-requests${query}`, {
    headers: {
      "x-admin-token": token,
    },
  });
  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || "Could not load plan requests.");
  }

  requestsCache = data.requests || [];
  renderRequests(requestsCache);
  renderStoreDetails();
}

async function loadCatalogJobs() {
  const token = localStorage.getItem(STORAGE_KEY) || "";

  const response = await fetch("/admin/api/catalog-jobs", {
    headers: {
      "x-admin-token": token,
    },
  });
  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || "Could not load catalog jobs.");
  }

  catalogJobsCache = data.jobs || [];
  renderStoreDetails();
}

async function loadQualityMetrics() {
  const token = localStorage.getItem(STORAGE_KEY) || "";
  const response = await fetch("/admin/api/quality-metrics", {
    headers: {
      "x-admin-token": token,
    },
  });
  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || "Could not load quality metrics.");
  }

  const metrics = data.metrics || {};
  metricGenerationSuccessElement.textContent = `Generation success: ${formatNumber(metrics.generationSuccessRate)}%`;
  metricTimeoutRateElement.textContent = `Timeout rate: ${formatNumber(metrics.timeoutRate)}%`;
  metricAvgResponseElement.textContent = `Avg response: ${formatNumber(metrics.averageResponseMs)} ms`;
  metricSaveSuccessElement.textContent = `Save-to-product success: ${formatNumber(metrics.saveToProductSuccessRate)}%`;
}

async function loadAuditLogs() {
  const token = localStorage.getItem(STORAGE_KEY) || "";
  const response = await fetch("/admin/api/audit-logs", {
    headers: {
      "x-admin-token": token,
    },
  });
  const data = await parseApiResponse(response);

  if (!response.ok) {
    throw new Error(data.error || "Could not load admin audit logs.");
  }

  auditLogsCache = data.logs || [];
  renderAuditLogs(auditLogsCache);
}

function switchView(view) {
  activeView = view;

  const isStoresView = view === "stores";
  storesTabButton.classList.toggle("active", isStoresView);
  requestsTabButton.classList.toggle("active", !isStoresView);

  storesView.classList.toggle("hidden", !isStoresView);
  requestsView.classList.toggle("hidden", isStoresView);
}

function renderStoresList() {
  const query = (subscriptionSearchInput.value || "").trim().toLowerCase();
  const sortBy = storeSortSelect?.value || "name_asc";
  const pageSize = Math.max(1, Number(storePageSizeSelect?.value || 12));

  const filteredStores = subscriptionsCache.filter((subscription) => {
    if (!query) {
      return true;
    }

    const haystack = `${subscription.display_name || ""} ${subscription.client_id || ""}`.toLowerCase();
    return haystack.includes(query);
  });

  const sortedStores = [...filteredStores].sort((left, right) => {
    if (sortBy === "name_desc") {
      return String(right.display_name || right.client_id || "").localeCompare(
        String(left.display_name || left.client_id || ""),
      );
    }
    if (sortBy === "plan_desc") {
      return Number(right.price_cents || 0) - Number(left.price_cents || 0);
    }
    if (sortBy === "updated_desc") {
      return new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime();
    }
    return String(left.display_name || left.client_id || "").localeCompare(
      String(right.display_name || right.client_id || ""),
    );
  });

  if (!sortedStores.length) {
    storesListElement.innerHTML = "<p class='muted'>No stores matched this search.</p>";
    return;
  }

  const totalPages = Math.max(1, Math.ceil(sortedStores.length / pageSize));
  storePage = Math.min(totalPages, Math.max(1, storePage));
  const pageStart = (storePage - 1) * pageSize;
  const pageItems = sortedStores.slice(pageStart, pageStart + pageSize);

  storesListElement.innerHTML = pageItems
    .map((store) => {
      const isSelected = Number(store.shop_id) === Number(selectedShopId);
      return `
        <button
          type="button"
          class="storeListItem ${isSelected ? "selected" : ""}"
          onclick="window.selectStoreById('${escapeAttribute(store.shop_id)}')"
        >
          <span class="storeName">${escapeHtml(store.display_name || store.client_id)}</span>
          <span class="storeDomain">${escapeHtml(store.client_id || "")}</span>
          <span class="storePlan">${escapeHtml(store.plan_name || "free")} | ${escapeHtml(formatBillingInterval(store.billing_interval))}</span>
        </button>
      `;
    })
    .join("")
    + renderPaginationControls({
      currentPage: storePage,
      totalPages,
      onPrevious: "window.changeStorePage(-1)",
      onNext: "window.changeStorePage(1)",
    });
}

function renderStoreDetails() {
  const subscription = subscriptionsCache.find(
    (item) => Number(item.shop_id) === Number(selectedShopId),
  );

  if (!subscription) {
    storeDetailsElement.className = "storeDetails emptyState";
    storeDetailsElement.textContent = "Select a store to see details.";
    return;
  }

  const relatedRequests = requestsCache.filter(
    (request) => Number(request.shop_id) === Number(subscription.shop_id),
  );
  const latestRequest = relatedRequests[0] || null;

  const relatedJobs = catalogJobsCache
    .filter((job) => String(job.client_id || "") === String(subscription.client_id || ""))
    .slice(0, 3);

  storeDetailsElement.className = "storeDetails";
  storeDetailsElement.innerHTML = `
    <div class="detailHeader">
      <h3>${escapeHtml(subscription.display_name || subscription.client_id)}</h3>
      <span class="pill ${getSubscriptionPillClass(subscription)}">${escapeHtml(subscription.status || "active")}</span>
    </div>

    <p><strong>Store:</strong> ${escapeHtml(subscription.client_id || "")}</p>
    <p><strong>Plan:</strong> ${escapeHtml(subscription.plan_name || "free")}</p>
    <p><strong>Billing:</strong> ${escapeHtml(formatBillingInterval(subscription.billing_interval))}</p>
    <p><strong>Monthly limit:</strong> ${formatNumber(subscription.monthly_generation_limit)} generations</p>
    <p><strong>Plan window:</strong> ${formatDate(subscription.current_period_start)} to ${formatDate(subscription.current_period_end)}</p>
    <p><strong>Latest contact:</strong> ${escapeHtml(subscription.latest_contact_name || "Not provided")} | ${escapeHtml(subscription.latest_contact_channel || "Not provided")}</p>
    <p><strong>Latest payment ref:</strong> ${escapeHtml(subscription.latest_payment_reference || "Not provided")}</p>

    <div class="detailSection">
      <h4>Latest request</h4>
      ${
        latestRequest
          ? `<p><strong>${escapeHtml(latestRequest.requested_plan_name || "Unknown plan")}</strong> | <span class="pill ${escapeAttribute(latestRequest.status || "pending")}">${escapeHtml(latestRequest.status || "pending")}</span></p>
             <p class="muted">Created ${formatDate(latestRequest.created_at)}</p>
             <p class="muted">${escapeHtml(latestRequest.customer_notes || "No customer notes.")}</p>`
          : "<p class='muted'>No requests found for this store in the current filter.</p>"
      }
    </div>

    <div class="detailSection">
      <h4>Recent catalog jobs</h4>
      ${
        relatedJobs.length
          ? relatedJobs
              .map(
                (job) =>
                  `<p><strong>${escapeHtml(job.job_type || "catalog")}</strong> | ${escapeHtml(job.status || "queued")} | ${formatDate(job.created_at)}</p>`,
              )
              .join("")
          : "<p class='muted'>No recent catalog jobs.</p>"
      }
    </div>

    <form id="storeOverrideForm" class="requestActionForm">
      <h4>Override subscription</h4>
      <div class="requestButtons">
        <select name="overridePlanName">
          ${availablePlans
            .map(
              (plan) =>
                `<option value="${escapeAttribute(plan.name)}"${plan.name === subscription.plan_name ? " selected" : ""}>${escapeHtml(plan.name)}</option>`,
            )
            .join("")}
        </select>
        <select name="overrideBillingInterval">
          <option value="monthly"${subscription.billing_interval === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="yearly"${subscription.billing_interval === "yearly" ? " selected" : ""}>Yearly</option>
        </select>
        <button type="button" onclick="window.handleSubscriptionOverride()">Override plan</button>
      </div>
    </form>
  `;
}

function renderRequests(requests) {
  const searchQuery = (requestSearchInput?.value || "").trim().toLowerCase();
  const sortBy = requestSortSelect?.value || "newest";
  const pageSize = Math.max(1, Number(requestPageSizeSelect?.value || 12));

  const filteredRequests = (requests || []).filter((request) => {
    if (!searchQuery) {
      return true;
    }

    const haystack = `
      ${request.display_name || ""}
      ${request.client_id || ""}
      ${request.contact_name || ""}
      ${request.payment_reference || ""}
    `.toLowerCase();
    return haystack.includes(searchQuery);
  });

  const sortedRequests = [...filteredRequests].sort((left, right) => {
    if (sortBy === "oldest") {
      return new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime();
    }
    if (sortBy === "name_asc") {
      return String(left.display_name || left.client_id || "").localeCompare(
        String(right.display_name || right.client_id || ""),
      );
    }
    return new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime();
  });

  if (!sortedRequests.length) {
    requestsList.innerHTML = "<p class='muted'>No plan requests found for this filter.</p>";
    return;
  }

  const totalPages = Math.max(1, Math.ceil(sortedRequests.length / pageSize));
  requestPage = Math.min(totalPages, Math.max(1, requestPage));
  const pageStart = (requestPage - 1) * pageSize;
  const pageItems = sortedRequests.slice(pageStart, pageStart + pageSize);

  requestsList.innerHTML = pageItems
    .map(
      (request) => `
        <article class="requestCard">
          <div class="requestMeta">
            <div>
              <span class="pill ${escapeAttribute(request.status || "pending")}">${escapeHtml(request.status || "pending")}</span>
              <h3>${escapeHtml(request.display_name || request.client_id)}</h3>
              <p class="muted">${escapeHtml(request.client_id || "")}</p>
            </div>
            <div>
              <p><strong>${escapeHtml(request.current_plan_name || "free")}</strong> to <strong>${escapeHtml(request.requested_plan_name || "unknown")}</strong></p>
              <p class="muted">${escapeHtml(formatBillingInterval(request.billing_interval))}</p>
              <p class="muted">Requested ${formatDate(request.created_at)}</p>
            </div>
          </div>
          <p><strong>Contact:</strong> ${escapeHtml(request.contact_name || "Not provided")} | ${escapeHtml(request.contact_channel || "Not provided")}</p>
          <p><strong>Payment:</strong> ${escapeHtml(request.payment_method || "Not provided")} | Ref: ${escapeHtml(request.payment_reference || "Not provided")}</p>
          <div class="requestNotes">
            <strong>Customer notes</strong>
            <p>${escapeHtml(request.customer_notes || "No customer notes.")}</p>
            <strong>Admin notes</strong>
            <p>${escapeHtml(request.admin_notes || "No admin notes yet.")}</p>
          </div>
          ${renderProofLink(request)}
          ${request.status === "pending" ? renderActions(request.id) : ""}
        </article>
      `,
    )
    .join("")
    + renderPaginationControls({
      currentPage: requestPage,
      totalPages,
      onPrevious: "window.changeRequestPage(-1)",
      onNext: "window.changeRequestPage(1)",
    });
}

function renderActions(requestId) {
  return `
    <form class="requestActionForm requestActions" data-request-id="${requestId}">
      <textarea id="notes-${requestId}" rows="3" placeholder="Optional admin note"></textarea>
      <div class="requestButtons">
        <button
          type="button"
          onclick="window.handlePlanRequestActionFromButton(this, 'approve', '${requestId}')"
        >
          Approve
        </button>
        <button
          type="button"
          class="reject"
          onclick="window.handlePlanRequestActionFromButton(this, 'reject', '${requestId}')"
        >
          Reject
        </button>
      </div>
    </form>
  `;
}

function renderProofLink(request) {
  if (!request.proof_data_url) {
    return "<p class='muted'>No payment proof attached.</p>";
  }

  const label = request.proof_file_name || "View uploaded proof";
  const safeDataUrl = escapeAttribute(request.proof_data_url);
  const safeLabel = escapeHtml(label);

  return `
    <div class="proofPreview">
      <strong>Payment proof</strong>
      <img class="proofImage" src="${safeDataUrl}" alt="${safeLabel}" />
      <p><a class="proofLink" href="${safeDataUrl}" target="_blank" rel="noreferrer">${safeLabel}</a></p>
    </div>
  `;
}

function renderAuditLogs(logs) {
  if (!logs.length) {
    auditLogsList.innerHTML = "<p class='muted'>No admin actions logged yet.</p>";
    return;
  }

  auditLogsList.innerHTML = logs
    .slice(0, 30)
    .map(
      (log) => `
        <article class="requestCard">
          <p><strong>${escapeHtml(log.action_type || "action")}</strong> | ${formatDate(log.created_at)}</p>
          <p class="muted">Actor: ${escapeHtml(log.admin_actor || "manual-admin")} | Store: ${escapeHtml(log.display_name || log.client_id || "N/A")}</p>
          <p class="muted">Entity: ${escapeHtml(log.entity_type || "")} #${escapeHtml(log.entity_id || "")}</p>
          <p class="muted">${escapeHtml(JSON.stringify(log.details || {}))}</p>
        </article>
      `,
    )
    .join("");
}

function renderPaginationControls({ currentPage, totalPages, onPrevious, onNext }) {
  if (totalPages <= 1) {
    return "";
  }

  return `
    <div class="requestButtons">
      <button type="button" class="secondary" onclick="${onPrevious}" ${currentPage <= 1 ? "disabled" : ""}>Previous</button>
      <span class="muted">Page ${currentPage} of ${totalPages}</span>
      <button type="button" class="secondary" onclick="${onNext}" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
    </div>
  `;
}

async function handleRequestAction(action, requestId, adminNotes) {
  const token = localStorage.getItem(STORAGE_KEY) || "";

  try {
    const response = await fetch(`/admin/api/plan-requests/${requestId}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token,
      },
      body: JSON.stringify({ adminNotes }),
    });
    const data = await parseApiResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Request update failed.");
    }

    await loadDashboard();
    setStatus(data.message || "Request updated.");
  } catch (error) {
    setStatus(error.message || "Request update failed.");
  }
}

function setStatus(message) {
  statusElement.textContent = message;
}

async function parseApiResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  const preview = text.slice(0, 200).trim();

  return {
    error: preview
      ? `Expected JSON but received ${contentType || "non-JSON response"}: ${preview}`
      : `Expected JSON but received ${contentType || "non-JSON response"}.`,
  };
}

function formatDate(value) {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return date.toLocaleString();
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString() : "0";
}

function formatBillingInterval(value) {
  return String(value || "monthly").trim().toLowerCase() === "yearly"
    ? "Yearly"
    : "Monthly";
}

function getSubscriptionPillClass(subscription) {
  if (String(subscription?.status || "").toLowerCase() === "active") {
    return "approved";
  }

  if (Number(subscription?.price_cents || 0) > 0) {
    return "approved";
  }

  return "pending";
}

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
