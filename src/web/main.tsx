import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "./components/ui/tooltip";
import { App } from "./App";
import "@fontsource-variable/geist";
import "./styles.css";
import "./mobile.css";
import "./desktop.css";
import "./account-identity.css";
import { registerPwa } from "./pwa";
import { waitForAppStyles } from "./boot";

void registerPwa().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000, refetchOnWindowFocus: false },
  },
});
await waitForAppStyles().catch((error: unknown) => {
  const content = document.querySelector(".boot-shell__content");
  if (content) content.textContent = "页面样式加载失败，请重新打开 Meterleaf。";
  throw error;
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider delay={250}>
          <App />
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  </React.StrictMode>,
);
