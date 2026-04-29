import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Minimal vitest config for pure-logic unit tests (no DOM, no JSX).
// React-component tests would need jsdom + @testing-library; we
// don't have any yet. Add `environment: "jsdom"` here when we do.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**", ".wrangler/**"],
  },
});
