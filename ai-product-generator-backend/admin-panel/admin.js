const loginCard = document.getElementById("loginCard");
const dashboard = document.getElementById("dashboard");
const adminTokenInput = document.getElementById("adminToken");
const loginButton = document.getElementById("loginBtn");
const logoutButton = document.getElementById("logoutBtn");
const refreshButton = document.getElementById("refreshBtn");
const statusFilter = document.getElementById("statusFilter");
const requestsList = document.getElementById("requestsList");
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
  setStatus("Logged out.");
});

refreshButton.addEventListener("click", async () => {
  await loadDashboard();
});

statusFilter.addEventListener("change", async () => {
  await loadRequests();
});

requestsList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");

  if (!button) {
    return;
  }

  const action = button.getAttribute("data-action");
  const requestId = button.getAttribute("data-request-id");
  const notesField = document.getElementById(`notes-${requestId}`);
  const adminNotes = notesField?.value?.trim() || "";

  button.disabled = true;

  try {
    await handleRequestAction(action, requestId, adminNotes);
  } finally {
    button.disabled = false;
  }
});

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
    const data = await response.json();

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
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not load plan requests.");
    }

    renderRequests(data.requests || []);
  } catch (error) {
    requestsList.innerHTML = "";
    setStatus(error.message || "Could not load plan requests.");
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

function renderActions(requestId) {
  return `
    <div class="requestActions">
      <textarea id="notes-${requestId}" rows="3" placeholder="Optional admin note"></textarea>
      <button type="button" data-action="approve" data-request-id="${requestId}">Approve</button>
      <button type="button" class="reject" data-action="reject" data-request-id="${requestId}">Reject</button>
    </div>
  `;
}

function renderProofLink(request) {
  if (!request.proof_data_url) {
    return "<p class='muted'>No payment proof attached.</p>";
  }

  const label = request.proof_file_name || "View uploaded proof";
  return `<p><a class="proofLink" href="${request.proof_data_url}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a></p>`;
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
    const data = await response.json();

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

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
