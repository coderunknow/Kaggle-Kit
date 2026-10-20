export class CalculatorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculatorInputError';
  }
}

type Token = { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'operator'; value: string };

const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i;
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*/;
const FUNCTIONS: Record<string, (args: number[]) => number> = {
  abs: (args) => unary(args, Math.abs),
  ceil: (args) => unary(args, Math.ceil),
  floor: (args) => unary(args, Math.floor),
  round: (args) => {
    if (args.length < 1 || args.length > 2) throw new CalculatorInputError('round expects one or two arguments.');
    const places = args[1] ?? 0;
    if (!Number.isInteger(places) || places < -12 || places > 12) {
      throw new CalculatorInputError('round places must be an integer from -12 to 12.');
    }
    const factor = 10 ** places;
    return Math.round(args[0]! * factor) / factor;
  },
  sqrt: (args) => {
    const value = unary(args, Math.sqrt);
    if (value < 0) throw new CalculatorInputError('sqrt requires a non-negative value.');
    return value;
  },
  sin: (args) => unary(args, Math.sin),
  cos: (args) => unary(args, Math.cos),
  tan: (args) => unary(args, Math.tan),
  ln: (args) => {
    const value = unary(args, Math.log);
    if (args[0]! <= 0) throw new CalculatorInputError('ln requires a positive value.');
    return value;
  },
  log: (args) => {
    if (args.length === 1) {
      if (args[0]! <= 0) throw new CalculatorInputError('log requires a positive value.');
      return Math.log10(args[0]!);
    }
    if (args.length === 2 && args[0]! > 0 && args[1]! > 0 && args[1] !== 1) {
      return Math.log(args[0]!) / Math.log(args[1]!);
    }
    throw new CalculatorInputError('log expects a positive value and optional base greater than zero and not equal to one.');
  },
  exp: (args) => unary(args, Math.exp),
  min: (args) => {
    if (args.length < 1 || args.length > 16) throw new CalculatorInputError('min expects 1 to 16 arguments.');
    return Math.min(...args);
  },
  max: (args) => {
    if (args.length < 1 || args.length > 16) throw new CalculatorInputError('max expects 1 to 16 arguments.');
    return Math.max(...args);
  },
};

function unary(args: number[], operation: (value: number) => number): number {
  if (args.length !== 1) throw new CalculatorInputError('This function expects exactly one argument.');
  return operation(args[0]!);
}

function tokenize(expression: string): Token[] {
  if (expression.length === 0 || expression.length > 512) {
    throw new CalculatorInputError('Expression must contain between 1 and 512 characters.');
  }
  const tokens: Token[] = [];
  let remaining = expression.trim();
  while (remaining) {
    const leading = /^\s+/.exec(remaining);
    if (leading) {
      remaining = remaining.slice(leading[0].length);
      continue;
    }
    const number = NUMBER.exec(remaining);
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new CalculatorInputError('The expression contains a non-finite number.');
      tokens.push({ kind: 'number', value });
      remaining = remaining.slice(number[0].length);
    } else {
      const name = IDENTIFIER.exec(remaining);
      if (name) {
        tokens.push({ kind: 'name', value: name[0].toLowerCase() });
        remaining = remaining.slice(name[0].length);
      } else if ('+-*/%^(),'.includes(remaining[0]!)) {
        tokens.push({ kind: 'operator', value: remaining[0]! });
        remaining = remaining.slice(1);
      } else {
        throw new CalculatorInputError(`Unsupported character "${remaining[0]}" in expression.`);
      }
    }
    if (tokens.length > 256) throw new CalculatorInputError('Expression contains too many tokens.');
  }
  return tokens;
}

