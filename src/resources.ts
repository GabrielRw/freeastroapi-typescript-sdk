import type { EndpointRequestOptions } from "./client";
import { HttpClient } from "./client";
import type {
  CitySearchResponse,
  GeoSearchParams,
  MoonMonthParams,
  MoonMonthResponse,
  MoonPhaseParams,
  MoonPhaseResponse,
  SkyEventsParams,
  SkyEventsResponse,
  WesternSignRequest,
  WesternSignResponse,
} from "./types";

export class GeoResource {
  constructor(private readonly client: HttpClient) {}

  search(params: GeoSearchParams, options?: EndpointRequestOptions) {
    return this.client.request<CitySearchResponse>("GET", "/api/v2/geo/search", { ...options, query: params });
  }
}

export class MoonResource {
  constructor(private readonly client: HttpClient) {}

  phase(params: MoonPhaseParams = {}, options?: EndpointRequestOptions) {
    return this.client.request<MoonPhaseResponse>("GET", "/api/v1/moon/phase", { ...options, query: params });
  }

  month(params: MoonMonthParams, options?: EndpointRequestOptions) {
    return this.client.request<MoonMonthResponse>("GET", "/api/v1/moon/month", { ...options, query: params });
  }
}

export class SkyEventsResource {
  constructor(private readonly client: HttpClient) {}

  list(params: SkyEventsParams, options?: EndpointRequestOptions) {
    return this.client.request<SkyEventsResponse>("GET", "/api/v1/sky-events", { ...options, query: params });
  }
}

export class WesternSignsResource {
  constructor(private readonly client: HttpClient) {}

  sun(body: WesternSignRequest, options?: EndpointRequestOptions) {
    return this.calculate("sun", body, options);
  }

  moon(body: WesternSignRequest, options?: EndpointRequestOptions) {
    return this.calculate("moon", body, options);
  }

  rising(body: WesternSignRequest, options?: EndpointRequestOptions) {
    return this.calculate("rising", body, options);
  }

  midheaven(body: WesternSignRequest, options?: EndpointRequestOptions) {
    return this.calculate("midheaven", body, options);
  }

  private calculate(point: "sun" | "moon" | "rising" | "midheaven", body: WesternSignRequest, options?: EndpointRequestOptions) {
    return this.client.request<WesternSignResponse>("POST", `/api/v1/western/signs/${point}`, { ...options, body });
  }
}

export class WesternResource {
  readonly signs: WesternSignsResource;

  constructor(client: HttpClient) {
    this.signs = new WesternSignsResource(client);
  }
}
