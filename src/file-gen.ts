/**
 * File Generation Module
 *
 * Converts content into binary file formats (Excel, PowerPoint, PDF).
 * Claude creates content as structured text with action tags,
 * and this module generates the actual files.
 *
 * Action tags processed by the relay:
 *   [CREATE_EXCEL: filename | sheet_name | CSV-like content]
 *   [CREATE_DOCX: filename | content]
 *   [CREATE_PDF: filename | content]
 *   [CREATE_PPTX: filename | slide1 title | slide1 body ||| slide2 title | slide2 body]
 */

import { join, extname, basename } from "path";
import { writeFile, access } from "fs/promises";
import { generateDocx } from "./document.ts";

const PROJECT_ROOT = join(import.meta.path, "..", "..");
const FILES_DIR = process.env.ONA_FOLDER || join(PROJECT_ROOT, "files");

/**
 * Get a safe file path, appending (1), (2), etc. if the file exists or is locked.
 */
async function safePath(dir: string, filename: string): Promise<string> {
  const ext = extname(filename);
  const base = basename(filename, ext);
  let candidate = join(dir, filename);

  for (let i = 1; i <= 99; i++) {
    try {
      await access(candidate);
      // File exists — try next suffix
      candidate = join(dir, `${base} (${i})${ext}`);
    } catch {
      // File doesn't exist — safe to use
      return candidate;
    }
  }
  // Fallback: timestamp
  return join(dir, `${base} (${Date.now()})${ext}`);
}

// ============================================================
// EXCEL (.xlsx)
// ============================================================

export async function createExcel(
  filename: string,
  sheetName: string,
  content: string
): Promise<string> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  workbook.creator = "Ona";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(sheetName || "Sheet1");

  // Normalize escape sequences: Claude may output literal \t and \n text
  const normalized = content
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");

  // Split into rows (actual newlines)
  const lines = normalized.trim().split("\n").filter((l) => l.trim());

  // Styling
  const headerFill: any = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E79" },
  };
  const headerFont: any = { bold: true, size: 11, name: "Calibri", color: { argb: "FFFFFFFF" } };
  const altRowFill: any = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF2F7FB" },
  };
  const thinBorder: any = {
    top: { style: "thin", color: { argb: "FFD0D0D0" } },
    left: { style: "thin", color: { argb: "FFD0D0D0" } },
    bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
    right: { style: "thin", color: { argb: "FFD0D0D0" } },
  };

  for (let i = 0; i < lines.length; i++) {
    // Split cells on tab or pipe, trim each
    const cells = lines[i].split(/\t|\|/).map((c) => c.trim()).filter((c) => c !== "");
    const isHeader = i === 0;

    // Parse cell values: numbers, formulas, or strings
    const values = cells.map((raw) => {
      if (raw.startsWith("=")) return raw; // formula placeholder
      if (/^-?\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);
      // Currency-like: $1,234.56 or R$1.234,56
      const currencyMatch = raw.match(/^[R$€£¥]*\$?\s*([\d.,]+)$/);
      if (currencyMatch) {
        const num = parseFloat(currencyMatch[1].replace(/\./g, "").replace(",", "."));
        if (!isNaN(num)) return num;
      }
      // Percentage: 45.2%
      if (/^-?\d+(\.\d+)?%$/.test(raw)) return parseFloat(raw) / 100;
      return raw;
    });

    const row = sheet.addRow(values);

    // Apply cell-level formatting
    for (let c = 1; c <= cells.length; c++) {
      const cell = row.getCell(c);
      const rawVal = cells[c - 1];

      // Set formula
      if (typeof rawVal === "string" && rawVal.startsWith("=")) {
        cell.value = { formula: rawVal.slice(1) } as any;
      }

      // Percentage format
      if (typeof rawVal === "string" && /^-?\d+(\.\d+)?%$/.test(rawVal)) {
        cell.numFmt = "0.0%";
      }

      // Currency format
      if (typeof rawVal === "string" && /^[R$€£¥]*\$/.test(rawVal)) {
        cell.numFmt = "#,##0.00";
      }

      cell.border = thinBorder;

      if (isHeader) {
        cell.fill = headerFill;
        cell.font = headerFont;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      } else {
        // Alternating row colors (data rows)
        if (i % 2 === 0) {
          cell.fill = altRowFill;
        }
        // Right-align numbers
        if (typeof cell.value === "number") {
          cell.alignment = { horizontal: "right" };
        }
      }
    }
  }

  // Auto-fit column widths
  sheet.columns.forEach((col) => {
    let maxLen = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = cell.value?.toString().length || 0;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 3, 50);
  });

  // Freeze header row
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  // Auto-filter on header row
  if (lines.length > 1) {
    const colCount = lines[0].split(/\t|\|/).filter((c) => c.trim()).length;
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: colCount },
    };
  }

  const safeName = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  const filePath = await safePath(FILES_DIR, safeName);
  await workbook.xlsx.writeFile(filePath);
  console.log(`Created Excel: ${filePath}`);
  return filePath;
}

