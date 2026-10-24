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

  it('rejects unknown, incompatible, non-finite and physically invalid conversions', () => {
    expect(() => convert(1, 'kg', 'm')).toThrow(/cannot convert/i);
    expect(() => convert(1, 'parse', 'm')).toThrow(/unsupported conversion unit/i);
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
