import "server-only";

/**
 * CSV, written out properly.
 *
 * Joining with commas is the version everyone writes first and it breaks on the
 * first customer called "Tan Holdings, Sdn Bhd". Fields are quoted when they
 * contain a comma, a quote, or a newline, and embedded quotes are doubled, per
 * RFC 4180.
 *
 * The leading BOM is deliberate: without it Excel on Windows reads UTF-8 as the
 * system code page and every accented name comes out as mojibake.
 */
export function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  const lines = [header, ...rows].map((row) => row.map(escapeField).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

function escapeField(value: string | number): string {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
