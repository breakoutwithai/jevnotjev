// CSV reading and writing for jnj-record/1: comma-separated, " quotes, "" escapes a quote inside a quoted
// field, a stray quote is kept as text rather than rejected, and each record carries the physical line it
// ends on, which is the N in a validator message's "line N".
// Pure: no Node or Bun APIs, the browser imports it.

export interface CsvRecord {
  /** Physical line on which the record ends (1-based; a quoted line break makes it later than the start). */
  readonly line: number;
  readonly fields: readonly string[];
}

type State = "startRecord" | "startField" | "inField" | "inQuoted" | "quoteInQuoted" | "eatCrnl";

/** Split into physical lines: a line ends after \n, \r\n or a lone \r. */
function physicalLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\n" || (char === "\r" && text[i + 1] !== "\n")) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export class CsvError extends Error {
  override readonly name = "CsvError";
}

/** Every record in the text, blank lines included as []. */
export function readRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let state: State = "startRecord";
  let lineNumber = 0;

  const current = (): State => state;
  const saveField = (): void => {
    fields.push(field);
    field = "";
  };
  const endOfLine = (): void => {
    switch (state) {
      case "startRecord":
        return;
      case "startField":
      case "inField":
      case "quoteInQuoted":
        saveField();
        state = "startRecord";
        return;
      case "inQuoted":
        return;
      case "eatCrnl":
        state = "startRecord";
        return;
    }
  };
  const processChar = (char: string): void => {
    switch (state) {
      case "startRecord":
        if (char === "\n" || char === "\r") {
          state = "eatCrnl";
          return;
        }
        state = "startField";
        processChar(char);
        return;
      case "startField":
        if (char === "\n" || char === "\r") {
          saveField();
          state = "eatCrnl";
        } else if (char === '"') state = "inQuoted";
        else if (char === ",") saveField();
        else {
          field += char;
          state = "inField";
        }
        return;
      case "inField":
        if (char === "\n" || char === "\r") {
          saveField();
          state = "eatCrnl";
        } else if (char === ",") {
          saveField();
          state = "startField";
        } else field += char;
        return;
      case "inQuoted":
        if (char === '"') state = "quoteInQuoted";
        else field += char;
        return;
      case "quoteInQuoted":
        if (char === '"') {
          field += char;
          state = "inQuoted";
        } else if (char === ",") {
          saveField();
          state = "startField";
        } else if (char === "\n" || char === "\r") {
          saveField();
          state = "eatCrnl";
        } else {
          field += char;
          state = "inField";
        }
        return;
      case "eatCrnl":
        if (char !== "\n" && char !== "\r") {
          throw new CsvError("new-line character seen in unquoted field");
        }
        return;
    }
  };

  for (const line of physicalLines(text)) {
    lineNumber += 1;
    for (const char of line) processChar(char);
    endOfLine();
    if (current() === "startRecord") {
      records.push({ line: lineNumber, fields });
      fields = [];
    }
  }
  if (current() === "inQuoted") {
    saveField();
    records.push({ line: lineNumber, fields });
  }
  return records;
}

export interface DictRows {
  /** The first record's fields; null for an empty file. */
  readonly header: readonly string[] | null;
  /** Data records after the header, blank lines skipped, each with the line it ends on. */
  readonly rows: readonly CsvRecord[];
}

/** Header and data rows: the first record is the header, blank records are skipped. */
export function readDictRows(text: string): DictRows {
  const [first, ...rest] = readRecords(text);
  return {
    header: first === undefined ? null : first.fields,
    rows: rest.filter((record) => record.fields.length > 0),
  };
}

function quoteField(value: string): string {
  return /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One row: a field is quoted only when it holds , " \r or \n (quotes doubled); a lone empty field is written "". */
export function formatRow(fields: readonly string[], lineTerminator = "\n"): string {
  if (fields.length === 1 && fields[0] === "") return `""${lineTerminator}`;
  return fields.map(quoteField).join(",") + lineTerminator;
}

/** Rows, each written as formatRow writes it. */
export function formatRows(rows: readonly (readonly string[])[], lineTerminator = "\n"): string {
  return rows.map((row) => formatRow(row, lineTerminator)).join("");
}
