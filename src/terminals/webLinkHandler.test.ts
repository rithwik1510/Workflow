import { describe, it, expect, vi } from "vitest";

import { handleWebLink, shouldActivateWebLink } from "@/terminals/webLinkHandler";

const ctrl = { ctrlKey: true, metaKey: false };
const meta = { ctrlKey: false, metaKey: true };
const plain = { ctrlKey: false, metaKey: false };

describe("shouldActivateWebLink", () => {
  it("qualifies on Ctrl or Cmd", () => {
    expect(shouldActivateWebLink(ctrl)).toBe(true);
    expect(shouldActivateWebLink(meta)).toBe(true);
  });
  it("rejects a plain click", () => {
    expect(shouldActivateWebLink(plain)).toBe(false);
  });
});

describe("handleWebLink", () => {
  it("Ctrl+click on http(s) opens via the injected opener", () => {
    const open = vi.fn();
    handleWebLink(ctrl, "https://example.com", open);
    expect(open).toHaveBeenCalledWith("https://example.com");
    handleWebLink(ctrl, "http://example.com/path?q=1", open);
    expect(open).toHaveBeenCalledWith("http://example.com/path?q=1");
  });

  it("Cmd+click on https opens (macOS)", () => {
    const open = vi.fn();
    handleWebLink(meta, "https://example.com", open);
    expect(open).toHaveBeenCalledWith("https://example.com");
  });

  it("plain click never opens (stays with the shell's mouse modes)", () => {
    const open = vi.fn();
    handleWebLink(plain, "https://example.com", open);
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses non-http(s) schemes even with Ctrl", () => {
    const open = vi.fn();
    handleWebLink(ctrl, "file:///etc/passwd", open);
    handleWebLink(ctrl, "ftp://host/x", open);
    handleWebLink(ctrl, "javascript:alert(1)", open);
    expect(open).not.toHaveBeenCalled();
  });

  it("never navigates the webview (no window.open)", () => {
    const spy = vi.spyOn(window, "open").mockImplementation(() => null);
    handleWebLink(ctrl, "https://example.com", () => {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
