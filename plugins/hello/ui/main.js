const result = document.querySelector("#result");
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.type !== "hello-result") return;
  result.textContent = event.data.error || event.data.result?.text || "No result";
});
document.querySelector("#greet").addEventListener("click", () => {
  window.parent.postMessage({ type: "hello-greet", text: "UI" }, "*");
});
window.parent.postMessage({ type: "hello-ui-ready", version: 1 }, "*");
