const stateElements = {
  statusTitle: document.getElementById("status-title"),
  enabledToggle: document.getElementById("enabled-toggle"),
  incomingCount: document.getElementById("incoming-count"),
  outgoingCount: document.getElementById("outgoing-count"),
  usersCount: document.getElementById("users-count"),
  webhookStatus: document.getElementById("webhook-status"),
  welcomeMessage: document.getElementById("welcome-message"),
  defaultReply: document.getElementById("default-reply"),
  recipientSelect: document.getElementById("recipient-id"),
  keywordsList: document.getElementById("keywords-list"),
  usersList: document.getElementById("users-list"),
  conversationsList: document.getElementById("conversations-list"),
  toast: document.getElementById("toast")
};

function showToast(message, isError = false) {
  stateElements.toast.textContent = message;
  stateElements.toast.className = `toast ${isError ? "error" : "success"}`;
  setTimeout(() => {
    stateElements.toast.className = "toast hidden";
  }, 3500);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bindDeleteButtons() {
  document.querySelectorAll("[data-delete-keyword]").forEach((button) => {
    button.onclick = async () => {
      try {
        const data = await request(`/api/keywords/${button.dataset.deleteKeyword}`, {
          method: "DELETE"
        });
        renderState(data.state);
        showToast("تم حذف القاعدة");
      } catch (error) {
        showToast(error.message, true);
      }
    };
  });
}

function renderState(state) {
  stateElements.statusTitle.textContent = state.enabled ? "البوت يعمل الآن" : "البوت متوقف";
  stateElements.enabledToggle.checked = state.enabled;
  stateElements.incomingCount.textContent = state.analytics.incomingMessages;
  stateElements.outgoingCount.textContent = state.analytics.outgoingMessages;
  stateElements.usersCount.textContent = state.users.length;
  stateElements.webhookStatus.textContent = state.pageConfigured ? "جاهز" : "ينقصه ضبط";
  stateElements.welcomeMessage.value = state.welcomeMessage || "";
  stateElements.defaultReply.value = state.defaultReply || "";

  stateElements.recipientSelect.innerHTML = "";
  if (!state.users.length) {
    const option = document.createElement("option");
    option.textContent = "لا يوجد عملاء بعد";
    option.value = "";
    stateElements.recipientSelect.appendChild(option);
  } else {
    state.users.forEach((user) => {
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = `${user.name || "Messenger User"} (${user.id})`;
      stateElements.recipientSelect.appendChild(option);
    });
  }

  stateElements.keywordsList.innerHTML = state.keywordRules.length
    ? state.keywordRules
        .map(
          (rule) => `
          <article class="list-item">
            <div>
              <strong>${escapeHtml(rule.keyword)}</strong>
              <p>${escapeHtml(rule.reply)}</p>
            </div>
            <button type="button" data-delete-keyword="${rule.id}" class="danger-link">حذف</button>
          </article>
        `
        )
        .join("")
    : '<p class="empty-text">لا توجد كلمات مفتاحية حتى الآن.</p>';

  stateElements.usersList.innerHTML = state.users.length
    ? state.users
        .map(
          (user) => `
          <article class="list-item">
            <div>
              <strong>${escapeHtml(user.name || "Messenger User")}</strong>
              <p>${escapeHtml(user.id)}</p>
            </div>
            <span>${new Date(user.lastInteractionAt).toLocaleString("ar")}</span>
          </article>
        `
        )
        .join("")
    : '<p class="empty-text">لم يصل أي مستخدم بعد.</p>';

  stateElements.conversationsList.innerHTML = state.conversations.length
    ? state.conversations
        .map(
          (item) => `
          <article class="conversation-item ${item.direction}">
            <div class="conversation-meta">
              <strong>${escapeHtml(item.userName || "System")}</strong>
              <span>${new Date(item.at).toLocaleString("ar")}</span>
            </div>
            <p>${escapeHtml(item.text)}</p>
          </article>
        `
        )
        .join("")
    : '<p class="empty-text">لا توجد محادثات محفوظة حتى الآن.</p>';

  bindDeleteButtons();
}

async function refreshState() {
  const data = await request("/api/state");
  renderState(data.state);
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  await request("/logout", { method: "POST" });
  window.location.href = "/";
});

document.getElementById("enabled-toggle").addEventListener("change", async (event) => {
  try {
    const data = await request("/api/toggle", {
      method: "POST",
      body: JSON.stringify({ enabled: event.target.checked })
    });
    renderState(data.state);
    showToast(event.target.checked ? "تم تشغيل البوت" : "تم إيقاف البوت");
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target).entries());

  try {
    const data = await request("/api/settings", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    renderState(data.state);
    showToast("تم حفظ الإعدادات");
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById("keyword-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const payload = Object.fromEntries(new FormData(form).entries());

  try {
    const data = await request("/api/keywords", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    form.reset();
    renderState(data.state);
    showToast("تمت إضافة القاعدة");
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById("message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const payload = Object.fromEntries(new FormData(form).entries());

  try {
    const data = await request("/api/message", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    form.reset();
    renderState(data.state);
    showToast("تم إرسال الرسالة");
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById("broadcast-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target).entries());

  try {
    const data = await request("/api/broadcast", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    renderState(data.state);
    showToast(`تم الإرسال إلى ${data.sent} مستخدم`);
  } catch (error) {
    showToast(error.message, true);
  }
});

refreshState().catch((error) => {
  showToast(error.message, true);
});

setInterval(() => {
  refreshState().catch(() => {});
}, 20000);
