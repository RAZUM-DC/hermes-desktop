import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, type RenderResult } from "@testing-library/react";

vi.mock("./useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: () => {},
  }),
}));

import { ImagePreview } from "./ImagePreview";

const SRC = "data:image/png;base64,AAAA";
const saveMediaFile = vi.fn();

function mount(onClose = vi.fn()): RenderResult & { onClose: typeof onClose } {
  const result = render(
    <ImagePreview src={SRC} name="screenshot.png" onClose={onClose} />,
  );
  return { ...result, onClose };
}

describe("ImagePreview", () => {
  beforeEach(() => {
    saveMediaFile.mockReset();
    (
      window as unknown as {
        hermesAPI: { saveMediaFile: typeof saveMediaFile };
      }
    ).hermesAPI = { saveMediaFile };
  });

  it("renders into the document body rather than where it is used", () => {
    // This is the whole point of the component. Chat rows use
    // `content-visibility: auto`, whose paint containment turns the row into
    // the containing block for fixed-position children — an overlay rendered
    // in place ends up clipped to the message instead of covering the window.
    const { container } = mount();

    expect(container.querySelector(".chat-image-preview-backdrop")).toBeNull();
    expect(
      document.body.querySelector(".chat-image-preview-backdrop"),
    ).not.toBeNull();
  });

  it("keeps the action buttons out of the picture's area", () => {
    mount();
    const stage = document.body.querySelector(".chat-image-preview-stage");
    const actions = document.body.querySelector(".chat-image-preview-actions");

    // The buttons are a row of their own above the picture, not something
    // floating over it: a large screenshot used to sit on top of them, and
    // no amount of z-index helps when both occupy the same space.
    expect(stage).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(stage!.querySelector(".chat-image-preview-btn")).toBeNull();
    expect(actions!.querySelector(".chat-image-preview-image")).toBeNull();
  });

  it("closes when the empty space around the picture is clicked", () => {
    const { onClose } = mount();

    fireEvent.click(document.body.querySelector(".chat-image-preview-stage")!);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when the backdrop is clicked", () => {
    const { onClose } = mount();
    const backdrop = document.body.querySelector(
      ".chat-image-preview-backdrop",
    );

    fireEvent.click(backdrop!);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when the picture itself is clicked", () => {
    const { onClose } = mount();
    const image = document.body.querySelector(".chat-image-preview-image");

    fireEvent.click(image!);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const { onClose } = mount();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stops listening for Escape once unmounted", () => {
    const { onClose, unmount } = mount();
    unmount();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the close button and saves from the save button", () => {
    const { onClose } = mount();
    const buttons = document.body.querySelectorAll(".chat-image-preview-btn");

    fireEvent.click(buttons[0]);
    expect(saveMediaFile).toHaveBeenCalledWith(SRC, "screenshot.png");

    fireEvent.click(buttons[1]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
