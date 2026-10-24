import { describe, expect, it } from 'vitest';

import { calculate, CalculatorInputError, convert } from './calculator';

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

  // Regression leads from an earlier audit report (100 °F and 100 km/h were
  // reported as wildly wrong). Re-verified on 2026-10-24: the current
  // implementation is correct; these assertions lock the behaviour in with
  // an explicit tolerance instead of relying on the report.
  it('converts 100 °F to °C and 100 km/h to mph within 1e-6 relative tolerance', () => {
    const fahrenheit = convert(100, '°F', '°C');
    expect(Math.abs(fahrenheit.value - 37.7777778) / 37.7777778).toBeLessThan(1e-6);
    const speed = convert(100, 'km/h', 'mph');
    expect(Math.abs(speed.value - 62.1371192) / 62.1371192).toBeLessThan(1e-6);
  });

  it('converts in both directions, with signs, zero, case and whitespace tolerance', () => {
    expect(convert(100, 'mph', 'km/h').value).toBeCloseTo(160.9344, 6);
    expect(convert(-40, 'celsius', 'fahrenheit').value).toBeCloseTo(-40, 9);
    expect(convert(0, 'celsius', 'fahrenheit').value).toBeCloseTo(32, 9);
    expect(convert(0, 'km', 'mi').value).toBe(0);
    expect(convert(-5, 'km', 'm').value).toBe(-5000);
    expect(convert(100, ' KM/H ', ' MPH ').value).toBeCloseTo(62.1371192, 6);
    expect(convert(1, 'mi', 'km').value).toBeCloseTo(1.609344, 9);
    expect(convert(36, 'km/h', 'm/s').value).toBeCloseTo(10, 9);
  });

  it('rejects unknown units, cross-category conversions and non-finite values', () => {
    expect(() => convert(1, 'furlong', 'm')).toThrow(CalculatorInputError);
    expect(() => convert(1, 'km/h', 'm')).toThrow(/cannot convert/i);
    expect(() => convert(Number.NaN, 'm', 'km')).toThrow(CalculatorInputError);
    expect(() => convert(Number.POSITIVE_INFINITY, 'm', 'km')).toThrow(CalculatorInputError);
    expect(() => convert(1e101, 'm', 'km')).toThrow(CalculatorInputError);
  });

  it('converts compatible units and rejects incompatible or physically invalid values', () => {
    expect(convert(1, 'km', 'm').value).toBe(1000);
    expect(convert(32, 'fahrenheit', 'celsius').value).toBeCloseTo(0);
    expect(() => convert(1, 'kg', 'm')).toThrow(/cannot convert/i);
    expect(() => convert(-1, 'kelvin', 'celsius')).toThrow(/absolute zero/i);
    expect(() => convert(-300, 'celsius', 'fahrenheit')).toThrow(/absolute zero/i);
    expect(() => convert(-500, 'fahrenheit', 'celsius')).toThrow(/absolute zero/i);
    expect(convert(-459.67, 'fahrenheit', 'kelvin').value).toBe(0);
    expect(convert(-273.15, 'celsius', 'kelvin').value).toBe(0);
    expect(convert(0, 'kelvin', 'fahrenheit').value).toBe(-459.67);
    expect(() => convert(-459.670001, 'fahrenheit', 'kelvin')).toThrow(/absolute zero/i);
  });
});
