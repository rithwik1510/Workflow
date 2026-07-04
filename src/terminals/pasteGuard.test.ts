import { describe, it, expect, vi } from "vitest";

import { guardedPaste, isMultilinePaste, pasteConfirmRequest } from "@/terminals/pasteGuard";

describe("isMultilinePaste — detection matrix", () => {
  it("single line → not multiline", () => {
    expect(isMultilinePaste("npm run build")).toBe(false);
  });
  it("empty string → not multiline", () => {
    expect(isMultilinePaste("")).toBe(false);
  });
  it("LF-separated → multiline", () => {
    expect(isMultilinePaste("a\nb")).toBe(true);
  });
  it("CRLF-separated → multiline", () => {
    expect(isMultilinePaste("a\r\nb")).toBe(true);
  });
  it("trailing newline only → multiline (it auto-executes)", () => {
    expect(isMultilinePaste("deploy\n")).toBe(true);
  });
  it("trailing CRLF only → multiline", () => {
    expect(isMultilinePaste("deploy\r\n")).toBe(true);
  });
});

describe("pasteConfirmRequest", () => {
  it("counts content lines and drops a trailing newline from the count", () => {
    expect(pasteConfirmRequest("a\nb\nc").title).toBe("Paste 3 lines?");
    expect(pasteConfirmRequest("a\nb\nc\n").title).toBe("Paste 3 lines?");
  });
  it("uses the singular for a single trailing-newline line", () => {
    expect(pasteConfirmRequest("deploy\n").title).toBe("Paste 1 line?");
  });
  it("previews the first 5 lines with a +N more tail", () => {
    const req = pasteConfirmRequest("1\n2\n3\n4\n5\n6\n7");
    expect(req.preview).toBe("1\n2\n3\n4\n5\n… +2 more");
  });
  it("previews all lines when ≤5 with no tail", () => {
    expect(pasteConfirmRequest("1\n2\n3").preview).toBe("1\n2\n3");
  });
  it("carries Paste / Cancel labels", () => {
    const req = pasteConfirmRequest("a\nb");
    expect(req.confirmLabel).toBe("Paste");
    expect(req.cancelLabel).toBe("Cancel");
  });
});

describe("guardedPaste", () => {
  const confirmYes = vi.fn(async () => true);
  const confirmNo = vi.fn(async () => false);

  it("empty text pastes nothing and never prompts", async () => {
    const paste = vi.fn();
    const confirm = vi.fn(async () => true);
    await guardedPaste("", paste, { warnMultiline: true, confirm });
    expect(paste).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("single-line text pastes straight through, no prompt", async () => {
    const paste = vi.fn();
    const confirm = vi.fn(async () => true);
    await guardedPaste("ls -la", paste, { warnMultiline: true, confirm });
    expect(paste).toHaveBeenCalledWith("ls -la");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("pref OFF bypasses the guard even for multiline", async () => {
    const paste = vi.fn();
    const confirm = vi.fn(async () => true);
    await guardedPaste("a\nb\nc", paste, { warnMultiline: false, confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(paste).toHaveBeenCalledWith("a\nb\nc");
  });

  it("cancel writes nothing to the pty", async () => {
    const paste = vi.fn();
    await guardedPaste("a\nb", paste, { warnMultiline: true, confirm: confirmNo });
    expect(paste).not.toHaveBeenCalled();
  });

  it("confirm pastes the ORIGINAL text byte-identical (CRLF preserved)", async () => {
    const paste = vi.fn();
    const original = "git add .\r\ngit commit -m 'x'\r\n";
    await guardedPaste(original, paste, { warnMultiline: true, confirm: confirmYes });
    expect(paste).toHaveBeenCalledWith(original);
  });
});
