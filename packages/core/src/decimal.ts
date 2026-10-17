import { Decimal } from 'decimal.js';
import { z } from 'zod';

// Isolated context: other packages cannot lower our arithmetic precision.
// Loss products need at most 48 significant digits, fee products 60, accounting sums 49.
export const FinancialDecimal = Decimal.clone({ precision: 80 });

export const ScalarDecimalSchema = z.string().max(26)
  .regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{0,11}[1-9])?$/)
  .refine(value => value !== '-0' && value === value.trim(), 'Use a canonical decimal string');

export const PositiveScalarSchema = ScalarDecimalSchema
  .refine(value => value !== '0' && !value.startsWith('-'), 'Must be positive');

// Accommodates an exact product of two input scalars, without cent rounding.
export const MoneySchema = z.string().max(49)
  .regex(/^(?:0|[1-9]\d{0,23})(?:\.\d{0,23}[1-9])?$/)
  .refine(value => value === value.trim(), 'Use a nonnegative canonical USD decimal');

export const IdentitySchema = z.string().min(1).max(256)
  .refine(value => value.trim() === value, 'Identity must not have surrounding whitespace');
