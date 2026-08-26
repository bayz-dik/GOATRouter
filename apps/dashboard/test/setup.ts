import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Vitest is not run with `globals: true`, so Testing Library's automatic
// afterEach cleanup is never registered. Without this, DOM from one test leaks
// into the next and role queries start matching duplicated elements.
afterEach(() => {
  cleanup();
});
