import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import { ThemeProvider, themeBootScript } from "~/components/theme-provider";
import { TooltipProvider } from "~/components/ui/tooltip";
import "../styles.css";

/**
 * Pull runtime config from the worker env and ship it to the client as
 * `window.__ENV__`. We deliberately keep the surface tiny — only the
 * api-gateway URL is needed; everything else is per-request.
 */
const getRuntimeEnv = createServerFn({ method: "GET" }).handler(async () => {
  // `process.env` is the canonical TanStack Start path on Workers — vars
  // declared in wrangler.jsonc are exposed there. We don't `throw` if
  // missing — fall back to a sensible default so dev still works without
  // the api-gateway URL being set.
  const apiUrl = (typeof process !== "undefined" ? process.env?.API_URL : undefined) ?? "";
  return { API_URL: apiUrl };
});

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "data-agent" },
    ],
  }),
  loader: async () => ({ env: await getRuntimeEnv() }),
  component: RootComponent,
});

function RootComponent() {
  const { env } = Route.useLoaderData();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            retry: 1,
          },
        },
      })
  );

  return (
    <RootDocument env={env}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={150}>
            <Outlet />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </RootDocument>
  );
}

function RootDocument({ children, env }: { children: ReactNode; env: { API_URL: string } }) {
  // We inject env via a small script before any other JS runs so client
  // modules can read window.__ENV__ during their import-time initialization.
  // We *also* run the theme-boot script here so the right `class="dark"`
  // is set before Tailwind paints — otherwise the page flashes light
  // before React hydrates and the provider applies the stored theme.
  const inline = `window.__ENV__=${JSON.stringify(env)};${themeBootScript}`;
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* eslint-disable-next-line react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: inline }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
