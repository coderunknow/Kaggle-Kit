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
