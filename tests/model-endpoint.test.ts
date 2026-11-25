import { describe, expect, it } from "vitest";
import { normalizeModelEndpointUrl } from "../src/shared/model-endpoint";

describe("normalizeModelEndpointUrl", () => {
  it("normalizes scheme, host, default port, whitespace, and trailing slashes", () => {
    expect(normalizeModelEndpointUrl(" HTTPS://API.EXAMPLE:443/v1/ ")).toBe(
      "https://api.example/v1",
    );
  });

  it("preserves case-sensitive paths, queries, and fragments", () => {
    expect(
      normalizeModelEndpointUrl(
        "https://API.EXAMPLE/v1/TenantA/?Model=Fast#RouteA",
      ),
    ).toBe("https://api.example/v1/TenantA?Model=Fast#RouteA");
    expect(
      normalizeModelEndpointUrl("https://api.example/v1/TenantA"),
    ).not.toBe(normalizeModelEndpointUrl("https://API.EXAMPLE/v1/tenanta"));
  });

  it("normalizes non-URL identifiers without lowercasing them", () => {
    expect(normalizeModelEndpointUrl(" Endpoint/TenantA/ ")).toBe(
      "Endpoint/TenantA",
    );
  });

  it("retains IPv6 brackets and explicit non-default ports", () => {
    expect(normalizeModelEndpointUrl("HTTPS://[2001:DB8::1]:8443/v1/")).toBe(
      "https://[2001:db8::1]:8443/v1",
    );
  });
});
