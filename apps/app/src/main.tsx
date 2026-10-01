import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { AppToaster } from "./components/AppToaster";
import { registerProviderCliInstallQueryClient } from "./components/provider-cli/provider-cli-install-store";
import { initializeCorners } from "./hooks/useCorners";
import { initializePreferredTheme } from "./hooks/useTheme";
import { initializeFavicon } from "./lib/favicon-color-preference";
import { installForeignDomMutationGuard } from "./lib/foreign-dom-mutation-guard";
import { installAppQueryClientBrowserEvents } from "./lib/query-client";
import { appQueryClient } from "./lib/app-query-client";
import { applyCachedAppThemeCss } from "./lib/themes";
import { installPerfMonitor } from "./lib/perf";
import "./app.css";

installForeignDomMutationGuard();
installPerfMonitor();

Error.stackTraceLimit = 50;

// A page left open across an app update asks for old chunk names that no
// longer exist. Reload to pick up the new build, at most once per minute so a
// truly missing file can't cause a reload loop.
window.addEventListener("vite:preloadError", () => {
  const lastReload = Number(sessionStorage.getItem("cloudroom:preload-reload"));
  if (Date.now() - lastReload < 60_000) return;
  sessionStorage.setItem("cloudroom:preload-reload", String(Date.now()));
  window.location.reload();
});

installAppQueryClientBrowserEvents(appQueryClient);
registerProviderCliInstallQueryClient(appQueryClient);

initializePreferredTheme();
initializeCorners();
applyCachedAppThemeCss();
initializeFavicon();

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, errorInfo) => {
    console.error(
      "[Cloudroom] uncaught render error — the app root was torn down",
      error,
      errorInfo.componentStack,
    );
  },
}).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={appQueryClient}>
        <BrowserRouter>
          <App />
          <AppToaster />
        </BrowserRouter>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
