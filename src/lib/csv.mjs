/**
 * csv.mjs — every CSV Syncjar writes, exports and audit trails alike.
 *
 * Strings are quoted, numbers and booleans are not, and missing values are
 * empty. Pass `fields` to fix the columns and their order, which also gives
 * an empty run a header row.
 */
import { Parser } from '@json2csv/plainjs';

export function toCsv(rows, { fields } = {}) {
  return new Parser(fields ? { fields } : {}).parse(rows);
}
