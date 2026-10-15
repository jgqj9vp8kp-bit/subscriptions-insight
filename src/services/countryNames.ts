// Display labels of the user-level FunnelFox country codes (Dashboard Daily
// trials, GEO view and filter). English, like the rest of the page's copy; no
// flag emoji (Windows 10 renders them as two letters). A code that is not an
// upper-case ISO alpha-2 value is shown raw: GEO rows group by the raw value
// (parity with the Cohorts GEO filter), so a label must never merge two rows.
let dn: Intl.DisplayNames | null = null;
try {
  dn = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
  dn = null;
}

/** "MX · Mexico"; "Unknown" and non-standard codes unchanged. */
export function countryLabel(code: string): string {
  if (code === "Unknown") return "Unknown";
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    const name = dn?.of(code);
    return name && name !== code ? `${code} · ${name}` : code;
  } catch {
    return code;
  }
}

/** True for a raw value that is neither "Unknown" nor an upper-case alpha-2 code. */
export function isNonStandardCountryCode(code: string): boolean {
  return code !== "Unknown" && !/^[A-Z]{2}$/.test(code);
}
