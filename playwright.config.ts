import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
/** The reference viewport the approved mockups were drawn at. */
const VIEWPORT = { width: 1584, height: 993 };

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled" } },
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: VIEWPORT,
    colorScheme: "dark",
    // The room holds still under reduced motion, so clicking an agent never chases them across it.
    reducedMotion: "reduce",
    // The scenario's clock is Indian Standard Time; schedules read the same on any machine.
    timezoneId: "Asia/Kolkata",
    trace: "retain-on-failure",
  },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport: VIEWPORT, deviceScaleFactor: 1 } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
