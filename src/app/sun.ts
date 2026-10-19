/**
 * Sunrise, sunset and the time-of-day phase for the home-page sky.
 *
 * Uses the NOAA solar-position approximation (accurate to a few minutes).
 * The location is estimated from the device's time zone, so no permission
 * prompt is needed: a representative city for common zones, otherwise the
 * longitude implied by the UTC offset.
 */

export type Phase = 'night' | 'dawn' | 'day' | 'golden' | 'dusk';

export interface SunTimes {
  sunrise: Date;
  sunset: Date;
}

export interface Location {
  lat: number;
  lon: number;
}

const RAD = Math.PI / 180;
const MINUTE = 60_000;

/** Representative coordinates for common time zones (one city each is close enough for sunset). */
const ZONES: Record<string, [number, number]> = {
  'Asia/Kolkata': [13.08, 80.27], // Chennai: south and central India share IST
  'Asia/Calcutta': [13.08, 80.27],
  'Asia/Colombo': [6.93, 79.86],
  'Asia/Karachi': [24.86, 67.0],
  'Asia/Dhaka': [23.81, 90.41],
  'Asia/Kathmandu': [27.72, 85.32],
  'Asia/Dubai': [25.2, 55.27],
  'Asia/Riyadh': [24.71, 46.68],
  'Asia/Singapore': [1.35, 103.82],
  'Asia/Kuala_Lumpur': [3.14, 101.69],
  'Asia/Bangkok': [13.76, 100.5],
  'Asia/Jakarta': [-6.2, 106.85],
  'Asia/Manila': [14.6, 120.98],
  'Asia/Shanghai': [31.23, 121.47],
  'Asia/Hong_Kong': [22.32, 114.17],
  'Asia/Tokyo': [35.68, 139.69],
  'Asia/Seoul': [37.57, 126.98],
  'Europe/London': [51.51, -0.13],
  'Europe/Dublin': [53.35, -6.26],
  'Europe/Paris': [48.86, 2.35],
  'Europe/Berlin': [52.52, 13.4],
  'Europe/Madrid': [40.42, -3.7],
  'Europe/Rome': [41.9, 12.5],
  'Europe/Amsterdam': [52.37, 4.9],
  'Europe/Moscow': [55.76, 37.62],
  'Europe/Istanbul': [41.01, 28.98],
  'Africa/Cairo': [30.04, 31.24],
  'Africa/Lagos': [6.52, 3.38],
  'Africa/Nairobi': [-1.29, 36.82],
  'Africa/Johannesburg': [-26.2, 28.05],
  'America/New_York': [40.71, -74.01],
  'America/Chicago': [41.88, -87.63],
  'America/Denver': [39.74, -104.99],
  'America/Los_Angeles': [34.05, -118.24],
  'America/Toronto': [43.65, -79.38],
  'America/Mexico_City': [19.43, -99.13],
  'America/Sao_Paulo': [-23.55, -46.63],
  'America/Argentina/Buenos_Aires': [-34.6, -58.38],
  'Australia/Sydney': [-33.87, 151.21],
  'Australia/Melbourne': [-37.81, 144.96],
  'Australia/Perth': [-31.95, 115.86],
  'Pacific/Auckland': [-36.85, 174.76],
};

export function estimateLocation(date: Date = new Date()): Location {
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* no Intl time zone support */
  }
  const known = ZONES[zone];
  if (known) return { lat: known[0], lon: known[1] };
  // Each hour of UTC offset is 15° of longitude; assume a mid-northern latitude.
  return { lat: 35, lon: (-date.getTimezoneOffset() / 60) * 15 };
}

/**
 * Sunrise and sunset on the local calendar day of `date`, or null during
 * polar day or night.
 */
export function sunTimes(date: Date, { lat, lon }: Location): SunTimes | null {
  const midnightUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const dayOfYear = Math.round((midnightUtc - Date.UTC(date.getFullYear(), 0, 1)) / 86_400_000) + 1;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);

  // Equation of time (minutes) and solar declination (radians).
  const eqTime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);

  // Hour angle when the sun's centre is 0.833° below the horizon (refraction + disc).
  const cosHourAngle = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) - Math.tan(lat * RAD) * Math.tan(decl);
  if (cosHourAngle > 1 || cosHourAngle < -1) return null;
  const hourAngle = Math.acos(cosHourAngle) / RAD;

  const sunriseMinutes = 720 - 4 * (lon + hourAngle) - eqTime;
  const sunsetMinutes = 720 - 4 * (lon - hourAngle) - eqTime;
  return {
    sunrise: new Date(midnightUtc + sunriseMinutes * MINUTE),
    sunset: new Date(midnightUtc + sunsetMinutes * MINUTE),
  };
}

/** Phase boundaries, in minutes relative to sunrise and sunset. */
const DAWN_START = -40;
const DAWN_END = 50;
const GOLDEN_START = -70;
const DUSK_END = 35;

export function phaseAt(now: Date, sun: SunTimes | null): Phase {
  if (!sun) {
    // Polar day or night: decide by season (sun up around the June solstice in the north).
    return now.getHours() >= 6 && now.getHours() < 18 ? 'day' : 'night';
  }
  const fromSunrise = (now.getTime() - sun.sunrise.getTime()) / MINUTE;
  const fromSunset = (now.getTime() - sun.sunset.getTime()) / MINUTE;
  if (fromSunrise < DAWN_START || fromSunset >= DUSK_END) return 'night';
  if (fromSunrise < DAWN_END) return 'dawn';
  if (fromSunset < GOLDEN_START) return 'day';
  if (fromSunset < 0) return 'golden';
  return 'dusk';
}

/**
 * Where the sun or moon sits on the sky arc, 0 (rising, left) to 1 (setting,
 * right): the sun between sunrise and sunset, the moon through the night.
 */
export function skyProgress(now: Date, sun: SunTimes | null): { t: number; isSun: boolean } {
  if (!sun) {
    const h = now.getHours() + now.getMinutes() / 60;
    return { t: (h % 12) / 12, isSun: h >= 6 && h < 18 };
  }
  const t = now.getTime();
  const rise = sun.sunrise.getTime();
  const set = sun.sunset.getTime();
  if (t >= rise && t < set) return { t: (t - rise) / (set - rise), isSun: true };
  const day = 86_400_000;
  const nightStart = t >= set ? set : set - day;
  const nightEnd = t >= set ? rise + day : rise;
  return { t: (t - nightStart) / (nightEnd - nightStart), isSun: false };
}
