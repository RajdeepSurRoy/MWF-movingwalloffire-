import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several test files start headless Chromium. Run in parallel they starve each other and
    // time out at random (seen on Windows); one file at a time costs a few seconds.
    fileParallelism: false,
    // The example apps are separate projects with their own dependencies and tests.
    exclude: [...configDefaults.exclude, "examples/**"],
  },
});
