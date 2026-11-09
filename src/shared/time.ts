// Beijing (Asia/Shanghai, fixed UTC+8, no DST) calendar helpers shared by web and server.

const OFFSET_MS = 8 * 3600 * 1000;

/** YYYY-MM-DD of the instant in Beijing time. */
export function beijingDate(instant: Date | string | number): string {
  const d = new Date(new Date(instant).getTime() + OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

/** HH:mm of the instant in Beijing time. */
export function beijingTime(instant: Date | string | number): string {
  const d = new Date(new Date(instant).getTime() + OFFSET_MS);
  return d.toISOString().slice(11, 16);
}

/**
 * "9月28日" of a calendar date (YYYY-MM-DD). Given `today` (YYYY-MM-DD, Beijing), a day of another year carries its
 * year, so an archived item is not read as this year's: "2019年2月19日".
 */
export function monthDay(date: string, today?: string): string {
  const year = today && date.slice(0, 4) !== today.slice(0, 4) ? `${date.slice(0, 4)}年` : "";
  return `${year}${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

/** "9月29日" in Beijing time. */
export const beijingDay = (instant: Date | string | number) => monthDay(beijingDate(instant));

/** "9月29日 13:40" in Beijing time. */
export const beijingStamp = (instant: Date | string | number) => `${beijingDay(instant)} ${beijingTime(instant)}`;

/** "2026-11-05 00:00:35" in Beijing time. */
export function beijingDateTimeSec(instant: Date | string | number): string {
  const ms = new Date(instant).getTime();
  if (Number.isNaN(ms)) return String(instant);
  const d = new Date(ms + OFFSET_MS);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
