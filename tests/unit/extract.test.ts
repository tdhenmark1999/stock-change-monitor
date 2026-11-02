import { describe, expect, it } from 'vitest';
import { detectStock, extractFields, MAX_VALUE_LENGTH, overallStock, parseNumber, selectorError, valueChanged, type FieldRule } from '../../apps/api/src/checks/extract';

const rule = (overrides: Partial<FieldRule> = {}): FieldRule => ({ name: 'f', selector: 'p', extractType: 'TEXT', role: 'TEXT', ...overrides });
const one = (html: string, r: FieldRule) => [...extractFields(html, [r]).values()][0];

describe('parseNumber', () => {
  it.each([
    ['CHF 49.90', 49.9],
    ["CHF 1'299.50", 1299.5],
    ['1.299,50 €', 1299.5],
    ['1,299.50', 1299.5],
    ['1.299', 1299],
    ['19.-', 19],
    ['12 Stück', 12],
    ['0', 0],
    ['Preis auf Anfrage', null],
  ])('%s -> %s', (raw, expected) => {
    expect(parseNumber(raw)).toBe(expected);
  });
});

describe('detectStock', () => {
  it.each([
    ['Auf Lager', 'IN_STOCK'],
    ['Sofort lieferbar', 'IN_STOCK'],
    ['In stock', 'IN_STOCK'],
    ['https://schema.org/InStock', 'IN_STOCK'],
    ['Disponibile', 'IN_STOCK'],
    ['Nicht verfügbar', 'OUT_OF_STOCK'],
    ['Nicht auf Lager', 'OUT_OF_STOCK'],
    ['Ausverkauft', 'OUT_OF_STOCK'],
    ['https://schema.org/OutOfStock', 'OUT_OF_STOCK'],
    ['Non disponibile', 'OUT_OF_STOCK'],
    ['Agotado', 'OUT_OF_STOCK'],
    ['Bitte anfragen', 'UNKNOWN'],
  ])('%s -> %s', (text, expected) => {
    expect(detectStock(text, rule())).toBe(expected);
  });

  it('is unknown with no value', () => {
    expect(detectStock(null, rule())).toBe('UNKNOWN');
  });

  it('prefers configured terms', () => {
    expect(detectStock('Bald wieder da', rule({ outOfStockTerms: ['bald wieder'] }))).toBe('OUT_OF_STOCK');
    expect(detectStock('Ab Werk', rule({ inStockTerms: ['ab werk'] }))).toBe('IN_STOCK');
  });
});

describe('extractFields', () => {
  it('collapses whitespace in text', () => {
    expect(one('<p>  a \n  b </p>', rule()).value).toBe('a b');
  });

  it('joins every match for a text field and takes the first for a price', () => {
    const html = '<p>1</p><p>2</p>';
    expect(one(html, rule()).value).toBe('1 | 2');
    expect(one(html, rule({ role: 'PRICE' })).value).toBe('1');
  });

  it('reads an attribute', () => {
    expect(one('<a href="/x">t</a>', rule({ selector: 'a', extractType: 'ATTRIBUTE', attribute: 'href' })).value).toBe('/x');
  });

  it('reports a missing attribute as missing', () => {
    expect(one('<a>t</a>', rule({ selector: 'a', extractType: 'ATTRIBUTE', attribute: 'href' })).status).toBe('MISSING');
  });

  it('reports a missing element', () => {
    expect(one('<div></div>', rule())).toMatchObject({ status: 'MISSING', value: null });
  });

  it('reports an invalid selector without throwing', () => {
    expect(one('<p>x</p>', rule({ selector: 'p[[' })).status).toBe('INVALID_SELECTOR');
  });

  it('ignores script and style content', () => {
    expect(one('<div><script>var a=1</script><style>a{}</style>x</div>', rule({ selector: 'div' })).value).toBe('x');
  });

  it('derives stock from quantity', () => {
    expect(one('<p>3 Stück</p>', rule({ role: 'QUANTITY' })).stock).toBe('IN_STOCK');
    expect(one('<p>0</p>', rule({ role: 'QUANTITY' })).stock).toBe('OUT_OF_STOCK');
  });
});

describe('overallStock', () => {
  const field = (stock: 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN' | null) => ({ status: 'OK' as const, value: null, numeric: null, stock });
  it('lets out of stock win', () => {
    expect(overallStock([field('IN_STOCK'), field('OUT_OF_STOCK')])).toBe('OUT_OF_STOCK');
  });
  it('is unknown with no stock information', () => {
    expect(overallStock([field(null), field('UNKNOWN')])).toBe('UNKNOWN');
  });
});

describe('valueChanged', () => {
  it('compares numbers when both sides have one', () => {
    expect(valueChanged({ value: '1299.5', numeric: 1299.5 }, { value: "1'299.50", numeric: 1299.5 })).toBe(false);
    expect(valueChanged({ value: '10', numeric: 10 }, { value: '11', numeric: 11 })).toBe(true);
  });
  it('compares text otherwise', () => {
    expect(valueChanged({ value: 'a', numeric: null }, { value: 'b', numeric: null })).toBe(true);
    expect(valueChanged({ value: 'a', numeric: null }, { value: null, numeric: null })).toBe(true);
  });
});

describe('values the database could not store', () => {
  it('does not treat a number too large for the column as numeric', () => {
    expect(parseNumber('123456789012345678901234567890')).toBeNull();
    expect(parseNumber('99999999999999')).toBe(99999999999999);
  });

  it('removes NUL characters', () => {
    expect(one('<p>a\u0000b</p>', rule()).value?.includes('\0')).toBe(false);
    expect(one('<a title="x\u0000y">t</a>', rule({ selector: 'a', extractType: 'ATTRIBUTE', attribute: 'title' })).value?.includes('\0')).toBe(false);
  });

  it('caps very long values, and still detects a change past the cut-off', () => {
    const page = (tail: string) => `<p>${'x'.repeat(MAX_VALUE_LENGTH + 500)}${tail}</p>`;
    const first = one(page('a'), rule()).value!;
    const second = one(page('b'), rule()).value!;
    expect(first.length).toBeLessThan(MAX_VALUE_LENGTH + 100);
    expect(first).not.toBe(second);
    expect(first).toBe(one(page('a'), rule()).value);
  });
});

describe('selectorError', () => {
  it('accepts valid selectors', () => {
    expect(selectorError('.price > span:first-child')).toBeNull();
  });
  it('explains invalid selectors', () => {
    expect(selectorError('div[[')).toBeTruthy();
  });
});
