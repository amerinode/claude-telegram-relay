/**
 * Presentation generation utility.
 * Converts structured markdown content into .pptx PowerPoint files.
 *
 * Content format:
 *   ## Slide: Title Slide
 *   # Main Title
 *   ## Subtitle
 *
 *   ## Slide: Key Points
 *   - Bullet one
 *   - Bullet two
 *
 *   ## Slide: Data
 *   | Header1 | Header2 |
 *   | val1    | val2    |
 */

import PptxGenJS from "pptxgenjs";

// ============================================================
// TYPES
// ============================================================

interface SlideElement {
  type: "title" | "subtitle" | "bullet" | "numbered" | "table" | "text";
  content: string;
  rows?: string[][];
  items?: string[];
}

interface SlideData {
  title: string;
  elements: SlideElement[];
}

// ============================================================
// COLORS & STYLING
// ============================================================

const COLORS = {
  primary: "2F5496",      // Dark blue
  headerBg: "D9E2F3",     // Blue-grey (matches document.ts & spreadsheet.ts)
  headerText: "1F3864",   // Darker blue for header text
  titleText: "1F3864",
  bodyText: "333333",
  subtitleText: "666666",
  tableBorder: "B4C6E7",
  altRowBg: "F2F2F2",
  white: "FFFFFF",
};

// ============================================================
// PARSING
// ============================================================

/**
 * Parse the content string into slide definitions.
 * Splits on `## Slide: SlideTitle` markers.
 */
function parsePresentationContent(content: string): SlideData[] {
  const slides: SlideData[] = [];

  // Split on ## Slide: markers
  const slideBlocks = content.split(/^## Slide:\s*/im);

  for (const block of slideBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // First line is the slide title
    const lines = trimmed.split("\n");
    const slideTitle = lines[0].trim();
    const elements: SlideElement[] = [];

    let bulletItems: string[] = [];
    let numberedItems: string[] = [];
    let tableRows: string[][] = [];
    let inTable = false;

    const flushBullets = () => {
      if (bulletItems.length > 0) {
        elements.push({ type: "bullet", content: "", items: [...bulletItems] });
        bulletItems = [];
      }
    };

    const flushNumbered = () => {
      if (numberedItems.length > 0) {
        elements.push({ type: "numbered", content: "", items: [...numberedItems] });
        numberedItems = [];
      }
    };

    const flushTable = () => {
      if (tableRows.length > 0) {
        elements.push({ type: "table", content: "", rows: [...tableRows] });
        tableRows = [];
        inTable = false;
      }
    };

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();

      // Skip empty lines (but flush accumulated items)
      if (!t) {
        if (!inTable) {
          flushBullets();
          flushNumbered();
        }
        continue;
      }

      // Pipe-delimited table row
      if (t.startsWith("|") && t.endsWith("|")) {
        // Flush other accumulators
        flushBullets();
        flushNumbered();

        const cells = t.slice(1, -1).split("|").map(c => c.trim());
        // Skip separator rows (|---|---|)
        if (cells.every(c => /^[-:]+$/.test(c))) continue;
        tableRows.push(cells);
        inTable = true;
        continue;
      }

      // If we were in a table and hit a non-table line, flush
      if (inTable) flushTable();

      // # Title (large heading on the slide)
      if (t.startsWith("# ") && !t.startsWith("## ")) {
        flushBullets();
        flushNumbered();
        elements.push({ type: "title", content: t.slice(2).trim() });
        continue;
      }

      // ## Subtitle
      if (t.startsWith("## ")) {
        flushBullets();
        flushNumbered();
        elements.push({ type: "subtitle", content: t.slice(3).trim() });
        continue;
      }

      // Bullet points
      if (/^\s*[-*]\s+/.test(t)) {
        flushNumbered();
        if (inTable) flushTable();
        bulletItems.push(t.replace(/^\s*[-*]\s+/, "").trim());
        continue;
      }

      // Numbered lists
      if (/^\s*\d+[.)]\s+/.test(t)) {
        flushBullets();
        if (inTable) flushTable();
        numberedItems.push(t.replace(/^\s*\d+[.)]\s+/, "").trim());
        continue;
      }

      // Plain text
      flushBullets();
      flushNumbered();
      elements.push({ type: "text", content: t });
    }

    // Flush remaining accumulators
    flushBullets();
    flushNumbered();
    flushTable();

    slides.push({ title: slideTitle, elements });
  }

  return slides;
}

// ============================================================
// GENERATION
// ============================================================

/**
 * Strip markdown bold/italic markers for plain text output.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}

/**
 * Generate a .pptx PowerPoint file from structured markdown content.
 * Returns a Buffer of the .pptx file.
 */