class Parser {
  private position = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expression(0);
    if (this.position !== this.tokens.length) throw new CalculatorInputError('Unexpected token after the expression.');
    return checked(value);
  }

  private expression(minBindingPower: number): number {
    this.depth += 1;
    if (this.depth > 32) throw new CalculatorInputError('Expression nesting is too deep.');
    let left = this.prefix();

    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'operator') break;
      const binding = infixBindingPower(token.value);
      if (!binding || binding[0] < minBindingPower) break;
      this.position += 1;
      const right = this.expression(binding[1]);
      switch (token.value) {
        case '+': left += right; break;
        case '-': left -= right; break;
        case '*': left *= right; break;
        case '/':
          if (right === 0) throw new CalculatorInputError('Division by zero is not defined.');
          left /= right;
          break;
        case '%':
          if (right === 0) throw new CalculatorInputError('Remainder by zero is not defined.');
          left %= right;
          break;
        case '^':
          if (Math.abs(right) > 10_000 || Math.abs(left) > 1e100) {
            throw new CalculatorInputError('Exponent is outside the supported range.');
          }
          left = left ** right;
          break;
        default: throw new CalculatorInputError('Unsupported operator.');
      }
      checked(left);
    }

    this.depth -= 1;
    return left;
  }

  private prefix(): number {
    const token = this.tokens[this.position++];
    if (!token) throw new CalculatorInputError('The expression is incomplete.');
    if (token.kind === 'number') return token.value;
    if (token.kind === 'operator' && (token.value === '+' || token.value === '-')) {
      const value = this.expression(25);
      return token.value === '-' ? -value : value;
    }
    if (token.kind === 'operator' && token.value === '(') {
      const value = this.expression(0);
      if (this.take(')') === false) throw new CalculatorInputError('Missing closing parenthesis.');
      return value;
    }
    if (token.kind === 'name') {
      if (token.value === 'pi') return Math.PI;
      if (token.value === 'e') return Math.E;
      const operation = FUNCTIONS[token.value];
      if (!operation) throw new CalculatorInputError(`Unknown constant or function "${token.value}".`);
      if (!this.take('(')) throw new CalculatorInputError(`Function "${token.value}" must be followed by parentheses.`);
      const args: number[] = [];
      if (!this.isNext(')')) {
        do {
          args.push(this.expression(0));
          if (args.length > 16) throw new CalculatorInputError('A function may take at most 16 arguments.');
        } while (this.take(','));
      }
      if (!this.take(')')) throw new CalculatorInputError(`Function "${token.value}" is missing a closing parenthesis.`);
      return checked(operation(args));
    }
    throw new CalculatorInputError('Expected a number, constant, function, or parenthesized expression.');
  }

  private peek(): Token | undefined { return this.tokens[this.position]; }
  private isNext(value: string): boolean {
    const token = this.peek();
    return token?.kind === 'operator' && token.value === value;
  }
  private take(value: string): boolean {
    if (!this.isNext(value)) return false;
    this.position += 1;
    return true;
  }
}

function infixBindingPower(operator: string): [number, number] | undefined {
  switch (operator) {
    case '+': case '-': return [10, 11];
    case '*': case '/': case '%': return [20, 21];
    case '^': return [30, 30];
    default: return undefined;
  }
}

function checked(value: number): number {
  if (!Number.isFinite(value)) throw new CalculatorInputError('The result is not finite or is outside the supported numeric range.');
  return value;
}

export function calculate(expression: string): { value: number; display: string; precision: string } {
  const value = new Parser(tokenize(expression)).parse();
  return {
    value,
    display: Number(value.toPrecision(12)).toString(),
    precision: 'IEEE-754 floating-point result; trigonometric and logarithmic functions use radians.',
  };
}