// ============================================================
// WORD (.docx)
// ============================================================

export async function createDocx(
  filename: string,
  content: string
): Promise<string> {
  // Normalize escape sequences
  const normalized = content.replace(/\\n/g, "\n");

  // Extract title from first heading if present
  const titleMatch = normalized.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : undefined;
  const body = titleMatch ? normalized.replace(titleMatch[0], "").trim() : normalized;

  const buffer = await generateDocx(body, title);

  const safeName = filename.endsWith(".docx") ? filename : `${filename}.docx`;
  const filePath = await safePath(FILES_DIR, safeName);
  await writeFile(filePath, buffer);
  console.log(`Created Word: ${filePath}`);
  return filePath;
}

// ============================================================
// PDF (.pdf)
// ============================================================

export async function createPdf(
  filename: string,
  content: string
): Promise<string> {
  const PDFDocument = (await import("pdfkit")).default;

  const safeName = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
  const filePath = await safePath(FILES_DIR, safeName);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", async () => {
      try {
        await writeFile(filePath, Buffer.concat(chunks));
        console.log(`Created PDF: ${filePath}`);
        resolve(filePath);
      } catch (err) {
        reject(err);
      }
    });
    doc.on("error", reject);

    // Parse content — support basic markdown-like formatting
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.startsWith("# ")) {
        doc.fontSize(20).font("Helvetica-Bold").text(line.slice(2), { paragraphGap: 8 });
      } else if (line.startsWith("## ")) {
        doc.fontSize(16).font("Helvetica-Bold").text(line.slice(3), { paragraphGap: 6 });
      } else if (line.startsWith("### ")) {
        doc.fontSize(13).font("Helvetica-Bold").text(line.slice(4), { paragraphGap: 4 });
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        doc.fontSize(11).font("Helvetica").text(`  \u2022 ${line.slice(2)}`, { paragraphGap: 2 });
      } else if (/^\d+\.\s/.test(line)) {
        doc.fontSize(11).font("Helvetica").text(`  ${line}`, { paragraphGap: 2 });
      } else if (line.trim() === "") {
        doc.moveDown(0.5);
      } else {
        doc.fontSize(11).font("Helvetica").text(line, { paragraphGap: 2 });
      }
    }

    doc.end();
  });
}

// ============================================================
// POWERPOINT (.pptx)
// ============================================================

export async function createPptx(
  filename: string,
  slidesContent: string
): Promise<string> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();

  // Parse slides separated by |||
  const slidesRaw = slidesContent.split("|||").map((s) => s.trim()).filter(Boolean);

  for (const slideRaw of slidesRaw) {
    const parts = slideRaw.split("|").map((p) => p.trim());
    const title = parts[0] || "Slide";
    const body = parts.slice(1).join("\n") || "";

    const slide = pptx.addSlide();
    slide.addText(title, {
      x: 0.5,
      y: 0.5,
      w: 9,
      h: 1,
      fontSize: 28,
      bold: true,
      color: "003366",
    });
    if (body) {
      slide.addText(body, {
        x: 0.5,
        y: 1.8,
        w: 9,
        h: 4.5,
        fontSize: 16,
        color: "333333",
        valign: "top",
      });
    }
  }

  const safeName = filename.endsWith(".pptx") ? filename : `${filename}.pptx`;
  const filePath = await safePath(FILES_DIR, safeName);

  // pptxgenjs write returns base64 or buffer
  const output = await pptx.write({ outputType: "nodebuffer" }) as Buffer;
  await writeFile(filePath, output);
  console.log(`Created PowerPoint: ${filePath}`);
  return filePath;
}

