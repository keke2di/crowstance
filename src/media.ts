/**
 * Media understanding: photos and voice/documents arrive from Telegram, and this module
 * turns them into text the (text-only) model can read. OCR and speech-to-text are
 * pluggable engines behind small interfaces; the defaults are local CLI tools
 * (tesseract, whisper.cpp) so nothing leaves the server, with cloud adapters possible
 * later without touching the pipeline. If no engine is configured for a media type,
 * the bot says so instead of pretending to understand.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "./log.ts";
import { truncate } from "./text.ts";

const log = logger("media");
const execFileP = promisify(execFile);

export interface OcrEngine {
  /** Extract visible text from an image file. Returns "" when nothing readable. */
  ocr(file: string): Promise<string>;
}
export interface SttEngine {
  /** Transcribe an audio file. Returns "" when nothing intelligible. */
  transcribe(file: string): Promise<string>;
}

const MAX_MEDIA_TEXT = 8000;
const EXEC_TIMEOUT_MS = 120_000;

// ---- local CLI engines ----

export class TesseractOcr implements OcrEngine {
  private readonly bin: string;
  private readonly lang?: string;
  constructor(bin = "tesseract", lang?: string) {
    this.bin = bin;
    this.lang = lang;
  }
  async ocr(file: string): Promise<string> {
    const args = [...(this.lang ? ["-l", this.lang] : []), file, "stdout"];
    const { stdout } = await execFileP(this.bin, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  }
}

/**
 * whisper.cpp CLI (`whisper-cli`, formerly `main`). Expects a wav file; we convert with
 * ffmpeg first when the input isn't one. Model path is required (ggml-*.bin).
 */
export class WhisperCppStt implements SttEngine {
  private readonly bin: string;
  private readonly modelPath: string;
  private readonly lang?: string;
  private readonly ffmpegBin: string;
  constructor(bin: string, modelPath: string, lang?: string, ffmpegBin = "ffmpeg") {
    this.bin = bin;
    this.modelPath = modelPath;
    this.lang = lang;
    this.ffmpegBin = ffmpegBin;
  }
  async transcribe(file: string): Promise<string> {
    let wav = file;
    if (!/\.wav$/i.test(file)) {
      wav = `${file}.wav`;
      await execFileP(this.ffmpegBin, ["-y", "-i", file, "-ar", "16000", "-ac", "1", wav], { timeout: EXEC_TIMEOUT_MS });
    }
    try {
      const args = ["-m", this.modelPath, "-f", wav, "-nt", "--no-timestamps", ...(this.lang ? ["-l", this.lang] : [])];
      const { stdout } = await execFileP(this.bin, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      return stdout
        .split("\n")
        .map((l) => l.replace(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
    } finally {
      if (wav !== file) fs.rmSync(wav, { force: true });
    }
  }
}

// ---- pipeline ----

export type MediaKind = "photo" | "voice" | "audio" | "document-image";

export type MediaDeps = {
  ocr?: OcrEngine;
  stt?: SttEngine;
  /** Telegram file download: file_id -> saved local path. Injected so tests need no bot. */
  download: (fileId: string, hint: string) => Promise<string>;
  tmpDir?: string;
};

const LABEL: Record<MediaKind, string> = { photo: "a photo", voice: "a voice message", audio: "an audio file", "document-image": "an image document" };

export class MediaProcessor {
  private readonly ocr?: OcrEngine;
  private readonly stt?: SttEngine;
  private readonly download: MediaDeps["download"];
  private readonly tmpDir: string;

  constructor(deps: MediaDeps) {
    this.ocr = deps.ocr;
    this.stt = deps.stt;
    this.download = deps.download;
    this.tmpDir = deps.tmpDir ?? os.tmpdir();
  }

  /**
   * Download and understand one media item. Returns the text to feed the conversation
   * (with provenance), or undefined when no engine handles the kind — the caller then
   * sends the "I can't read that yet" note.
   */
  async process(kind: MediaKind, fileId: string, caption?: string): Promise<string | undefined> {
    const engine = kind === "photo" || kind === "document-image" ? this.ocr : this.stt;
    if (!engine) return undefined;
    const file = path.join(this.tmpDir, `crow-media-${cryptoRandom()}`);
    let written: string | undefined;
    try {
      written = await this.download(fileId, file);
      const text = kind === "photo" || kind === "document-image" ? await this.ocr!.ocr(written) : await this.stt!.transcribe(written);
      const cleaned = truncate(text.replace(/\s+$/gm, "").trim(), MAX_MEDIA_TEXT);
      if (!cleaned) return `[The user sent ${LABEL[kind]}${caption ? ` captioned "${caption}"` : ""}, but no ${kind === "photo" || kind === "document-image" ? "text could be read in it" : "speech could be understood in it"}.]`;
      const verb = kind === "photo" || kind === "document-image" ? "OCR read" : "transcribed";
      return `[The user sent ${LABEL[kind]}${caption ? ` captioned "${caption}"` : ""}; ${verb}:]\n${cleaned}`;
    } catch (err) {
      log.warn(`${kind} processing failed: ${(err as Error).message}`);
      return `[The user sent ${LABEL[kind]}${caption ? ` captioned "${caption}"` : ""}, but reading it failed (${truncate((err as Error).message, 120)}).]`;
    } finally {
      if (written) fs.rmSync(written, { force: true });
    }
  }

  /** Which kinds are usable with the configured engines (for the "can't read that" reply). */
  capabilities(): string {
    const can: string[] = [];
    if (this.ocr) can.push("photos");
    if (this.stt) can.push("voice messages");
    return can.length ? can.join(" and ") : "nothing yet";
  }
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
