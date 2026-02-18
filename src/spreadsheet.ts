/**
 * Spreadsheet generation utility.
 * Converts structured markdown-table content into .xlsx Excel files.
 *
 * Content format:
 *   ## Sheet: SheetName
 *   | Header1 | Header2 | Header3 |
 *   | value1  | value2  | =A2+B2  |
 *   ---
 *   ## Sheet: AnotherSheet
 *   | Col A | Col B |
 *   | data  | data  |
 */

import ExcelJS from "exceljs";

// ============================================================
// TYPES
// ============================================================

interface CellData {
  raw: string;
  value: string | number;
  isFormula: boolean;
}

interface SheetData {
  name: string;
  rows: CellData[][];
}

// ============================================================
// PARSING
// ============================================================

/**
 * Parse a single cell value.
 * - Cells starting with = are treated as Excel formulas.
 * - Numeric strings are stored as numbers.
 * - Everything else is a string.
 */
function parseCell(raw: string): CellData {
  const trimmed = raw.trim();

  // Formula
  if (trimmed.startsWith("=")) {
    return { raw: trimmed, value: trimmed, isFormula: true };
  }

  // Number (integers, decimals, negatives)
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { raw: trimmed, value: parseFloat(trimmed), isFormula: false };
  }

  return { raw: trimmed, value: trimmed, isFormula: false };
}

/**
 * Parse the structured content string into sheet definitions.
 *
 * Splits on `---` to separate sheets.
 * Within each block, extracts `## Sheet: Name` and pipe-delimited rows.
 */
function parseSpreadsheetContent(content: string): SheetData[] {
  // Split into sheet blocks on --- separator lines
  const blocks = content.split(/^---$/m);
  const sheets: SheetData[] = [];
  let defaultSheetIndex = 1;

  for (const block of blocks) {
    const lines = block.split("\n");
    let sheetName = `Sheet${defaultSheetIndex}`;
    const rows: CellData[][] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Sheet name marker
      if (/^##\s+Sheet:\s*(.+)$/i.test(trimmed)) {
        const match = trimmed.match(/^##\s+Sheet:\s*(.+)$/i);
        if (match) sheetName = match[1].trim();
        continue;
      }

      // Skip empty lines
      if (!trimmed) continue;

      // Pipe-delimited table row
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        // Extract cells between outer pipes
        const cells = trimmed.slice(1, -1).split("|").map(c => c.trim());

        // Skip separator rows (|---|---|)
        if (cells.every(c => /^[-:]+$/.test(c))) continue;

        rows.push(cells.map(parseCell));
      }
    }

    // Only add sheets that have data
    if (rows.length > 0) {
      sheets.push({ name: sheetName, rows });
      defaultSheetIndex++;
    }
  }

  return sheets;
}

// ============================================================
// GENERATION
// ============================================================

/**
 * Auto-size worksheet columns based on content length.
 */
function autoSizeColumns(worksheet: ExcelJS.Worksheet): void {
  const colWidths: number[] = [];

  worksheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const len = (cell.value?.toString() || "").length + 2;
      colWidths[colNumber] = Math.max(colWidths[colNumber] || 0, len);
    });
  });

  for (let i = 1; i <= colWidths.length; i++) {
    if (colWidths[i]) {
      const col = worksheet.getColumn(i);
      col.width = Math.max(10, Math.min(colWidths[i], 40));
    }
  }
}

/**
 * Generate a .xlsx Excel file from structured markdown-table content.
 * Returns a Buffer of the .xlsx file.
 */
export async function generateXlsx(content: string): Promise<Buffer> {
  const sheets = parseSpreadsheetContent(content);

  if (sheets.length === 0) {
    throw new Error("No sheet data found in content");
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Claude Telegram Relay";
  workbook.created = new Date();

  // Header style
  const headerFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD9E2F3" }, // Blue-grey, matches document.ts
  };

  const headerFont: Partial<ExcelJS.Font> = {
    bold: true,
    size: 11,
    name: "Calibri",
  };

  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);

    for (let rowIdx = 0; rowIdx < sheet.rows.length; rowIdx++) {
      const rowData = sheet.rows[rowIdx];
      const isHeader = rowIdx === 0;

      // Add row with raw values first (we'll set formulas individually)
      const excelRow = worksheet.addRow(rowData.map(cell => {
        if (cell.isFormula) return ""; // placeholder, set below
        return cell.value;
      }));

      // Apply cell-level properties
      for (let colIdx = 0; colIdx < rowData.length; colIdx++) {
        const cellData = rowData[colIdx];
        const excelCell = excelRow.getCell(colIdx + 1);

        // Set formula if applicable
        if (cellData.isFormula) {
          const formulaStr = (cellData.value as string).slice(1); // strip leading =
          excelCell.value = { formula: formulaStr } as ExcelJS.CellFormulaValue;
        }

        // Borders on all cells
        excelCell.border = thinBorder;

        // Header row styling
        if (isHeader) {
          excelCell.fill = headerFill;
          excelCell.font = headerFont;
        }

        // Alternating row fill for readability (even data rows)
        if (!isHeader && rowIdx % 2 === 0) {
          excelCell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF2F2F2" },
          };
        }
      }
    }

    autoSizeColumns(worksheet);
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
