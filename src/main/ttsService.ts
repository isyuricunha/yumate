import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type TtsPlaybackRequest, type TtsSettings } from "../shared/types";

export class TtsService {
  private readonly cacheDirectory: string;
  private activeProcess: ReturnType<typeof spawn> | null = null;
  private queue: Promise<TtsPlaybackRequest | null> = Promise.resolve(null);

  constructor(userDataPath: string) {
    this.cacheDirectory = path.join(userDataPath, "tts-cache");
    fs.mkdirSync(this.cacheDirectory, { recursive: true });
  }

  synthesize(text: string, settings: TtsSettings): Promise<TtsPlaybackRequest | null> {
    if (settings.muted || !text.trim()) {
      return Promise.resolve(null);
    }

    this.queue = this.queue.then(() => this.createAudio(text, settings));
    return this.queue;
  }

  stop(): void {
    this.activeProcess?.kill();
    this.activeProcess = null;
    this.queue = Promise.resolve(null);
  }

  private async createAudio(text: string, settings: TtsSettings): Promise<TtsPlaybackRequest> {
    const id = randomUUID();
    const filePath = path.join(this.cacheDirectory, `${id}.mp3`);
    await this.runEdgeTts(text, filePath, settings);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      throw new Error("EdgeTTS returned no audio data. Install the Python edge_tts package or check network access.");
    }

    const audio = fs.readFileSync(filePath);

    return {
      id,
      text,
      audioUrl: `data:audio/mpeg;base64,${audio.toString("base64")}`,
      voice: settings.voice,
      rate: settings.rate,
      pitch: settings.pitch,
      volume: settings.volume,
    };
  }

  private async runEdgeTts(text: string, filePath: string, settings: TtsSettings): Promise<void> {
    const attempts: Array<[string, string[]]> = [
      [
        "python",
        [
          "-m",
          "edge_tts",
          "-t",
          text,
          "-v",
          settings.voice,
          "--rate",
          normalizeRate(settings.rate),
          "--pitch",
          normalizePitch(settings.pitch),
          "--volume",
          normalizeVolume(settings.volume),
          "--write-media",
          filePath,
        ],
      ],
      [
        "py",
        [
          "-m",
          "edge_tts",
          "-t",
          text,
          "-v",
          settings.voice,
          "--rate",
          normalizeRate(settings.rate),
          "--pitch",
          normalizePitch(settings.pitch),
          "--volume",
          normalizeVolume(settings.volume),
          "--write-media",
          filePath,
        ],
      ],
    ];

    const errors: string[] = [];
    for (const [command, args] of attempts) {
      try {
        await this.spawnEdgeTts(command, args);
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(`EdgeTTS failed. ${errors.join(" ")}`);
  }

  private spawnEdgeTts(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.activeProcess = child;
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("EdgeTTS synthesis timed out."));
      }, 60000);

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        this.activeProcess = null;
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        this.activeProcess = null;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `${command} exited with code ${code}.`));
        }
      });
    });
  }
}

function normalizeRate(rate: string): string {
  if (/^[+-]\d+%$/.test(rate)) {
    return rate;
  }

  const map: Record<string, string> = {
    "x-slow": "-50%",
    slow: "-25%",
    medium: "+0%",
    default: "+0%",
    fast: "+25%",
    "x-fast": "+50%",
  };

  return map[rate] ?? "+0%";
}

function normalizePitch(pitch: string): string {
  if (/^[+-]\d+Hz$/.test(pitch)) {
    return pitch;
  }

  const map: Record<string, string> = {
    "x-low": "-20Hz",
    low: "-10Hz",
    medium: "+0Hz",
    default: "+0Hz",
    high: "+10Hz",
    "x-high": "+20Hz",
  };

  return map[pitch] ?? "+0Hz";
}

function normalizeVolume(volume: number): string {
  const percent = Math.round((volume - 1) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}
