import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "./components/ui/tooltip";
import { App } from "./App";
import "./styles.css";
import "./mobile.css";
import "./desktop.css";
import { registerPwa } from "./pwa";

void registerPwa().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000, refetchOnWindowFocus: false },
  },
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
