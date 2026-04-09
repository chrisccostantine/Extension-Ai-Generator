const loginCard = document.getElementById("loginCard");
const dashboard = document.getElementById("dashboard");
const adminTokenInput = document.getElementById("adminToken");
const loginButton = document.getElementById("loginBtn");
const logoutButton = document.getElementById("logoutBtn");
const refreshButton = document.getElementById("refreshBtn");
const statusFilter = document.getElementById("statusFilter");
const requestsList = document.getElementById("requestsList");
const subscriptionsList = document.getElementById("subscriptionsList");
const statusElement = document.getElementById("status");

const pendingCountElement = document.getElementById("pendingCount");
const approvedCountElement = document.getElementById("approvedCount");
const activeShopsElement = document.getElementById("activeShops");
const totalUsageElement = document.getElementById("totalUsage");
const paymentInstructionsElement = document.getElementById(
  "paymentInstructions",
);
const supportContactElement = document.getElementById("supportContact");

const STORAGE_KEY = "shopify_ai_admin_token";

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
  requestsList.innerHTML = "";
  subscriptionsList.innerHTML = "";
  setStatus("Logged out.");
});

refreshButton.addEventListener("click", async () => {
  await loadDashboard();
});

statusFilter.addEventListener("change", async () => {
  await loadRequests();
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

  setStatus("Loading dashboard...");

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
    pendingCountElement.textContent = data.summary.pendingRequests;
    approvedCountElement.textContent = data.summary.approvedRequests;
    activeShopsElement.textContent = data.summary.activeShops;
    totalUsageElement.textContent = data.summary.totalUsageEvents;
    paymentInstructionsElement.textContent = data.paymentInstructions;
    supportContactElement.textContent = data.supportContact;

    await loadRequests();
    await loadSubscriptions();
    setStatus("Dashboard updated.");
  } catch (error) {
    loginCard.classList.remove("hidden");
    dashboard.classList.add("hidden");
    setStatus(error.message || "Could not load the admin dashboard.");
  }
}

async function loadRequests() {
  const token = localStorage.getItem(STORAGE_KEY) || "";
  const filter = statusFilter.value;
  const query = filter ? `?status=${encodeURIComponent(filter)}` : "";

  try {
    const response = await fetch(`/admin/api/plan-requests${query}`, {
      headers: {
        "x-admin-token": token,
      },
    });
    const data = await parseApiResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Could not load plan requests.");
    }

    renderRequests(data.requests || []);
  } catch (error) {
    requestsList.innerHTML = "";
    setStatus(error.message || "Could not load plan requests.");
  }
}

async function loadSubscriptions() {
  const token = localStorage.getItem(STORAGE_KEY) || "";

  try {
    const response = await fetch("/admin/api/subscriptions", {
      headers: {
        "x-admin-token": token,
      },
    });
    const data = await parseApiResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Could not load subscriptions.");
    }

    renderSubscriptions(data.subscriptions || []);
  } catch (error) {
    subscriptionsList.innerHTML = "";
    setStatus(error.message || "Could not load subscriptions.");
  }
}

function renderRequests(requests) {
  if (!requests.length) {
    requestsList.innerHTML = "<p class='muted'>No plan requests found for this filter.</p>";
    return;
  }

  requestsList.innerHTML = requests
    .map(
      (request) => `
        <article class="requestCard">
          <div class="requestMeta">
            <div>
              <span class="pill ${request.status}">${request.status}</span>
              <h3>${escapeHtml(request.display_name || request.client_id)}</h3>
              <p class="muted">${escapeHtml(request.client_id)}</p>
            </div>
            <div>
              <p><strong>${escapeHtml(request.current_plan_name || "free")}</strong> to <strong>${escapeHtml(request.requested_plan_name)}</strong></p>
              <p class="muted">Requested ${formatDate(request.created_at)}</p>
            </div>
          </div>
          <p><strong>Contact:</strong> ${escapeHtml(request.contact_name || "Not provided")} | ${escapeHtml(request.contact_channel || "Not provided")}</p>
          <p><strong>Payment:</strong> ${escapeHtml(request.payment_method || "Not provided")} | Ref: ${escapeHtml(request.payment_reference || "Not provided")}</p>
          <div class="requestNotes">
            <strong>Customer Notes</strong>
            <p>${escapeHtml(request.customer_notes || "No customer notes.")}</p>
            <strong>Admin Notes</strong>
            <p>${escapeHtml(request.admin_notes || "No admin notes yet.")}</p>
          </div>
          ${renderProofLink(request)}
          ${request.status === "pending" ? renderActions(request.id) : ""}
        </article>
      `,
    )
    .join("");
}

function renderSubscriptions(subscriptions) {
  if (!subscriptions.length) {
    subscriptionsList.innerHTML =
      "<p class='muted'>No subscriptions found yet.</p>";
    return;
  }

  subscriptionsList.innerHTML = subscriptions
    .map(
      (subscription) => `
        <article class="requestCard">
          <div class="requestMeta">
            <div>
              <span class="pill ${getSubscriptionPillClass(subscription)}">${escapeHtml(
                subscription.status || "active",
              )}</span>
              <h3>${escapeHtml(subscription.display_name || subscription.client_id)}</h3>
              <p class="muted">${escapeHtml(subscription.client_id)}</p>
            </div>
            <div>
              <p><strong>${escapeHtml(subscription.plan_name || "free")}</strong></p>
              <p class="muted">${escapeHtml(subscription.plan_description || "No plan description available.")}</p>
            </div>
          </div>
          <p><strong>Plan window:</strong> ${formatDate(subscription.current_period_start)} to ${formatDate(subscription.current_period_end)}</p>
          <p><strong>Monthly limit:</strong> ${formatNumber(subscription.monthly_generation_limit)} generations</p>
          <p><strong>Latest contact:</strong> ${escapeHtml(subscription.latest_contact_name || "Not provided")} | ${escapeHtml(subscription.latest_contact_channel || "Not provided")}</p>
          <p><strong>Latest payment:</strong> ${escapeHtml(subscription.latest_payment_method || "Not provided")} | Ref: ${escapeHtml(subscription.latest_payment_reference || "Not provided")}</p>
        </article>
      `,
    )
    .join("");
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

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getSubscriptionPillClass(subscription) {
  if (Number(subscription.price_cents || 0) > 0) {
    return "approved";
  }

  return "pending";
}

async function handleRequestAction(action, requestId, adminNotes) {
  const token = localStorage.getItem(STORAGE_KEY) || "";

  setStatus(`${action === "approve" ? "Approving" : "Rejecting"} request...`);

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
    return "No expiry set";
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
