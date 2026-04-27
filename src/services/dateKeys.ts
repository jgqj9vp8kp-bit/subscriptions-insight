export function toDateKey(value: Date | string | null | undefined): string {
  if (!value) return "";

  if (value instanceof Date) {
    return formatParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  const raw = String(value).trim();
  if (!raw) return "";

  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;

  const dottedDate = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dottedDate) return formatParts(Number(dottedDate[3]), Number(dottedDate[2]), Number(dottedDate[1]));

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return formatParts(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }

  return "";
}

export function formatDateKey(value: Date | string | null | undefined): string {
  const dateKey = toDateKey(value);
  if (!dateKey) return "";
  const [year, month, day] = dateKey.split("-");
  return `${day}.${month}.${year}`;
}

function formatParts(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
