import {
  addDays,
  eachDayOfInterval,
  format,
  isSameDay,
  isWeekend,
  parseISO,
  startOfWeek,
} from 'date-fns';

export const toISODate = (d: Date): string => format(d, 'yyyy-MM-dd');

export const fromISODate = (s: string): Date => parseISO(s);

export const formatDayHeading = (s: string): string => format(parseISO(s), 'EEE, MMMM d');

export const formatShortWeekday = (d: Date): string => format(d, 'EEE').toUpperCase();

export const formatDayNumber = (d: Date): string => format(d, 'd');

export const isToday = (s: string): boolean => isSameDay(parseISO(s), new Date());

export function getWeekDates(anchorISO: string): Date[] {
  const start = startOfWeek(parseISO(anchorISO), { weekStartsOn: 1 });
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function weekRangeLabel(dateISO: string): string {
  const weekDates = getWeekDates(dateISO);
  const first = weekDates[0];
  const last = weekDates[6];
  const sameMonth = format(first, 'MMM') === format(last, 'MMM');
  return sameMonth
    ? `${format(first, 'MMM d')}-${format(last, 'd')}`
    : `${format(first, 'MMM d')} - ${format(last, 'MMM d')}`;
}

export function shiftDateISO(dateISO: string, delta: number): string {
  return toISODate(addDays(parseISO(dateISO), delta));
}

export function datesInRange(startISO: string, endISO: string, skipWeekends: boolean): string[] {
  const start = parseISO(startISO);
  const end = parseISO(endISO);
  if (end < start) return [];
  return eachDayOfInterval({ start, end })
    .filter((d) => !skipWeekends || !isWeekend(d))
    .map(toISODate);
}
