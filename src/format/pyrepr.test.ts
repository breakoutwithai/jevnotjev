// The Python behaviours the validator's messages depend on, pinned with outputs taken from CPython 3.13.

import { describe, expect, test } from "bun:test";
import { formatRow, readDictRows, readRecords } from "./csv.ts";
import { pyFixed6, pyFloatRepr, pyStrRepr } from "./pyrepr.ts";

describe("python behaviour", () => {
  test("[unit] repr(float) switches to exponent form outside 1e-4..1e16", () => {
    expect([1e16, 1e15, 1e-5, 0.0001, 1.5e300, 123456789012345678, 1.5, 0].map(pyFloatRepr)).toEqual([
      "1e+16",
      "1000000000000000.0",
      "1e-05",
      "0.0001",
      "1.5e+300",
      "1.2345678901234568e+17",
      "1.5",
      "0.0",
    ]);
    expect(pyFixed6(1.8e-6 + 1.6e-6 + 1.9e-6)).toBe("0.000005");
  });

  test("[unit] repr(str) picks quotes and escapes non-printable characters", () => {
    expect(pyStrRepr("it's")).toBe(`"it's"`);
    expect(pyStrRepr(`a"b'c`)).toBe(`'a"b\\'c'`);
    expect(pyStrRepr("﻿x​\u007f\u0085é\u{1F600} ")).toBe(
      "'\\ufeffx\\u200b\\x7f\\x85é\u{1F600}\\u2028'",
    );
    expect(pyStrRepr("run-001\n")).toBe("'run-001\\n'");
  });

  test("[unit] csv reader keeps Python's line numbers, blank-line skipping and non-strict quotes", () => {
    const { rows } = readDictRows('a,b\n1,2\n\n\n3,4\n"x\ny",5\n"unterminated,6');
    expect(rows.map((row) => [row.line, row.fields])).toEqual([
      [2, ["1", "2"]],
      [5, ["3", "4"]],
      [7, ["x\ny", "5"]],
      [8, ["unterminated,6"]],
    ]);
    expect(readRecords('a"b",c\n"ab"cd,e\n "q",r\n').map((record) => record.fields)).toEqual([
      ['a"b"', "c"],
      ["abcd", "e"],
      [' "q"', "r"],
    ]);
  });

  test("[unit] csv writer quotes like QUOTE_MINIMAL", () => {
    expect(formatRow(["a\rb", "c d", " x", 'q"q', "t\tt", "", "n\nn", "e,e", "\u0000z"])).toBe(
      '"a\rb",c d, x,"q""q",t\tt,,"n\nn","e,e",\u0000z\n',
    );
    expect(formatRow([""])).toBe('""\n');
  });
});
