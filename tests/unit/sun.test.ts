import { describe, expect, it } from 'vitest';
import { phaseAt, skyProgress, sunTimes } from '../../src/app/sun';

const CHENNAI = { lat: 13.08, lon: 80.27 };
const LONDON = { lat: 51.51, lon: -0.13 };
const IST = 5.5 * 60; // minutes

/** Local clock time "HH:MM" at a UTC offset (minutes). */
function clock(date: Date, offsetMinutes: number): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

describe('sunTimes', () => {
  it('matches published times for Chennai on 19 October (≈ 05:59 / 17:51 IST)', () => {
    const sun = sunTimes(new Date(2026, 9, 19, 12), CHENNAI)!;
    expect(Math.abs(minutes(clock(sun.sunrise, IST)) - minutes('05:59'))).toBeLessThanOrEqual(5);
    expect(Math.abs(minutes(clock(sun.sunset, IST)) - minutes('17:51'))).toBeLessThanOrEqual(5);
  });

  it('matches published times for London at midsummer (≈ 04:43 / 21:21 BST)', () => {
    const sun = sunTimes(new Date(2026, 5, 21, 12), LONDON)!;
    expect(Math.abs(minutes(clock(sun.sunrise, 60)) - minutes('04:43'))).toBeLessThanOrEqual(5);
    expect(Math.abs(minutes(clock(sun.sunset, 60)) - minutes('21:21'))).toBeLessThanOrEqual(5);
  });

  it('returns null during polar night', () => {
    expect(sunTimes(new Date(2026, 11, 21, 12), { lat: 78.2, lon: 15.6 })).toBeNull();
  });
});

describe('phaseAt', () => {
  const sun = sunTimes(new Date(2026, 9, 19, 12), CHENNAI)!;
  const at = (hhmm: string) => new Date(Date.UTC(2026, 9, 19) + (minutes(hhmm) - IST) * 60_000);

  it.each([
    ['04:30', 'night'],
    ['05:40', 'dawn'],
    ['06:30', 'dawn'],
    ['11:00', 'day'],
    ['17:00', 'golden'],
    ['18:10', 'dusk'], // the reported case: after sunset, not golden hour
    ['18:40', 'night'],
    ['23:00', 'night'],
  ])('Chennai, 19 October, %s IST → %s', (time, phase) => {
    expect(phaseAt(at(time), sun)).toBe(phase);
  });

  it('places the sun at the start, middle and end of the day', () => {
    const noon = new Date((sun.sunrise.getTime() + sun.sunset.getTime()) / 2);
    expect(skyProgress(sun.sunrise, sun)).toEqual({ t: 0, isSun: true });
    expect(skyProgress(noon, sun).t).toBeCloseTo(0.5, 5);
    expect(skyProgress(at('23:00'), sun).isSun).toBe(false);
  });
});
