import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

import { ChatEmptyState } from "./ChatEmptyState";

afterEach(cleanup);

describe("ChatEmptyState", () => {
  it("renders the RAZUM mark as inline SVG instead of a CSS mask", () => {
    render(<ChatEmptyState onSelectSuggestion={vi.fn()} />);

    const mark = screen.getByRole("img", { name: "РАЗУМ" });
    expect(mark.tagName.toLowerCase()).toBe("svg");
    expect(mark.querySelector("path")).not.toBeNull();
    expect(mark.querySelector("g")).toHaveAttribute("fill", "currentColor");
    expect(mark.style.maskImage).toBe("");
  });
});