// ============================================================
// HTML (.html)
// ============================================================

export async function createHtml(
  filename: string,
  content: string
): Promise<string> {
  const normalized = content.replace(/\\n/g, "\n");
  const safeName = filename.endsWith(".html") ? filename : `${filename}.html`;
  const filePath = await safePath(FILES_DIR, safeName);
  await writeFile(filePath, normalized, "utf-8");
  console.log(`Created HTML: ${filePath}`);
  return filePath;
}

// ============================================================
// ACTION TAG PROCESSOR
// ============================================================

/**
 * Process file creation action tags in Claude's response.
 * Returns the cleaned response (tags removed) and list of created file paths.
 */
export async function processFileActions(
  response: string
): Promise<{ clean: string; files: string[] }> {
  let clean = response;
  const files: string[] = [];

  // [CREATE_EXCEL: filename | sheet_name | row1col1 \t row1col2 \n row2col1 \t row2col2]
  for (const match of response.matchAll(
    /\[CREATE_EXCEL:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi
  )) {
    try {
      const path = await createExcel(match[1].trim(), match[2].trim(), match[3].trim());
      files.push(path);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      console.error("Create Excel error:", error.message);
      clean = clean.replace(match[0], `(Failed to create Excel: ${error.message})`);
    }
  }

  // [CREATE_HTML: filename]content[/CREATE_HTML]
  for (const match of response.matchAll(
    /\[CREATE_HTML:\s*(.+?)\]\s*([\s\S]+?)\s*\[\/CREATE_HTML\]/gi
  )) {
    try {
      const path = await createHtml(match[1].trim(), match[2].trim());
      files.push(path);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      console.error("Create HTML error:", error.message);
      clean = clean.replace(match[0], `(Failed to create HTML: ${error.message})`);
    }
  }

  // [CREATE_DOCX: filename]content[/CREATE_DOCX]
  for (const match of response.matchAll(
    /\[CREATE_DOCX:\s*(.+?)\]\s*([\s\S]+?)\s*\[\/CREATE_DOCX\]/gi
  )) {
    try {
      const path = await createDocx(match[1].trim(), match[2].trim());
      files.push(path);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      console.error("Create Word error:", error.message);
      clean = clean.replace(match[0], `(Failed to create Word doc: ${error.message})`);
    }
  }

  // [CREATE_PDF: filename]content[/CREATE_PDF]
  for (const match of response.matchAll(
    /\[CREATE_PDF:\s*(.+?)\]\s*([\s\S]+?)\s*\[\/CREATE_PDF\]/gi
  )) {
    try {
      const path = await createPdf(match[1].trim(), match[2].trim());
      files.push(path);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      console.error("Create PDF error:", error.message);
      clean = clean.replace(match[0], `(Failed to create PDF: ${error.message})`);
    }
  }

  // [CREATE_PPTX: filename | slide1title | slide1body ||| slide2title | slide2body]
  for (const match of response.matchAll(
    /\[CREATE_PPTX:\s*(.+?)\s*\|\s*([\s\S]+?)\]/gi
  )) {
    try {
      const path = await createPptx(match[1].trim(), match[2].trim());
      files.push(path);
      clean = clean.replace(match[0], "");
    } catch (error: any) {
      console.error("Create PowerPoint error:", error.message);
      clean = clean.replace(match[0], `(Failed to create PowerPoint: ${error.message})`);
    }
  }

  return { clean: clean.trim(), files };
}
