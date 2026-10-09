import type { HostedAction, Money } from "./contract.js";
import {
  isRawNumberToken,
  providerAmountToMinor,
  rawNumberToken,
} from "./money.js";

export class ProviderShapeError extends Error {
  constructor(field: string) {
    super(`Provider response field ${field} is missing or malformed.`);
    this.name = "ProviderShapeError";
  }
}

export function asObject(value: unknown, field = "body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderShapeError(field);
  }
  return value as Record<string, unknown>;
}

export function reqString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || isRawNumberToken(value) || value === "") {
    throw new ProviderShapeError(key);
  }
  return value;
}

export function optString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || isRawNumberToken(value)) {
    throw new ProviderShapeError(key);
  }
  return value;
}

export function reqBool(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw new ProviderShapeError(key);
  }
  return value;
}

export function optBool(obj: Record<string, unknown>, key: string): boolean | null {
  const value = obj[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new ProviderShapeError(key);
  }
  return value;
}

export function reqInt(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (!isRawNumberToken(value)) {
    throw new ProviderShapeError(key);
  }
  const token = rawNumberToken(value);
  if (!/^-?\d+$/.test(token)) {
    throw new ProviderShapeError(key);
  }
  const parsed = Number.parseInt(token, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProviderShapeError(key);
  }
  return parsed;
}

export function reqRawAmount(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (!isRawNumberToken(value)) {
    throw new ProviderShapeError(key);
  }
  return rawNumberToken(value);
}

export function reqArray(obj: Record<string, unknown>, key: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new ProviderShapeError(key);
  }
  return value;
}

export function optArray(obj: Record<string, unknown>, key: string): unknown[] | null {
  const value = obj[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new ProviderShapeError(key);
  }
  return value;
}

export function optObject(obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = obj[key];
  if (value === undefined || value === null) {
    return null;
  }
  return asObject(value, key);
}

export function moneyField(value: unknown, field = "amount"): Money {
  const obj = asObject(value, field);
  const token = reqRawAmount(obj, "amount");
  const currency = reqString(obj, "currency");
  const minor = providerAmountToMinor(token, currency);
  return { currency, minor };
}

export function optMoneyField(value: unknown, field = "amount"): Money | null {
  if (value === undefined || value === null) {
    return null;
  }
  return moneyField(value, field);
}

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

export function decimalUnitsString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || isRawNumberToken(value) || !DECIMAL_STRING.test(value)) {
    throw new ProviderShapeError(key);
  }
  return value;
}

export function hostedAction(value: unknown): HostedAction | null {
  if (value === undefined || value === null) {
    return null;
  }
  const obj = asObject(value, "nextAction");
  const type = reqString(obj, "type");
  if (type !== "REDIRECT") {
    throw new ProviderShapeError("nextAction.type");
  }
  const url = reqString(obj, "url");
  const expiresAt = optString(obj, "expiresAt");
  return { type: "REDIRECT", url, expiresAt };
}
