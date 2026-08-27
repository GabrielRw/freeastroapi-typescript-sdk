import { HttpClient, type FreeAstroOptions, type RawResponse, type RequestOptions } from "./client";
import { GeoResource, MoonResource, SkyEventsResource, WesternResource } from "./resources";

export const VERSION = "0.1.0";

export class FreeAstro {
  readonly geo: GeoResource;
  readonly moon: MoonResource;
  readonly skyEvents: SkyEventsResource;
  readonly western: WesternResource;

  private readonly http: HttpClient;

  constructor(options: FreeAstroOptions) {
    this.http = new HttpClient(options);
    this.geo = new GeoResource(this.http);
    this.moon = new MoonResource(this.http);
    this.skyEvents = new SkyEventsResource(this.http);
    this.western = new WesternResource(this.http);
  }

  request<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>(method, path, options);
  }

  requestRaw<T>(method: string, path: string, options?: RequestOptions): Promise<RawResponse<T>> {
    return this.http.requestRaw<T>(method, path, options);
  }
}

export * from "./client";
export * from "./errors";
export * from "./types";
