const elements = {
  composer: document.querySelector("#composer"),
  input: document.querySelector("#message-input"),
  send: document.querySelector("#send-button"),
  stop: document.querySelector("#stop-button"),
  reset: document.querySelector("#reset-button"),
  messages: document.querySelector("#messages"),
  empty: document.querySelector("#empty-state"),
  state: document.querySelector("#run-state"),
  stateLabel: document.querySelector("#state-label"),
  provider: document.querySelector("#provider-name"),
  traceEmpty: document.querySelector("#trace-empty"),
  traceList: document.querySelector("#trace-list"),
  traceScroll: document.querySelector("#trace-scroll"),
  eventCount: document.querySelector("#event-count"),
  activity: document.querySelector("#activity-bar"),
  activityTitle: document.querySelector("#activity-title"),
  activityDetail: document.querySelector("#activity-detail"),
  activityElapsed: document.querySelector("#activity-elapsed"),
  files: document.querySelector("#file-input"),
  attach: document.querySelector("#attach-button"),
  fileStatus: document.querySelector("#file-status"),
  messageTemplate: document.querySelector("#message-template"),
  traceTemplate: document.querySelector("#trace-template"),
  apiKey: document.querySelector("#api-key-input"),
  saveApiKey: document.querySelector("#save-api-key"),
  authStatus: document.querySelector("#auth-status"),
};

const state = {
  sessionId: localStorage.getItem("agent-session-id") || "",
  running: false,
  events: 0,
  runNumber: 0,
  assistantMessage: null,
  abortController: null,
  startedAt: 0,
  lastEventAt: 0,
  activityDetail: "",
  timer: null,
  completed: false,
  apiKey: sessionStorage.getItem("agent-api-key") || "",
};

initialize();

async function initialize() {
  bindEvents();
  elements.apiKey.value = state.apiKey;
  resizeInput();
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    elements.provider.textContent = health.provider || "unknown";
    await checkIdentity();
  } catch {
    elements.provider.textContent = "offline";
    setRunState("error", "服务未连接");
  }
}

function bindEvents() {
  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage(elements.input.value);
  });

  elements.input.addEventListener("input", resizeInput);
  elements.attach.addEventListener("click", () => elements.files.click());
  elements.files.addEventListener("change", () => {
    const count = elements.files.files.length;
    elements.fileStatus.textContent = count ? `已选择 ${count} 个文件` : "Enter 发送 · 单个文件不超过 2 MB";
  });
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });

  elements.reset.addEventListener("click", () => void resetConversation());
  elements.saveApiKey.addEventListener("click", () => {
    state.apiKey = elements.apiKey.value.trim();
    if (state.apiKey) sessionStorage.setItem("agent-api-key", state.apiKey);
    else sessionStorage.removeItem("agent-api-key");
    void checkIdentity();
  });
  elements.stop.addEventListener("click", stopRun);

  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      elements.input.value = button.dataset.prompt;
      resizeInput();
      elements.input.focus();
    });
  });
}