const UNITS: Record<string, { category: string; factor: number }> = {
  m: { category: 'length', factor: 1 }, meter: { category: 'length', factor: 1 }, meters: { category: 'length', factor: 1 },
  km: { category: 'length', factor: 1000 }, kilometer: { category: 'length', factor: 1000 }, kilometers: { category: 'length', factor: 1000 },
  cm: { category: 'length', factor: 0.01 }, mm: { category: 'length', factor: 0.001 }, mi: { category: 'length', factor: 1609.344 }, mile: { category: 'length', factor: 1609.344 },
  ft: { category: 'length', factor: 0.3048 }, feet: { category: 'length', factor: 0.3048 }, in: { category: 'length', factor: 0.0254 }, inch: { category: 'length', factor: 0.0254 },
  kg: { category: 'mass', factor: 1 }, g: { category: 'mass', factor: 0.001 }, mg: { category: 'mass', factor: 0.000001 }, lb: { category: 'mass', factor: 0.45359237 }, lbs: { category: 'mass', factor: 0.45359237 }, oz: { category: 'mass', factor: 0.028349523125 },
  s: { category: 'time', factor: 1 }, sec: { category: 'time', factor: 1 }, second: { category: 'time', factor: 1 }, seconds: { category: 'time', factor: 1 }, min: { category: 'time', factor: 60 }, minute: { category: 'time', factor: 60 }, minutes: { category: 'time', factor: 60 }, h: { category: 'time', factor: 3600 }, hr: { category: 'time', factor: 3600 }, hour: { category: 'time', factor: 3600 }, hours: { category: 'time', factor: 3600 }, day: { category: 'time', factor: 86400 }, days: { category: 'time', factor: 86400 },
  l: { category: 'volume', factor: 1 }, liter: { category: 'volume', factor: 1 }, liters: { category: 'volume', factor: 1 }, ml: { category: 'volume', factor: 0.001 }, gallon_us: { category: 'volume', factor: 3.785411784 }, gal: { category: 'volume', factor: 3.785411784 },
  'm/s': { category: 'speed', factor: 1 }, 'km/h': { category: 'speed', factor: 1 / 3.6 }, mph: { category: 'speed', factor: 0.44704 }, 'ft/s': { category: 'speed', factor: 0.3048 },
};

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/°/g, '').replace(/\s+/g, '');
}

export function convert(value: number, from: string, to: string): { value: number; display: string; from: string; to: string; precision: string } {
  if (!Number.isFinite(value) || Math.abs(value) > 1e100) throw new CalculatorInputError('Conversion value must be finite and within ±1e100.');
  const source = normalizeUnit(from);
  const target = normalizeUnit(to);
  if (['c', 'celsius', 'f', 'fahrenheit', 'k', 'kelvin'].includes(source) && ['c', 'celsius', 'f', 'fahrenheit', 'k', 'kelvin'].includes(target)) {
    const isFahrenheit = source === 'f' || source === 'fahrenheit';
    const isKelvin = source === 'k' || source === 'kelvin';
    if (value < (isFahrenheit ? -459.67 : isKelvin ? 0 : -273.15)) {
      throw new CalculatorInputError('Temperature is below absolute zero.');
    }
    // Convert through Kelvin using offsets that preserve the exact physical
    // lower bounds (for example, -459.67°F must become exactly 0 K).
    const kelvin = isFahrenheit ? (value + 459.67) * (5 / 9) : isKelvin ? value : value + 273.15;
    const converted = target === 'f' || target === 'fahrenheit'
      ? kelvin * (9 / 5) - 459.67
      : target === 'k' || target === 'kelvin'
        ? kelvin
        : kelvin - 273.15;
    return conversionResult(converted, from, to);
  }
  const fromUnit = UNITS[source];
  const toUnit = UNITS[target];
  if (!fromUnit || !toUnit) throw new CalculatorInputError(`Unsupported conversion unit. Supported sets: length, mass, time, volume, speed, and temperature.`);
  if (fromUnit.category !== toUnit.category) throw new CalculatorInputError(`Cannot convert ${fromUnit.category} to ${toUnit.category}.`);
  return conversionResult(value * fromUnit.factor / toUnit.factor, from, to);
}

function conversionResult(value: number, from: string, to: string) {
  checked(value);
  return {
    value,
    display: Number(value.toPrecision(12)).toString(),
    from,
    to,
    precision: 'Converted using IEEE-754 floating-point arithmetic; not an exact rational result.',
  };
}
