import type { Config } from "./config.ts";

export type Coordinates = { latitude: number; longitude: number };
export type GeocodeCandidate = Coordinates & { name: string; address?: string; confidence?: number; source?: string };
export type Geocoder = { search(query: string): Promise<GeocodeCandidate[]> };
export type GeocoderOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  parse?: (body: unknown) => GeocodeCandidate[];
};

export const MAX_LOCATION_NAME = 160;
export const MAX_LOCATION_ADDRESS = 300;
export const MAX_GEOCODE_RESULTS = 5;

export function validateCoordinates(value: Coordinates): Coordinates {
  if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90) throw new Error("latitude must be finite and between -90 and 90");
  if (!Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) throw new Error("longitude must be finite and between -180 and 180");
  return value;
}

export function validateLocationText(value: string, field: "name" | "address") {
  const text = value.trim();
  const max = field === "name" ? MAX_LOCATION_NAME : MAX_LOCATION_ADDRESS;
  if (!text || text.length > max) throw new Error(`${field} must be between 1 and ${max} characters`);
  return text;
}

export function validateMapsUrl(value: string) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || value.length > 2_000) throw new Error();
    return url.toString();
  } catch {
    throw new Error("maps_url must be a valid http(s) URL");
  }
}

function defaultParse(body: unknown): GeocodeCandidate[] {
  const rows = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results) ? (body as { results: unknown[] }).results : [];
  return rows.slice(0, MAX_GEOCODE_RESULTS).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const latitude = Number(r.latitude ?? r.lat ?? (r.geometry as Record<string, unknown> | undefined)?.lat);
    const longitude = Number(r.longitude ?? r.lon ?? r.lng ?? (r.geometry as Record<string, unknown> | undefined)?.lng);
    const name = typeof r.name === "string" ? r.name : typeof r.display_name === "string" ? r.display_name : "";
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    try {
      validateCoordinates({ latitude, longitude });
      return [{ latitude, longitude, name: validateLocationText(name, "name"), address: typeof r.address === "string" ? r.address.slice(0, MAX_LOCATION_ADDRESS) : undefined, confidence: typeof r.confidence === "number" ? r.confidence : undefined, source: typeof r.source === "string" ? r.source.slice(0, 80) : undefined }];
    } catch {
      return [];
    }
  });
}

export class HttpGeocoder implements Geocoder {
  private readonly cfg: Pick<Config, "GEOCODER_URL" | "GEOCODER_API_KEY" | "GEOCODER_TIMEOUT_MS" | "GEOCODER_MIN_INTERVAL_MS">;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly parse: (body: unknown) => GeocodeCandidate[];
  private nextAllowed = 0;

  constructor(cfg: Pick<Config, "GEOCODER_URL" | "GEOCODER_API_KEY" | "GEOCODER_TIMEOUT_MS" | "GEOCODER_MIN_INTERVAL_MS">, opts: GeocoderOptions = {}) {
    this.cfg = cfg;
    this.fetcher = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.parse = opts.parse ?? defaultParse;
  }

  async search(query: string) {
    const clean = query.trim();
    if (!clean || clean.length > MAX_LOCATION_ADDRESS) throw new Error("geocoder query is invalid");
    if (!this.cfg.GEOCODER_URL) return [];
    const wait = Math.max(0, this.nextAllowed - this.now());
    if (wait) await this.sleep(wait);
    this.nextAllowed = this.now() + this.cfg.GEOCODER_MIN_INTERVAL_MS;
    const url = new URL(this.cfg.GEOCODER_URL);
    url.searchParams.set("q", clean);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.GEOCODER_TIMEOUT_MS);
    try {
      const res = await this.fetcher(url, { signal: controller.signal, headers: this.cfg.GEOCODER_API_KEY ? { authorization: `Bearer ${this.cfg.GEOCODER_API_KEY}` } : {} });
      if (!res.ok) throw new Error(`geocoder returned HTTP ${res.status}`);
      const body = await res.json();
      return this.parse(body).slice(0, MAX_GEOCODE_RESULTS);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error("geocoder timed out");
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function configuredGeocoder(cfg: Config, opts?: GeocoderOptions): Geocoder | undefined {
  return cfg.GEOCODER_URL ? new HttpGeocoder(cfg, opts) : undefined;
}
