export class MoneyError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "MoneyError";
  }
}

const RAW_SENTINEL = String.fromCodePoint(0);
const NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const DECIMAL_TOKEN = /^([+-]?\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const CANONICAL_MINOR = /^-?(0|[1-9][0-9]*)$/;

export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2,
  SGD: 2,
  HKD: 2,
  EUR: 2,
  GBP: 2,
  MXN: 2,
  JPY: 0,
  KWD: 3,
};

export function currencyExponent(currency: string): number {
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) {
    throw new MoneyError("UNSUPPORTED_CURRENCY");
  }
  return exponent;
}

export function parseJsonPreservingNumbers(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        const c = text[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      NUMBER_TOKEN.lastIndex = i;
      const match = NUMBER_TOKEN.exec(text);
      if (match !== null) {
        out += `"\\u0000${match[0]}"`;
        i += match[0].length;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out) as unknown;
}

export function isRawNumberToken(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(RAW_SENTINEL);
}

export function rawNumberToken(value: unknown): string {
  if (!isRawNumberToken(value)) {
    throw new MoneyError("EXPECTED_NUMBER");
  }
  return value.slice(RAW_SENTINEL.length);
}

export function normalizeDecimalToken(token: string): string {
  const match = DECIMAL_TOKEN.exec(token);
  if (match === null) {
    throw new MoneyError("INVALID_DECIMAL");
  }
  let digits = match[1]!;
  let sign = "";
  if (digits.startsWith("-")) {
    sign = "-";
    digits = digits.slice(1);
  } else if (digits.startsWith("+")) {
    digits = digits.slice(1);
  }
  const fraction = match[2] ?? "";
  let exponent = 0;
  if (match[3] !== undefined) {
    exponent = Number.parseInt(match[3], 10);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 999) {
      throw new MoneyError("INVALID_DECIMAL");
    }
  }
  let all = digits + fraction;
  let point = digits.length + exponent;
  if (point <= 0) {
    all = "0".repeat(-point) + all;
    point = 0;
  } else if (point > all.length) {
    all += "0".repeat(point - all.length);
  }
  let whole = point === 0 ? "0" : all.slice(0, point);
  let frac = all.slice(point);
  whole = whole.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  let result = sign + whole + (frac === "" ? "" : `.${frac}`);
  if (result === "" || result === "-" || /^-?0(\.0+)?$/.test(result)) {
    result = "0";
  }
  return result;
}

export function decimalToInteger(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^-?\d+(\.\d+)?$/.test(value)) throw new Error('INVALID_DECIMAL');
  const negative = value.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  if (/[1-9]/.test(fraction.slice(decimals))) throw new Error('UNSUPPORTED_PRECISION');
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0') || '0');
  return negative ? -result : result;
}

export function integerToDecimal(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('INVALID_DECIMALS');
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, '0');
  return sign + (decimals === 0 ? digits : digits.slice(0, -decimals) + '.' + digits.slice(-decimals));
}

export function isCanonicalMinor(minor: string): boolean {
  return CANONICAL_MINOR.test(minor);
}

export function providerAmountToMinor(amountToken: string, currency: string): string {
  const exponent = currencyExponent(currency);
  const normalized = normalizeDecimalToken(amountToken);
  const minor = decimalToInteger(normalized, exponent);
  const text = minor.toString();
  if (!isCanonicalMinor(text)) {
    throw new MoneyError("INVALID_MINOR");
  }
  return text;
}

export function minorToUnits(minor: string, currency: string): string {
  const exponent = currencyExponent(currency);
  return integerToDecimal(BigInt(minor), exponent);
}

export function decimalUnitsToInteger(units: string, decimals: number): bigint {
  const normalized = normalizeDecimalToken(units);
  return decimalToInteger(normalized, decimals);
}

export function isExactRateOne(token: string): boolean {
  try {
    return decimalToInteger(normalizeDecimalToken(token), 18) === 10n ** 18n;
  } catch {
    return false;
  }
}
