import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outputDir = process.env.TERMINUS_SCREENSHOT_DIR ?? process.cwd();
const port = process.env.TERMINUS_DESKTOP_PORT ?? "5173";
mkdirSync(outputDir, { recursive: true });

async function run() {
  const versionRes = await fetch("http://127.0.0.1:9222/json/list");
  const pages = await versionRes.json();
  const target = pages.find((p) => p.type === "page") || pages[0];
  if (!target) {
    console.error("No target page found");
    return;
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const callbacks = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (callbacks.has(msg.id)) {
      const cb = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      cb(msg);
    }
  };

  const send = (method, params = {}) => {
    const reqId = id++;
    return new Promise((resolve) => {
      callbacks.set(reqId, resolve);
      ws.send(JSON.stringify({ id: reqId, method, params }));
    });
  };

  await new Promise((resolve) => ws.onopen = resolve);
  await send("Runtime.enable");
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.consoleAPICalled") {
      console.log("BROWSER CONSOLE:", ...msg.params.args.map(a => a.value ?? a.description));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      console.error("BROWSER EXCEPTION:", msg.params.exceptionDetails);
    }
  });

  const evalJs = async (expr) => {
    const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true });
    return res.result?.result?.value;
  };

  const capture = async (filename) => {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.result.data, "base64");
    writeFileSync(join(outputDir, filename), buffer);
    console.log(`Saved ${filename}`);
  };

  // Wait for initial load
  await new Promise((r) => setTimeout(r, 1000));
  await send("Page.navigate", { url: `http://localhost:${port}/?mock=true` });
  await new Promise((r) => setTimeout(r, 1200));

  // Click on "Sessions" in Sidebar
  console.log("Navigating to Sessions Kanban...");
  await evalJs(`
    const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Sessions"));
    if (btn) btn.click();
  `);
  await new Promise((r) => setTimeout(r, 1000));
  await capture("screenshot-kanban.png");

  // Click on List view toggle
  console.log("Switching to List view...");
  await evalJs(`
    const btn = document.querySelector('button[aria-label="List view"]');
    if (btn) btn.click();
  `);
  await new Promise((r) => setTimeout(r, 1000));
  await capture("screenshot-listview.png");

  // Switch back to Board view
  console.log("Switching back to Board view...");
  await evalJs(`
    const btn = document.querySelector('button[aria-label="Board view"]');
    if (btn) btn.click();
  `);
  await new Promise((r) => setTimeout(r, 1000));
  await capture("screenshot-kanban.png");

  // Click on a task in the sidebar to open conversation
  console.log("Opening task conversation...");
  await evalJs(`
    const taskBtn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Refactor Rust effect"));
    if (taskBtn) taskBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 1200));
  await capture("screenshot-conversation.png");

  // Open Inspector
  console.log("Toggling Inspector panel...");
  await evalJs(`
    const inspectorBtn = document.querySelector('button[aria-label="Show task context"], button[aria-label="Hide task context"]');
    if (inspectorBtn) inspectorBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 1000));
  await capture("screenshot-conversation-inspector.png");

  // Open Needs Attention modal
  console.log("Opening Needs Attention modal...");
  await evalJs(`
    const attentionBtn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Needs attention"));
    if (attentionBtn) attentionBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 1000));
  await capture("screenshot-attention-modal.png");

  ws.close();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
