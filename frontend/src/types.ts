export interface Bounds { south: number; west: number; north: number; east: number }
export interface Place { id: number; name: string; region: string; latitude: number; longitude: number }
export interface Selection { latitude: number; longitude: number; name: string; region: string; bounds: Bounds; custom?: boolean }
export interface Sample {
  id: number; latitude: number; longitude: number; pm25: number | null; aqi: number | null;
  grid_latitude: number | null; grid_longitude: number | null;
}
export interface AirData {
  bounds: Bounds; time: string; pm25: number; pm25_min: number; pm25_max: number;
  aqi: number | null; cigarettes_per_hour: number; samples: Sample[];
  sample_count: number; requested_samples: number; grid_cells: number; partial: boolean;
  hourly: { time: string; pm25: number; sample_count: number }[];
  source: string; resolution_km: number; fetched_at: string;
}
export type DataSource = 'stations' | 'purpleair' | 'model'
export interface Station {
  id: string; name: string; latitude: number; longitude: number; agency: string;
  pm25: number | null; time: string | null; time_end: string | null;
  confidence?: number | null; unavailable_reason?: string | null;
}
export interface StationData {
  bounds: Bounds; source: string; stations: Station[]; station_count: number;
  reporting_count: number; pm25: number | null; pm25_min: number | null; pm25_max: number | null;
  time_start: string | null; time_end: string | null; window_start: string; window_end: string;
  lookback_hours: number; hours_available: number; fetched_at: string;
}
export interface FireData {
  hotspots: {
    latitude: number; longitude: number; count: number; time: string; first_time: string;
    south: number; west: number; north: number; east: number;
    confidence: string | null; frp: number | null;
  }[];
  incidents: {
    id: string; name: string; latitude: number; longitude: number;
    source: 'NIFC' | 'GDACS'; source_url: string; hectares: number | null;
    acres: number | null; contained: number | null; updated_at: string | null; discovered_at: string | null;
    activity_at: string; activity_basis: string; activity_precision: 'day' | 'time';
  }[];
  detection_count: number; latest_detection: string | null; fetched_at: string;
  unavailable: string[]; window_hours: number;
}