export async function generatePptx(content: string): Promise<Buffer> {
  const slides = parsePresentationContent(content);

  if (slides.length === 0) {
    throw new Error("No slide data found in content");
  }

  const pptx = new PptxGenJS();
  pptx.author = "Claude Telegram Relay";
  pptx.title = slides[0]?.title || "Presentation";
  pptx.layout = "LAYOUT_WIDE"; // 13.33" x 7.5" — modern widescreen

  for (let slideIdx = 0; slideIdx < slides.length; slideIdx++) {
    const slideData = slides[slideIdx];
    const slide = pptx.addSlide();

    // Slide title bar at the top
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: "100%",
      h: 1.0,
      fill: { color: COLORS.headerBg },
    });

    slide.addText(stripMarkdown(slideData.title), {
      x: 0.5,
      y: 0.15,
      w: 12.3,
      h: 0.7,
      fontSize: 24,
      fontFace: "Arial",
      color: COLORS.titleText,
      bold: true,
    });

    // Track Y position for element layout
    let yPos = 1.3;

    for (const element of slideData.elements) {
      switch (element.type) {
        case "title": {
          slide.addText(stripMarkdown(element.content), {
            x: 0.5,
            y: yPos,
            w: 12.3,
            h: 0.8,
            fontSize: 32,
            fontFace: "Arial",
            color: COLORS.primary,
            bold: true,
          });
          yPos += 1.0;
          break;
        }

        case "subtitle": {
          slide.addText(stripMarkdown(element.content), {
            x: 0.5,
            y: yPos,
            w: 12.3,
            h: 0.6,
            fontSize: 20,
            fontFace: "Arial",
            color: COLORS.subtitleText,
            italic: true,
          });
          yPos += 0.8;
          break;
        }

        case "bullet": {
          if (element.items && element.items.length > 0) {
            const textRows = element.items.map(item => ({
              text: stripMarkdown(item),
              options: {
                bullet: { type: "bullet" as const },
                fontSize: 18,
                fontFace: "Arial",
                color: COLORS.bodyText,
                paraSpaceBefore: 6,
                paraSpaceAfter: 6,
              },
            }));
            const blockHeight = Math.min(element.items.length * 0.45, 5.0);
            slide.addText(textRows, {
              x: 0.7,
              y: yPos,
              w: 11.9,
              h: blockHeight,
              valign: "top",
            });
            yPos += blockHeight + 0.3;
          }
          break;
        }

        case "numbered": {
          if (element.items && element.items.length > 0) {
            const textRows = element.items.map((item, idx) => ({
              text: `${idx + 1}. ${stripMarkdown(item)}`,
              options: {
                fontSize: 18,
                fontFace: "Arial",
                color: COLORS.bodyText,
                paraSpaceBefore: 6,
                paraSpaceAfter: 6,
              },
            }));
            const blockHeight = Math.min(element.items.length * 0.45, 5.0);
            slide.addText(textRows, {
              x: 0.7,
              y: yPos,
              w: 11.9,
              h: blockHeight,
              valign: "top",
            });
            yPos += blockHeight + 0.3;
          }
          break;
        }

        case "table": {
          if (element.rows && element.rows.length > 0) {
            const tableData = element.rows.map((row, rowIdx) =>
              row.map(cell => ({
                text: stripMarkdown(cell),
                options: {
                  fontSize: 14,
                  fontFace: "Arial",
                  bold: rowIdx === 0,
                  color: rowIdx === 0 ? COLORS.headerText : COLORS.bodyText,
                  fill: rowIdx === 0
                    ? { color: COLORS.headerBg }
                    : rowIdx % 2 === 0
                      ? { color: COLORS.altRowBg }
                      : { color: COLORS.white },
                  border: { type: "solid" as const, pt: 0.5, color: COLORS.tableBorder },
                  valign: "middle" as const,
                  margin: [4, 6, 4, 6] as [number, number, number, number],
                },
              }))
            );

            const tableHeight = Math.min(element.rows.length * 0.4 + 0.2, 4.5);
            slide.addTable(tableData, {
              x: 0.5,
              y: yPos,
              w: 12.3,
              h: tableHeight,
              colW: Array(element.rows[0].length).fill(12.3 / element.rows[0].length),
              autoPage: false,
            });
            yPos += tableHeight + 0.3;
          }
          break;
        }

        case "text":
        default: {
          slide.addText(stripMarkdown(element.content), {
            x: 0.5,
            y: yPos,
            w: 12.3,
            h: 0.5,
            fontSize: 18,
            fontFace: "Arial",
            color: COLORS.bodyText,
          });
          yPos += 0.6;
          break;
        }
      }
    }

    // Slide number in bottom-right
    slide.addText(`${slideIdx + 1}`, {
      x: 12.0,
      y: 6.9,
      w: 0.8,
      h: 0.4,
      fontSize: 10,
      fontFace: "Arial",
      color: COLORS.subtitleText,
      align: "right",
    });
  }

  // PptxGenJS write returns a base64 string, ArrayBuffer, or Blob depending on options
  const output = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(output as Buffer);
}
