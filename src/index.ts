import { HttpClient, type FreeAstroOptions, type RawResponse, type RequestOptions } from "./client";
import { GeneratedResources } from "./generated/resources";
import { GeoResource, MoonResource, SkyEventsResource, WesternResource } from "./resources";

export const VERSION = "0.3.0";

/**
 * FreeAstroAPI client. Resources follow the API paths: `client.western.natal.insights(...)`
 * calls `POST /api/v1/western/natal/insights`. Where an operation exists in several API
 * versions, the plain method name calls the latest version and older ones carry a suffix
 * (`client.vedic.chart` is v2, `client.vedic.chartV1` is v1).
 */
export class FreeAstro extends GeneratedResources {
  readonly geo: GeoResource;
  readonly moon: MoonResource;
  readonly skyEvents: SkyEventsResource;
  readonly western: WesternResource;

  private readonly http: HttpClient;

  constructor(options: FreeAstroOptions) {
    const http = new HttpClient(options);
    super(http);
    this.http = http;
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
export * from "./resources";
export * from "./generated/resources";
export type * as Schemas from "./generated/schemas";
