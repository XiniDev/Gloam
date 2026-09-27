import "@fontsource-variable/fraunces/full.css";
import "@fontsource/alegreya-sans/400.css";
import "@fontsource/alegreya-sans/500.css";
import "@fontsource/alegreya-sans/700.css";
import "@fontsource/alegreya-sans/800.css";
import "@fontsource/cinzel/600.css";
import "@fontsource/cinzel/700.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { App } from "./App.tsx";
import { audio } from "./audio/engine.ts";
import { reportClientError } from "./net/http.ts";
import { applyDocumentSettings } from "./state/settings.ts";
import { installTestHooks } from "./test/hooks.ts";

// Our CSP forbids eval (script-src 'self' + nonce). zod 4 probes for eval with `new Function("")` the first time
// it parses an object — a CSP violation report on every page — unless told to stay on its interpreter path.
z.config({ jitless: true });

installTestHooks();
applyDocumentSettings();
audio.bindUnlock();
window.addEventListener("error", (e) =>
  reportClientError("error", e.message, (e.error as Error | undefined)?.stack),
);
window.addEventListener("unhandledrejection", (e) =>
  reportClientError("warn", String((e.reason as Error)?.message ?? e.reason)),
);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
