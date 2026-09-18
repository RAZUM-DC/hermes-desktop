import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import Setup from "./Setup";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

vi.mock("../../components/common/BrandLogo", () => ({
  default: ({ provider }: { provider: string }): React.JSX.Element => (
    <span data-testid={`brand-${provider}`} />
  ),
}));

vi.mock("../../components/VerifyWarningBanner", () => ({
  default: (): React.JSX.Element => <div data-testid="verify-warning" />,
}));

function installHermesAPI(): {
  setEnv: ReturnType<typeof vi.fn>;
  setModelConfig: ReturnType<typeof vi.fn>;
} {
  const api = {
    setEnv: vi.fn().mockResolvedValue(true),
    setModelConfig: vi.fn().mockResolvedValue(true),
    openExternal: vi.fn(),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("Setup", () => {
  // @lat: [[provider-setup#Provider setup#Setup profile credentials]]
  it.each(["work", "default"])(
    "saves credentials and model config to profile %s",
    async (profile) => {
      const api = installHermesAPI();
      const onComplete = vi.fn();
      render(<Setup profile={profile} onComplete={onComplete} />);

      fireEvent.change(screen.getByPlaceholderText("sk-or-v1-..."), {
        target: { value: "sk-openrouter" },
      });
      fireEvent.click(screen.getByText("setup.continue"));

      await waitFor(() => {
        expect(api.setEnv).toHaveBeenCalledWith(
          "OPENROUTER_API_KEY",
          "sk-openrouter",
          profile,
        );
      });
      expect(api.setModelConfig).toHaveBeenCalledWith(
        "openrouter",
        "",
        "https://openrouter.ai/api/v1",
        profile,
      );
      expect(onComplete).toHaveBeenCalled();
    },
  );
});
