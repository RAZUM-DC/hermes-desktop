import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SidebarBrand from "./SidebarBrand";

describe("SidebarBrand", () => {
  // @lat: [[sidebar-navigation#Sidebar recent sessions#Collapse toggle brand mark#Reliable RAZUM wordmark]]
  it("renders the RAZUM SVG as an image instead of a fallible CSS mask", () => {
    render(<SidebarBrand />);

    const logo = screen.getByRole("img", { name: "RAZUM" });
    expect(logo.tagName).toBe("IMG");
    expect(logo).toHaveClass("sidebar-logo");
    expect(logo.getAttribute("src")).toMatch(/(?:\.svg|image\/svg\+xml)/);
    expect(logo).not.toHaveAttribute("style");
  });
});
