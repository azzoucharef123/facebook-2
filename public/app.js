const stateElements = {
  statusTitle: document.getElementById("status-title"),
  enabledToggle: document.getElementById("enabled-toggle"),
  commentsCount: document.getElementById("comments-count"),
  repliesCount: document.getElementById("replies-count"),
  likesCount: document.getElementById("likes-count"),
  pendingCount: document.getElementById("pending-count"),
  webhookStatus: document.getElementById("webhook-status"),
  recommendedField: document.getElementById("recommended-field"),
  pageIdText: document.getElementById("page-id-text"),
  lastScanText: document.getElementById("last-scan-text"),
  replyEnabled: document.getElementById("reply-enabled"),
  replyMode: document.getElementById("reply-mode"),
  replyMessage: document.getElementById("reply-message"),
  replyDelay: document.getElementById("reply-delay"),
  likeEnabled: document.getElementById("like-enabled"),
  likeMode: document.getElementById("like-mode"),
  likeDelay: document.getElementById("like-delay"),
  maxPosts: document.getElementById("max-posts"),
  maxCommentsPerPost: document.getElementById("max-comments-per-post"),
  maxTotalComments: document.getElementById("max-total-comments"),
  commentsList: document.getElementById("comments-list"),
  activityList: document.getElementById("activity-list"),
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

function formatDate(value) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString("ar");
}

function renderBadge(status) {
  const labels = {
    idle: "لم يبدأ",
    queued: "في الانتظار",
    done: "تم",
    failed: "فشل"
  };

  const label = labels[status] || status || "-";
  return `<span class="status-badge ${status || "idle"}">${escapeHtml(label)}</span>`;
}

function renderState(state) {
  stateElements.statusTitle.textContent = state.enabled ? "الأتمتة تعمل الآن" : "الأتمتة متوقفة";
  stateElements.enabledToggle.checked = state.enabled;
  stateElements.commentsCount.textContent = state.analytics.scannedComments;
  stateElements.repliesCount.textContent = state.analytics.repliesSent;
  stateElements.likesCount.textContent = state.analytics.likesSent;
  stateElements.pendingCount.textContent = state.analytics.pendingActions;
  stateElements.webhookStatus.textContent = state.pageConfigured ? "جاهز" : "ينقصه ضبط";
  stateElements.recommendedField.textContent = state.recommendedWebhookField;
  stateElements.pageIdText.textContent = state.pageId || "-";
  stateElements.lastScanText.textContent = formatDate(state.analytics.lastScanAt);

  stateElements.replyEnabled.checked = state.automation.reply.enabled;
  stateElements.replyMode.value = state.automation.reply.mode;
  stateElements.replyMessage.value = state.automation.reply.message || "";
  stateElements.replyDelay.value = state.automation.reply.delaySeconds;
  stateElements.likeEnabled.checked = state.automation.like.enabled;
  stateElements.likeMode.value = state.automation.like.mode;
  stateElements.likeDelay.value = state.automation.like.delaySeconds;
  stateElements.maxPosts.value = state.scanLimits.maxPosts;
  stateElements.maxCommentsPerPost.value = state.scanLimits.maxCommentsPerPost;
  stateElements.maxTotalComments.value = state.scanLimits.maxTotalComments;

  stateElements.commentsList.innerHTML = state.comments.length
    ? state.comments
        .map(
          (comment) => `
          <article class="comment-card">
            <div class="comment-header">
              <div>
                <strong>${escapeHtml(comment.authorName)}</strong>
                <p>${escapeHtml(comment.postMessage || "منشور بدون نص")}</p>
              </div>
              <span>${formatDate(comment.createdAt)}</span>
            </div>
            <p class="comment-body">${escapeHtml(comment.message || "(تعليق بدون نص)")}</p>
            <div class="status-row">
              <div>الرد: ${renderBadge(comment.replyStatus)}</div>
              <div>الإعجاب: ${renderBadge(comment.likeStatus)}</div>
            </div>
            ${
              comment.replyError || comment.likeError
                ? `<p class="error-note">${escapeHtml(comment.replyError || comment.likeError)}</p>`
                : ""
            }
          </article>
        `
        )
        .join("")
    : '<p class="empty-text">لا توجد تعليقات مخزنة بعد.</p>';

  stateElements.activityList.innerHTML = state.activity.length
    ? state.activity
        .map(
          (item) => `
          <article class="conversation-item ${item.kind === "error" ? "system" : "outgoing"}">
            <div class="conversation-meta">
              <strong>${escapeHtml(item.kind)}</strong>
              <span>${formatDate(item.at)}</span>
            </div>
            <p>${escapeHtml(item.message)}</p>
          </article>
        `
        )
        .join("")
    : '<p class="empty-text">لا توجد عمليات مسجلة بعد.</p>';
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
    showToast(event.target.checked ? "تم تشغيل الأتمتة" : "تم إيقاف الأتمتة");
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById("automation-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    replyEnabled: stateElements.replyEnabled.checked,
    replyMode: stateElements.replyMode.value,
    replyMessage: stateElements.replyMessage.value,
    replyDelaySeconds: Number(stateElements.replyDelay.value || 0),
    likeEnabled: stateElements.likeEnabled.checked,
    likeMode: stateElements.likeMode.value,
    likeDelaySeconds: Number(stateElements.likeDelay.value || 0),
    maxPosts: Number(stateElements.maxPosts.value || 0),
    maxCommentsPerPost: Number(stateElements.maxCommentsPerPost.value || 0),
    maxTotalComments: Number(stateElements.maxTotalComments.value || 0)
  };

  try {
    const data = await request("/api/automation", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    renderState(data.state);
    showToast("تم حفظ إعدادات الرد والإعجاب");
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById("scan-btn").addEventListener("click", async () => {
  try {
    const data = await request("/api/scan", {
      method: "POST"
    });
    renderState(data.state);
    showToast("تم تنفيذ فحص جديد للتعليقات");
  } catch (error) {
    showToast(error.message, true);
  }
});

refreshState().catch((error) => {
  showToast(error.message, true);
});

setInterval(() => {
  refreshState().catch(() => {});
}, 15000);
