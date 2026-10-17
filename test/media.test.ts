import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MediaProcessor, type OcrEngine, type SttEngine } from "../src/media.ts";

function setup(opts: { ocr?: OcrEngine; stt?: SttEngine; downloadFails?: boolean }) {
  const downloads: string[] = [];
  const media = new MediaProcessor({
    ...(opts.ocr ? { ocr: opts.ocr } : {}),
    ...(opts.stt ? { stt: opts.stt } : {}),
    download: async (fileId, dest) => {
      if (opts.downloadFails) throw new Error("Telegram is down");
      downloads.push(fileId);
      fs.writeFileSync(dest, "fake-bytes");
      return dest;
    },
  });
  return { media, downloads };
}

const ocr = (text: string): OcrEngine => ({ ocr: async () => text });
const stt = (text: string): SttEngine => ({ transcribe: async () => text });

describe("MediaProcessor", () => {
  it("turns a photo with readable text into annotated conversation text", async () => {
    const { media, downloads } = setup({ ocr: ocr("MILK\nEGGS\nBREAD") });
    const text = await media.process("photo", "file_1", "shopping list");
    expect(downloads).toEqual(["file_1"]);
    expect(text).toContain("a photo");
    expect(text).toContain('captioned "shopping list"');
    expect(text).toContain("OCR read");
    expect(text).toContain("MILK");
  });

  it("transcribes voice messages", async () => {
    const { media } = setup({ stt: stt("hey can you pick up dinner on the way home") });
    const text = await media.process("voice", "v_1");
    expect(text).toContain("a voice message");
    expect(text).toContain("transcribed");
    expect(text).toContain("pick up dinner");
  });

  it("returns undefined when no engine handles the kind", async () => {
    const { media } = setup({ ocr: ocr("text") });
    expect(await media.process("voice", "v_1")).toBeUndefined();
    expect(media.capabilities()).toBe("photos");
  });

  it("says when nothing was readable instead of inventing content", async () => {
    const { media } = setup({ ocr: ocr("   \n  ") });
    const text = await media.process("photo", "f");
    expect(text).toContain("no text could be read");
  });

  it("reports failures without leaking internals, and never throws", async () => {
    const { media } = setup({ ocr: ocr("x"), downloadFails: true });
    const text = await media.process("photo", "f");
    expect(text).toContain("reading it failed");
  });

  it("deletes the temp file after processing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-test-"));
    let saved: string | undefined;
    const media = new MediaProcessor({
      ocr: {
        ocr: async (file) => {
          saved = file;
          expect(fs.existsSync(file)).toBe(true);
          return "hi";
        },
      },
      download: async (_id, dest) => {
        fs.writeFileSync(dest, "x");
        return dest;
      },
      tmpDir: dir,
    });
    await media.process("photo", "f");
    expect(saved).toBeDefined();
    expect(fs.existsSync(saved!)).toBe(false);
  });

  it("reports capabilities for the fallback message", () => {
    expect(new MediaProcessor({ download: async () => "" }).capabilities()).toBe("nothing yet");
    expect(new MediaProcessor({ ocr: ocr(""), stt: stt(""), download: async () => "" }).capabilities()).toBe("photos and voice messages");
  });
});
