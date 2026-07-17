import { homedir } from "node:os";
import { join } from "node:path";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name}=${JSON.stringify(raw)} is not a positive number`);
  }
  return n;
}

export interface EngineConfig {
  dataDir: string;
  dbPath: string;
  ollamaBaseUrl: string;
  chatModel: string;
  visionModel: string;
  embedModel: string;
  embedDims: number;
  keepAliveChat: string;
  keepAliveVision: string;
  keepAliveEmbed: string;
  maxInjectionTokens: number;
  maxFacts: number;
  factConfidence: number;
  whisperBin: string;
  whisperModel: string;
  maxUploadBytes: number;
  ingestConcurrency: number;
}

export function loadConfig(): EngineConfig {
  const rawDataDir = env("MVP_DATA_DIR", join(homedir(), ".mvp"));
  const dataDir = rawDataDir.startsWith("~/") ? join(homedir(), rawDataDir.slice(2)) : rawDataDir;
  const factConfidence = Number(env("MVP_FACT_CONFIDENCE", "0.6"));
  if (!Number.isFinite(factConfidence) || factConfidence < 0 || factConfidence > 1) {
    throw new Error(`MVP_FACT_CONFIDENCE must be in [0,1], got ${factConfidence}`);
  }
  return Object.freeze({
    dataDir,
    dbPath: join(dataDir, "mvp.db"),
    ollamaBaseUrl: env("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
    chatModel: env("MVP_CHAT_MODEL", "glm-4.7-flash:q8_0"),
    visionModel: env("MVP_VISION_MODEL", "qwen3-vl:8b"),
    embedModel: env("MVP_EMBED_MODEL", "mxbai-embed-large"),
    embedDims: envInt("MVP_EMBED_DIMS", 1024),
    keepAliveChat: env("MVP_KEEP_ALIVE", "10m"),
    keepAliveVision: "2m",
    keepAliveEmbed: "1h",
    maxInjectionTokens: envInt("MVP_MAX_INJECTION_TOKENS", 4000),
    maxFacts: envInt("MVP_MAX_FACTS", 500),
    factConfidence,
    whisperBin: env("MVP_WHISPER_BIN", "mlx_whisper"),
    whisperModel: env("MVP_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo"),
    maxUploadBytes: envInt("MVP_MAX_UPLOAD_MB", 200) * 1024 * 1024,
    ingestConcurrency: envInt("MVP_INGEST_CONCURRENCY", 1),
  });
}

export const config = loadConfig();
