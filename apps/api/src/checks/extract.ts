import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

export type StockState = 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
export type FieldState = 'OK' | 'MISSING' | 'INVALID_SELECTOR';

export interface FieldRule {
  id?: string;
  name: string;
  selector: string;
  extractType: 'TEXT' | 'ATTRIBUTE';
  attribute?: string | null;
  role: 'TEXT' | 'PRICE' | 'STOCK' | 'QUANTITY';
  inStockTerms?: string[];
  outOfStockTerms?: string[];
}

export interface ExtractedField {
  status: FieldState;
  value: string | null;
  numeric: number | null;
  stock: StockState | null;
  error?: string;
}

// Out-of-stock terms are tested first, because "nicht verfügbar" contains "verfügbar".
const DEFAULT_OUT_OF_STOCK = [
  'out of stock', 'outofstock', 'sold out', 'soldout', 'not available', 'unavailable',
  'nicht auf lager', 'nicht verfügbar', 'nicht lieferbar', 'ausverkauft', 'vergriffen',
  'non disponibile', 'esaurito', 'esaurita', 'non disponible', 'rupture de stock', 'épuisé',
  'agotado', 'sin stock', 'no disponible',
];
const DEFAULT_IN_STOCK = [
  'in stock', 'instock', 'available', 'auf lager', 'an lager', 'verfügbar', 'lieferbar', 'sofort lieferbar',
  'disponibile', 'in magazzino', 'disponible', 'en stock',
];

// Keeps history bounded. The hash means a change past the cut-off is still detected.
export const MAX_VALUE_LENGTH = 10_000;
// The largest whole number the lastNumeric column, Decimal(18,4), can hold.
const MAX_NUMERIC = 1e14;

function normalize(text: string): string {
  // PostgreSQL text columns cannot store NUL.
  const clean = text.replaceAll('\0', '').replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_VALUE_LENGTH) return clean;
  const hash = createHash('sha256').update(clean).digest('hex').slice(0, 16);
  return `${clean.slice(0, MAX_VALUE_LENGTH)}… [truncated, sha256:${hash}]`;
}

export function selectorError(selector: string): string | null {
  try {
    cheerio.load('<html></html>')(selector);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid CSS selector';
  }
}

/** Parses "CHF 1'299.50", "1.299,50 €", "1,299.50" and "19.-" into a number. */
export function parseNumber(raw: string): number | null {
  const match = /\d[\d'’\s.,]*/.exec(raw);
  if (!match) return null;
  let text = match[0].replace(/['’\s]/g, '').replace(/[.,]$/, '');
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  const decimalAt = Math.max(lastDot, lastComma);
  if (decimalAt !== -1) {
    const separators = (text.match(/[.,]/g) ?? []).length;
    const digitsAfter = text.length - decimalAt - 1;
    const isThousands = separators === 1 && digitsAfter === 3;
    text = isThousands
      ? text.replace(/[.,]/g, '')
      : text.slice(0, decimalAt).replace(/[.,]/g, '') + '.' + text.slice(decimalAt + 1);
  }
  const value = Number(text);
  return Number.isFinite(value) && value < MAX_NUMERIC ? value : null;
}

export function detectStock(value: string | null, rule: FieldRule): StockState {
  if (value === null) return 'UNKNOWN';
  const text = value.toLowerCase();
  const out = [...(rule.outOfStockTerms ?? []), ...DEFAULT_OUT_OF_STOCK];
  const inStock = [...(rule.inStockTerms ?? []), ...DEFAULT_IN_STOCK];
  if (out.some((term) => text.includes(term.toLowerCase()))) return 'OUT_OF_STOCK';
  if (inStock.some((term) => text.includes(term.toLowerCase()))) return 'IN_STOCK';
  return 'UNKNOWN';
}

function readElement($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0], rule: FieldRule): string | null {
  const node = $(element);
  const raw = rule.extractType === 'ATTRIBUTE' ? node.attr(rule.attribute ?? '') : node.text();
  return raw === undefined ? null : normalize(raw);
}

export function extractField($: cheerio.CheerioAPI, rule: FieldRule): ExtractedField {
  let matches: ReturnType<cheerio.CheerioAPI>;
  try {
    matches = $(rule.selector);
  } catch (error) {
    return {
      status: 'INVALID_SELECTOR',
      value: null,
      numeric: null,
      stock: null,
      error: error instanceof Error ? error.message : 'Invalid CSS selector',
    };
  }

  const missing: ExtractedField = {
    status: 'MISSING',
    value: null,
    numeric: null,
    stock: rule.role === 'STOCK' || rule.role === 'QUANTITY' ? 'UNKNOWN' : null,
  };
  if (matches.length === 0) return missing;

  // A text field tracks every match, so a change in any list item counts. The others read one value.
  const values = (rule.role === 'TEXT' ? matches.toArray() : matches.toArray().slice(0, 1))
    .map((element) => readElement($, element, rule))
    .filter((value): value is string => value !== null);
  if (values.length === 0) return missing;
  const value = values.join(' | ');

  switch (rule.role) {
    case 'PRICE':
      return { status: 'OK', value, numeric: parseNumber(value), stock: null };
    case 'QUANTITY': {
      const numeric = parseNumber(value);
      const stock: StockState = numeric === null ? detectStock(value, rule) : numeric > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
      return { status: 'OK', value, numeric, stock };
    }
    case 'STOCK':
      return { status: 'OK', value, numeric: null, stock: detectStock(value, rule) };
    default:
      return { status: 'OK', value, numeric: null, stock: null };
  }
}

export function extractFields(html: string, rules: FieldRule[]): Map<FieldRule, ExtractedField> {
  const $ = cheerio.load(html);
  // Script and style content is not page text and changes on every build.
  $('script, style, noscript').remove();
  return new Map(rules.map((rule) => [rule, extractField($, rule)]));
}

/** One product-level answer: any "out" wins over "in", and no information stays UNKNOWN. */
export function overallStock(extracted: Iterable<ExtractedField>): StockState {
  const states = [...extracted].map((field) => field.stock).filter(Boolean);
  if (states.includes('OUT_OF_STOCK')) return 'OUT_OF_STOCK';
  if (states.includes('IN_STOCK')) return 'IN_STOCK';
  return 'UNKNOWN';
}

/** Numeric roles compare by number, so "1299.50" to "1'299.50" is a format change and not a price change. */
export function valueChanged(
  previous: { value: string | null; numeric: number | null },
  current: { value: string | null; numeric: number | null },
): boolean {
  if (previous.numeric !== null && current.numeric !== null) return previous.numeric !== current.numeric;
  return previous.value !== current.value;
}
