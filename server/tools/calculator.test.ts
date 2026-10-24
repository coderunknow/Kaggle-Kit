import { describe, expect, it } from 'vitest';

import { calculate, CalculatorInputError, convert } from './calculator';

function expectRelativeClose(actual: number, expected: number, tolerance = 1e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1, Math.abs(expected)) * tolerance);
}

describe('deterministic calculator tools', () => {
  it('evaluates arithmetic with parentheses and documented functions', () => {
    expect(calculate('sqrt(81) + 2^3 * 2').value).toBe(25);
    expect(calculate('round(pi, 3)').value).toBe(3.142);
  });

  it('rejects code-like syntax, unsupported names and oversized expressions', () => {
    expect(() => calculate('process.exit()')).toThrow(CalculatorInputError);
    expect(() => calculate('1; globalThis.secret')).toThrow(CalculatorInputError);
    expect(() => calculate('x'.repeat(513))).toThrow(CalculatorInputError);
  });

  it('rejects division by zero and non-finite results', () => {
    expect(() => calculate('1 / 0')).toThrow(/division by zero/i);
    expect(() => calculate('1e300 ^ 2')).toThrow(CalculatorInputError);
  });

  it('converts the previously reported Fahrenheit and speed examples within a relative tolerance', () => {
    // Relative tolerance: 1e-6 × max(1, |expected|), allowing floating-point rounding.
    expectRelativeClose(convert(100, '°F', '°C').value, 37.7777778);
    expectRelativeClose(convert(100, 'km/h', 'mph').value, 62.1371192);
  });

  it('converts every supported unit and alias against independent canonical factors', () => {
    const units: Array<{ canonical: string; entries: Array<[string, number]> }> = [
      { canonical: 'm', entries: [
        ['m', 1], ['meter', 1], ['meters', 1], ['km', 1000], ['kilometer', 1000],
        ['kilometers', 1000], ['cm', 0.01], ['mm', 0.001], ['mi', 1609.344],
        ['mile', 1609.344], ['ft', 0.3048], ['feet', 0.3048], ['in', 0.0254], ['inch', 0.0254],
      ] },
      { canonical: 'kg', entries: [
        ['kg', 1], ['g', 0.001], ['mg', 0.000001], ['lb', 0.45359237],
        ['lbs', 0.45359237], ['oz', 0.028349523125],
      ] },
      { canonical: 's', entries: [
        ['s', 1], ['sec', 1], ['second', 1], ['seconds', 1], ['min', 60],
        ['minute', 60], ['minutes', 60], ['h', 3600], ['hr', 3600], ['hour', 3600],
        ['hours', 3600], ['day', 86400], ['days', 86400],
      ] },
      { canonical: 'l', entries: [
        ['l', 1], ['liter', 1], ['liters', 1], ['ml', 0.001],
        ['gallon_us', 3.785411784], ['gal', 3.785411784],
      ] },
      { canonical: 'm/s', entries: [
        ['m/s', 1], ['km/h', 1 / 3.6], ['mph', 0.44704], ['ft/s', 0.3048],
      ] },
    ];
    for (const { canonical, entries } of units) {
      for (const [unit, factor] of entries) {
        expect(convert(1, unit, canonical).value).toBeCloseTo(factor, 12);
        expect(convert(factor, canonical, unit).value).toBeCloseTo(1, 12);
      }
    }
  });

  it('converts every supported dimension in both directions', () => {
    expect(convert(1, 'km', 'm').value).toBe(1000);
    expect(convert(1000, 'm', 'km').value).toBe(1);
    expectRelativeClose(convert(1, 'lb', 'kg').value, 0.45359237);
    expectRelativeClose(convert(1, 'kg', 'lb').value, 2.20462262185);
    expect(convert(1, 'hour', 'min').value).toBe(60);
    expect(convert(60, 'min', 'hour').value).toBe(1);
    expectRelativeClose(convert(1, 'gal', 'l').value, 3.785411784);
    expectRelativeClose(convert(1, 'l', 'gal').value, 1 / 3.785411784);
    expect(convert(1, 'm/s', 'km/h').value).toBeCloseTo(3.6, 12);
    expect(convert(3.6, 'km/h', 'm/s').value).toBeCloseTo(1, 12);
    expect(convert(32, 'fahrenheit', 'celsius').value).toBeCloseTo(0);
    expectRelativeClose(convert(0, 'celsius', 'fahrenheit').value, 32);
    expectRelativeClose(convert(100, 'fahrenheit', 'celsius').value, 37.7777778);
    expectRelativeClose(convert(37.7777778, 'celsius', 'fahrenheit').value, 100);
  });

  it('normalizes case and whitespace and handles signed, decimal and zero values', () => {
    expectRelativeClose(convert(-40.5, ' C ', ' F ').value, -40.9);
    expectRelativeClose(convert(-40, 'Celsius', 'Fahrenheit').value, -40);
    expect(convert(0, 'KM/H', 'mph').value).toBe(0);
    expect(convert(1.25, '  KM / H ', ' MPH ').value).toBeCloseTo(0.776714, 5);
  });

  it('checks conversions against independent standard values and handles numeric boundaries', () => {
    // Independent identities: °F to °C is (F - 32) × 5/9; km/h to mph uses
    // the standard exact-mile conversion factor 0.621371192237334.
    expect(convert(100, 'fahrenheit', 'celsius').value).toBeCloseTo((100 - 32) * 5 / 9, 12);
    expect(convert(100, 'km/h', 'mph').value).toBeCloseTo(100 * 0.621371192237334, 12);
    expect(convert(-40, '°F', '°C').value).toBeCloseTo(-40, 12);
    expect(convert(32, 'f', 'c').value).toBeCloseTo(0, 12);
    expect(convert(0, 'c', 'k').value).toBeCloseTo(273.15, 12);
    expect(convert(273.15, 'k', 'c').value).toBeCloseTo(0, 12);
    expect(convert(0, '°C', '°F').value).toBeCloseTo(32, 12);
    const normalized = convert(0, ' °C ', ' °F ');
    expect(normalized.value).toBeCloseTo(32, 12);
    expect(normalized).toMatchObject({ from: ' °C ', to: ' °F ' });
    expect(convert(1e100, 'km', 'm').value / 1e103).toBeCloseTo(1, 12);
    expect(convert(-1e100, 'km', 'm').value / -1e103).toBeCloseTo(1, 12);
    expect(convert(Number.MIN_VALUE, 'm', 'm').value).toBe(Number.MIN_VALUE);
    expect(() => convert(1, '', 'm')).toThrow(CalculatorInputError);
    expect(() => convert(1, 'm', '')).toThrow(CalculatorInputError);
    expect(() => convert(1, null as unknown as string, 'm')).toThrow(CalculatorInputError);
    expect(() => convert(1, 'm', null as unknown as string)).toThrow(CalculatorInputError);
    expect(() => convert('100' as unknown as number, 'm', 'km')).toThrow(CalculatorInputError);
    expect(() => calculate(null as unknown as string)).toThrow(CalculatorInputError);
    expect(() => calculate('')).toThrow(CalculatorInputError);
    expect(() => calculate('1e309')).toThrow(/non-finite/i);
    expect(calculate('1e-320').value).toBe(1e-320);
  });

  it('rejects unknown, incompatible, non-finite and physically invalid conversions', () => {
    expect(() => convert(1, 'kg', 'm')).toThrow(/cannot convert/i);
    expect(() => convert(1, 'parse', 'm')).toThrow(/unsupported conversion unit/i);
    expect(() => convert(NaN, 'km', 'm')).toThrow(/finite/i);
    expect(() => convert(Infinity, 'km', 'm')).toThrow(/finite/i);
    expect(() => convert(Number.MAX_VALUE, 'km', 'm')).toThrow(/finite|range/i);
    expect(() => convert(-1, 'kelvin', 'celsius')).toThrow(/absolute zero/i);
    expect(() => convert(-300, 'celsius', 'fahrenheit')).toThrow(/absolute zero/i);
    expect(() => convert(-500, 'fahrenheit', 'celsius')).toThrow(/absolute zero/i);
    expect(convert(-459.67, 'fahrenheit', 'kelvin').value).toBe(0);
    expect(convert(-273.15, 'celsius', 'kelvin').value).toBe(0);
    expect(convert(0, 'kelvin', 'fahrenheit').value).toBe(-459.67);
    expect(() => convert(-459.670001, 'fahrenheit', 'kelvin')).toThrow(/absolute zero/i);
  });
});