async function sendMessage(rawMessage) {
  const message = rawMessage.trim();
  if ((!message && !elements.files.files.length) || state.running) return;

  state.running = true;
  state.completed = false;
  state.runNumber += 1;
  state.assistantMessage = null;
  state.abortController = new AbortController();
  state.startedAt = Date.now();
  state.lastEventAt = state.startedAt;
  elements.send.disabled = true;
  elements.stop.hidden = false;
  elements.input.value = "";
  resizeInput();
  hideEmptyStates();
  const files = [...elements.files.files];
  addMessage("user", [message, files.length ? `[附件: ${files.map((file) => file.name).join(", ")}]` : ""].filter(Boolean).join("\n"));
  setRunState("running", "Agent 运行中");
  setActivity(
    "running",
    "正在建立模型请求",
    "连接 MiniMax，并准备当前 Context",
  );
  startActivityTimer();
  elements.traceList.classList.add("running");

  try {
    const artifactIds = [];
    for (const file of files) {
      if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name} 超过 2 MB。`);
      const upload = await fetch("/api/artifacts", {
        method: "POST", headers: apiHeaders(true),
        body: JSON.stringify({ name: file.name, mimeType: normalizedMimeType(file), dataBase64: await fileToBase64(file) }),
        signal: state.abortController.signal,
      });
      const uploaded = await upload.json();
      if (!upload.ok) throw new Error(uploaded.error || "文件上传失败。");
      artifactIds.push(uploaded.id);
    }
    elements.files.value = "";
    elements.fileStatus.textContent = "Enter 发送 · 单个文件不超过 2 MB";
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify({
        message,
        artifactIds,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      }),
      signal: state.abortController.signal,
    });

    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error || `Request failed: ${response.status}`);
    }
    if (!response.body) throw new Error("浏览器不支持流式响应。");

    await consumeNdjson(response.body);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "AbortError"
    ) {
      addTraceEvent("stopped", "STOPPED", "已停止运行", "用户主动停止本轮任务");
      setRunState("ready", "已停止");
      setActivity("stopped", "运行已停止", "可以修改任务后重新运行");
      return;
    }
    const messageText =
      error instanceof Error ? error.message : "请求失败，请检查服务端日志。";
    addMessage("error", messageText);
    addTraceEvent("error", "ERROR", "运行中断", messageText);
    setRunState("error", "运行失败");
    setActivity("error", "运行失败", messageText);
  } finally {
    if (!state.completed && !state.abortController?.signal.aborted) {
      const currentState = elements.activity.dataset.state;
      if (currentState === "running" || currentState === "waiting") {
        setRunState("error", "响应不完整");
        setActivity(
          "error",
          "连接已结束，但没有完成信号",
          "请检查服务端日志后重试",
        );
      }
    }
    stopActivityTimer();
    state.running = false;
    state.abortController = null;
    elements.send.disabled = false;
    elements.stop.hidden = true;
    elements.traceList.classList.remove("running");
    elements.input.focus();
  }
}

async function checkIdentity() {
  try {
    const response = await fetch("/api/me", { headers: apiHeaders() });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "认证失败");
    elements.authStatus.textContent = `${body.principal.tenantId} · ${body.principal.subject}`;
  } catch (error) {
    elements.authStatus.textContent = error instanceof Error ? error.message : "认证失败";
  }
}

function apiHeaders(json = false) {
  const headers = {};
  if (json) headers["content-type"] = "application/json";
  if (state.apiKey) headers.authorization = `Bearer ${state.apiKey}`;
  return headers;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.readAsDataURL(file);
  });
}

function normalizedMimeType(file) {
  if (file.type) return file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  return ({ txt: "text/plain", md: "text/markdown", json: "application/json" })[extension] || "application/octet-stream";
}

async function consumeNdjson(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) handleAgentEvent(JSON.parse(line));
    }
    if (done) break;
  }
  if (buffer.trim()) handleAgentEvent(JSON.parse(buffer));
}

function handleAgentEvent(event) {
  state.lastEventAt = Date.now();

  if (event.type === "session") {
    state.sessionId = event.sessionId;
    localStorage.setItem("agent-session-id", state.sessionId);
    elements.provider.textContent = event.provider;
    return;
  }

  if (event.type === "agentStart") {
    setActivity("running", "正在读取 Context", "准备 system prompt、历史消息和工具");
    addTraceEvent(
      "model",
      `RUN ${String(state.runNumber).padStart(2, "0")}`,
      "读取当前 Context",
      "system prompt + messages + tools",
    );
    return;
  }

  if (event.type === "turnStart") {
    setActivity(
      "running",
      `正在调用模型 · Turn ${event.turn}`,
      "等待模型返回文本或工具调用",
    );
    addTraceEvent(
      "model",
      `TURN ${event.turn}`,
      "调用模型",
      "模型判断：直接回答，还是调用工具？",
    );
    return;
  }

  if (event.type === "toolStart") {
    setActivity(
      "running",
      `正在执行工具 · ${event.call.name}`,
      "工具在本地运行，结果会重新交给模型",
    );
    addTraceEvent(
      "tool",
      "TOOL CALL",
      event.call.name,
      prettyJson(event.call.arguments),
    );
    return;
  }

  if (event.type === "toolEnd") {
    setActivity(
      "running",
      event.result.isError ? "工具执行失败，交给模型处理" : "工具已返回",
      event.result.isError
        ? event.result.content
        : "正在把结果写回 Context，准备下一轮",
    );
    addTraceEvent(
      event.result.isError ? "error" : "result",
      event.result.isError ? "TOOL ERROR" : "TOOL RESULT",
      event.call.name,
      event.result.content,
    );
    return;
  }

  if (event.type === "rateLimitWait") {
    const seconds = (event.delayMs / 1000).toFixed(1);
    setActivity(
      "running",
      `触发模型限流 · 等待 ${seconds} 秒`,
      "这是主动节流，不是页面卡住；等待结束后会自动继续",
    );
    addTraceEvent(
      "model",
      "RATE LIMIT",
      `等待 ${seconds} 秒`,
      "达到配置的平均请求速率，暂缓下一次模型调用",
    );
    return;
  }

  if (event.type === "usage") {
    const cost =
      event.totals.estimatedCost === undefined
        ? ""
        : ` · estimated ${event.totals.currency} ${event.totals.estimatedCost.toFixed(6)}`;
    addTraceEvent(
      "model",
      "USAGE",
      `${event.totals.totalTokens} tokens`,
      `input ${event.totals.inputTokens} · output ${event.totals.outputTokens}${cost}`,
    );
    return;
  }

  if (event.type === "text" || event.type === "textDelta") {
    const text = event.type === "textDelta" ? event.delta : event.text;
    if (!state.assistantMessage) {
      state.assistantMessage = addMessage("assistant", text);
    } else {
      const body = state.assistantMessage.querySelector(".message-body");
      const fullText = `${body.dataset.rawText || body.textContent}${text}`;
      renderMessageText(body, fullText);
    }
    if (event.type === "textDelta") {
      setActivity(
        "running",
        "模型正在流式回答",
        "文本会边生成边显示；完整消息尚未写入 Context",
      );
    }
    return;
  }

  if (event.type === "thinkingDelta") {
    setActivity(
      "running",
      "模型正在推理",
      "已收到 thinking delta；页面不展示模型内部思考内容",
    );
    return;
  }

  if (event.type === "toolArgumentsDelta") {
    setActivity(
      "running",
      `正在生成工具参数 · ${event.toolName}`,
      "参数仍是 JSON 片段，完成后才会校验并执行工具",
    );
    return;
  }

  if (event.type === "agentEnd") {
    state.completed = true;
    addTraceEvent(
      "complete",
      "COMPLETE",
      "返回最终答案",
      "本轮 Agent loop 已结束",
    );
    setRunState("ready", "等待输入");
    setActivity(
      "complete",
      "运行完成",
      `${state.events} 个事件 · Agent 已返回最终答案`,
    );
    return;
  }

  if (event.type === "error") {
    addMessage("error", event.message);
    addTraceEvent("error", "ERROR", "运行中断", event.message);
    setRunState("error", "运行失败");
    setActivity("error", "运行失败", event.message);
  }
}

function addMessage(role, text) {
  elements.empty.hidden = true;
  const fragment = elements.messageTemplate.content.cloneNode(true);
  const article = fragment.querySelector(".message");
  const meta = fragment.querySelector(".message-meta");
  const body = fragment.querySelector(".message-body");
  article.classList.add(role);
  meta.textContent =
    role === "user" ? "You" : role === "error" ? "Runtime error" : "Agent";
  renderMessageText(body, text);
  elements.messages.append(fragment);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return elements.messages.lastElementChild;
}

function addTraceEvent(kind, label, title, detail = "") {
  elements.traceEmpty.hidden = true;
  state.events += 1;
  elements.eventCount.textContent = `${state.events} event${
    state.events === 1 ? "" : "s"
  }`;

  const fragment = elements.traceTemplate.content.cloneNode(true);
  const article = fragment.querySelector(".trace-event");
  article.classList.add(kind);
  fragment.querySelector(".trace-kind").textContent = label;
  fragment.querySelector(".trace-time").textContent =
    new Date().toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  fragment.querySelector(".trace-title").textContent = title;
  fragment.querySelector(".trace-detail").textContent = detail;
  elements.traceList.append(fragment);
  elements.traceScroll.scrollTop = elements.traceScroll.scrollHeight;
}

async function resetConversation() {
  if (state.running) return;
  try {
    const response = await fetch("/api/reset", {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "无法清空会话");
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法清空会话";
    setRunState("error", "清空失败");
    setActivity("error", "会话没有被清空", message);
    return;
  }
  state.sessionId = "";
  state.events = 0;
  state.runNumber = 0;
  state.assistantMessage = null;
  state.completed = false;
  localStorage.removeItem("agent-session-id");
  elements.messages
    .querySelectorAll(".message")
    .forEach((message) => message.remove());
  elements.traceList.replaceChildren();
  elements.empty.hidden = false;
  elements.traceEmpty.hidden = false;
  elements.eventCount.textContent = "0 events";
  setRunState("ready", "等待输入");
  setActivity("ready", "准备就绪", "发送任务后，这里会持续显示当前阶段");
  elements.input.focus();
}

function hideEmptyStates() {
  elements.empty.hidden = true;
  elements.traceEmpty.hidden = true;
}

function setRunState(status, label) {
  elements.state.dataset.state = status;
  elements.stateLabel.textContent = label;
}

function setActivity(status, title, detail) {
  elements.activity.dataset.state = status;
  elements.activityTitle.textContent = title;
  elements.activityDetail.textContent = detail;
  state.activityDetail = detail;
}

function startActivityTimer() {
  stopActivityTimer();
  updateElapsedTime();
  state.timer = window.setInterval(updateElapsedTime, 1000);
}

function stopActivityTimer() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = null;
}

function updateElapsedTime() {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - state.startedAt) / 1000),
  );
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  elements.activityElapsed.textContent = `${minutes}:${seconds}`;
  elements.activityElapsed.dateTime = `PT${elapsedSeconds}S`;

  if (
    state.running &&
    !state.completed &&
    Date.now() - state.lastEventAt >= 10_000
  ) {
    setActivity(
      "waiting",
      "模型仍在生成",
      `已有 ${elapsedSeconds} 秒没有新事件；连接仍在等待，可继续等待或停止`,
    );
  }
}

function stopRun() {
  state.abortController?.abort();
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 150)}px`;
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderMessageText(element, text) {
  element.dataset.rawText = text;
  element.replaceChildren();
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      element.append(strong);
    } else if (part.startsWith("`") && part.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      element.append(code);
    } else {
      element.append(document.createTextNode(part));
    }
  }
}
