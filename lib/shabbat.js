// lib/shabbat.js
//
// Shabbat detection + candle lighting / havdalah times for a given date.
// Default location: NYC (40.7128, -74.0060). Override via env:
//   SHABBAT_LAT, SHABBAT_LON, SHABBAT_TZ
//
// Conventions:
//   candle lighting = sunset - 18 minutes (Ashkenazi default)
//   havdalah         = sunset + 50 minutes Saturday (3 stars / Tzeit hakochavim)
//
// Shabbat is the window from Friday's candle lighting to Saturday's
// havdalah. The mode filters the work pillar out of focus but keeps
// personal + training surfaces live.

'use strict';

const SunCalc = require('suncalc');

const DEFAULTS = {
  lat: Number(process.env.SHABBAT_LAT) || 40.7128,
  lon: Number(process.env.SHABBAT_LON) || -74.0060,
  tz: process.env.SHABBAT_TZ || 'America/New_York',
  candleOffsetMin: 18,
  havdalahOffsetMin: 50,
};

// Returns parts {weekday, year, month, day, hour, minute} in the configured tz.
function tzParts(date, tz = DEFAULTS.tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some Node versions emit "24" for midnight
  return {
    weekday: parts.weekday,
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour,
    minute: parseInt(parts.minute, 10),
  };
}

function fmtClock(date, tz = DEFAULTS.tz) {
  return date.toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// Returns the JS Date for a given local Y-M-D in the configured tz.
// Used to anchor sun calculations on the right calendar day.
function localNoonOn(year, month, day, tz = DEFAULTS.tz) {
  // Build noon UTC then offset to noon-local via toLocaleString round-trip.
  // Noon is fine because we only care about sunset on that day.
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/**
 * Friday candle lighting time for the calendar week containing `now`.
 * Returns a Date.
 */
function candleLightingFor(now, opts = {}) {
  const { lat, lon, tz, candleOffsetMin } = { ...DEFAULTS, ...opts };
  const today = tzParts(now, tz);
  // Find the Friday of this week.
  // weekday short: Sun, Mon, Tue, Wed, Thu, Fri, Sat
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[today.weekday];
  const deltaToFri = (5 - idx + 7) % 7;
  // If today is already Saturday, "this week's Friday" was yesterday — go forward to next Friday.
  // For Friday itself deltaToFri is 0 (correct).
  const friNoon = localNoonOn(today.year, today.month, today.day + deltaToFri, tz);
  const sun = SunCalc.getTimes(friNoon, lat, lon);
  return new Date(sun.sunset.getTime() - candleOffsetMin * 60 * 1000);
}

/**
 * Saturday havdalah for the calendar week containing `now`.
 */
function havdalahFor(now, opts = {}) {
  const { lat, lon, tz, havdalahOffsetMin } = { ...DEFAULTS, ...opts };
  const today = tzParts(now, tz);
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[today.weekday];
  const deltaToSat = (6 - idx + 7) % 7;
  const satNoon = localNoonOn(today.year, today.month, today.day + deltaToSat, DEFAULTS.tz);
  const sun = SunCalc.getTimes(satNoon, lat, lon);
  return new Date(sun.sunset.getTime() + havdalahOffsetMin * 60 * 1000);
}

/**
 * Is `now` inside the Shabbat window? Friday candle lighting → Saturday havdalah.
 */
function isShabbat(now = new Date(), opts = {}) {
  const candle = candleLightingFor(now, opts);
  const hav = havdalahFor(now, opts);
  // Walk back to PRIOR Friday's candle if today is Sun/Mon/Tue/Wed/Thu earlier in the week.
  // candleLightingFor returns THIS week's Friday — that may be in the future.
  // For Sun-Wed today, this week's Friday is in the future, so we're not in Shabbat.
  // For Thu today, this week's Friday is in the future too.
  // For Fri+Sat today, the candle/havdalah pair are correctly in the same week.
  // For Sun (which is +1 from prior week's Saturday), the prior week's window already closed.
  // So a simple "between this week's Friday candle and Saturday havdalah" works for all days.
  return now >= candle && now < hav;
}

function shabbatStatus(now = new Date(), opts = {}) {
  const tz = (opts.tz || DEFAULTS.tz);
  const candle = candleLightingFor(now, opts);
  const hav = havdalahFor(now, opts);
  const today = tzParts(now, tz);
  const inWindow = isShabbat(now, opts);

  return {
    in_shabbat: inWindow,
    candle_lighting_time_iso: candle.toISOString(),
    candle_lighting_time_label: fmtClock(candle, tz),
    havdalah_time_iso: hav.toISOString(),
    havdalah_time_label: fmtClock(hav, tz),
    weekday: today.weekday,
    is_friday: today.weekday === 'Fri',
    is_saturday: today.weekday === 'Sat',
  };
}

module.exports = {
  isShabbat,
  candleLightingFor,
  havdalahFor,
  shabbatStatus,
  DEFAULTS,
};
