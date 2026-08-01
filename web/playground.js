const ui = {
  list: document.querySelector("#demo-list"), title: document.querySelector("#demo-title"),
  number: document.querySelector("#stage-number"), description: document.querySelector("#demo-description"),
  run: document.querySelector("#run-demo"), track: document.querySelector("#signal-track"),
  summary: document.querySelector("#result-summary"), result: document.querySelector("#result-json"),
  template: document.querySelector("#step-template"),
};
let demos = [];
let selected = null;

void initialize();

async function initialize() {
  const response = await fetch("/api/playground/demos");
  const body = await response.json();
  demos = body.demos;
  for (const demo of demos) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.demo = demo.id;
    const stage = document.createElement("span"); stage.textContent = `S${demo.stage}`;
    const copy = document.createElement("strong"); copy.textContent = demo.title;
    button.append(stage, copy);
    button.addEventListener("click", () => selectDemo(demo));
    ui.list.append(button);
  }
  selectDemo(demos[0]);
}

function selectDemo(demo) {
  selected = demo;
  ui.list.querySelectorAll("button").forEach((button) => {
    button.dataset.active = String(button.dataset.demo === demo.id);
  });
  ui.number.textContent = `STAGE ${demo.stage}`;
  ui.title.textContent = demo.title;
  ui.description.textContent = demo.description;
  ui.run.disabled = false;
  ui.summary.textContent = "准备运行固定示例。";
  ui.result.textContent = "{}";
  ui.track.replaceChildren(empty("按“运行示例”观察数据如何经过组件。"));
}

ui.run.addEventListener("click", async () => {
  if (!selected) return;
  ui.run.disabled = true;
  ui.run.textContent = "运行中…";
  try {
    const response = await fetch("/api/playground/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ demo: selected.id }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Demo failed");
    render(body);
  } catch (error) {
    ui.track.replaceChildren(empty(error instanceof Error ? error.message : "Demo failed"));
  } finally {
    ui.run.disabled = false;
    ui.run.textContent = "再次运行";
  }
});

function render(body) {
  ui.track.replaceChildren();
  body.steps.forEach((step, index) => {
    const fragment = ui.template.content.cloneNode(true);
    fragment.querySelector("small").textContent = `STEP ${String(index + 1).padStart(2, "0")}`;
    fragment.querySelector("h2").textContent = step.label;
    fragment.querySelector("p").textContent = step.detail;
    fragment.querySelector("pre").textContent = pretty(step.data);
    ui.track.append(fragment);
  });
  ui.summary.textContent = body.summary;
  ui.result.textContent = pretty(body.result);
}

function empty(text) {
  const element = document.createElement("div");
  element.className = "lab-empty";
  const mark = document.createElement("span"); mark.textContent = "○";
  const copy = document.createElement("p"); copy.textContent = text;
  element.append(mark, copy);
  return element;
}

function pretty(value) { return JSON.stringify(value, null, 2); }
