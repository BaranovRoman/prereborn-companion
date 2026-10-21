import React from "react";
import ReactDOM from "react-dom/client";

// WK-179 - the transparent "chat-overlay" window loads the same bundle with
// ?view=chat-overlay. It must not import App: the main window's global CSS
// paints an opaque body background.
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (new URLSearchParams(window.location.search).get("view") === "chat-overlay") {
  void import("./chat-overlay/ChatOverlayApp").then(({ ChatOverlayApp }) => root.render(<React.StrictMode><ChatOverlayApp /></React.StrictMode>));
} else {
  void import("./App").then(({ default: App }) => root.render(<React.StrictMode><App /></React.StrictMode>));
}
