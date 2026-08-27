export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[] | null | undefined;
export type Query = object;

export type HouseSystem = "placidus" | "whole_sign" | "equal" | "regiomontanus" | "koch" | "porphyry";
export type ZodiacType = "tropical" | "sidereal";
export type SiderealAyanamsa = "lahiri" | "raman" | "kp" | "fagan_bradley";

export type ZodiacSignId =
  | "aries"
  | "taurus"
  | "gemini"
  | "cancer"
  | "leo"
  | "virgo"
  | "libra"
  | "scorpio"
  | "sagittarius"
  | "capricorn"
  | "aquarius"
  | "pisces";

export interface GeoSearchParams {
  q: string;
  limit?: number;
  country?: string;
}

export interface City {
  name: string;
  country: string;
  state?: string | null;
  district?: string | null;
  lat: number;
  lng: number;
  timezone: string;
  population: number;
}

export interface CitySearchResponse {
  results: City[];
  count: number;
}

export interface MoonLocationParams {
  city?: string;
  lat?: number;
  lon?: number;
  tz_str?: string;
  include_eclipse?: boolean;
  include_forecast?: boolean;
}

export interface MoonPhaseParams extends MoonLocationParams {
  date?: string;
}

export interface MoonMonthParams extends MoonLocationParams {
  year: number;
  month: number;
}

export type MoonPhaseName =
  | "New Moon"
  | "Waxing Crescent"
  | "First Quarter"
  | "Waxing Gibbous"
  | "Full Moon"
  | "Waning Gibbous"
  | "Last Quarter"
  | "Waning Crescent";

export interface MoonPhaseData {
  name: MoonPhaseName;
  phase_angle_deg: number;
  illumination: number;
  age_days: number;
  distance_km: number;
  is_waxing: boolean;
}

export type EclipseKind = "solar" | "lunar";
export type EclipseType = "total" | "annular" | "hybrid" | "partial" | "penumbral";

export interface EclipseData {
  is_eclipse: boolean;
  is_blood_moon: boolean;
  kind?: EclipseKind;
  type?: EclipseType;
  date?: string;
  starts_at?: string;
  ends_at?: string;
  central_phase_starts_at?: string;
  central_phase_ends_at?: string;
  visibility?: string;
  visible_at_location?: boolean;
  type_at_location?: "total" | "annular" | "partial";
  days_from_query?: number;
  magnitude?: number;
  obscuration?: number;
  maximum_location?: { lat: number; lon: number };
  local_starts_at?: string;
  local_maximum_at?: string;
  local_ends_at?: string;
  magnitude_at_location?: number;
  obscuration_at_location?: number;
}

export interface NextMoonPhases {
  new_moon: string;
  first_quarter: string;
  full_moon: string;
  last_quarter: string;
}

export interface MoonPhaseResponse {
  timestamp: string;
  phase: MoonPhaseData;
  eclipse?: EclipseData;
  next_phases: NextMoonPhases;
}

export interface MoonMonthDay extends MoonPhaseResponse {
  calendar_date: string;
}

export interface MoonMonthResponse {
  year: number;
  month: number;
  month_name: string;
  days_in_month: number;
  calendar_basis: "local" | "utc";
  calendar_timezone: string;
  days: MoonMonthDay[];
}

export interface SkyEventsParams {
  date: string;
  timezone?: string;
  include_moon?: boolean;
  include_exact_hits?: boolean;
  include_moon_exact_hits?: boolean;
  include_ingresses?: boolean;
  include_retrogrades?: boolean;
  include_lunations?: boolean;
  include_formulation?: boolean;
}

export type SkyEventType = "moon_ingress" | "planet_ingress" | "exact_aspect" | "retrograde_station" | "lunation";
export type SkyEventImportance = "daily" | "medium" | "major";

export interface SkyEvent {
  id: string;
  type: SkyEventType;
  title: string;
  formulation?: string;
  exact_time: string;
  importance: SkyEventImportance;
  body?: string;
  sign?: string;
  bodies?: string[];
  aspect?: "conjunction" | "sextile" | "square" | "trine" | "opposition";
  angle?: 0 | 60 | 90 | 120 | 180;
  orb?: number;
  direction?: "retrograde" | "direct";
  phase?: "new_moon" | "full_moon";
}

export interface SkyEventsResponse {
  date: string;
  timezone: string;
  events: SkyEvent[];
}

interface WesternSignBirthBase {
  name?: string;
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  time_known?: boolean;
  tz_str?: string;
  house_system?: HouseSystem;
  zodiac_type?: ZodiacType;
  sidereal_ayanamsa?: SiderealAyanamsa;
}

export type WesternSignRequest = WesternSignBirthBase & (
  | { city: string; lat?: number; lng?: number }
  | { city?: string; lat: number; lng: number }
);

export interface WesternSignResponse {
  point: string;
  sign: string;
  sign_id: ZodiacSignId;
  degree: number;
  abs_pos: number;
  house: number;
  interpretation: null;
}

export interface ErrorResponse {
  detail?: unknown;
  error?: string;
  message?: string;
  code?: string;
  trace_id?: string;
  [key: string]: unknown;
}
