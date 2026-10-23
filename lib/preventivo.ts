// Compila il foglio "materiali" del template PREVENTIVI: una sezione "DIMENSIONI PEZZI mm"
// per ogni combinazione colore + spessore, a partire dalla sezione 9. Le sezioni 1–8 non
// vengono toccate; se servono più di 10 sezioni, le nuove sono copie della sezione 10.
// Modifica direttamente l'XML, così formattazione, formule e gli altri fogli restano intatti.

import JSZip from "jszip";
import type { Component, Role } from "./components";

const SHEET_NAME = "materiali";
const TOTALS_SHEET = "totali";
const TOTALS_CELL = "C5"; // somma dei "TOTALE MATERIALE" di tutte le sezioni
const FIRST_BLOCK_ROW = 4; // riga del titolo della sezione 1
const BLOCK_HEIGHT = 28;
const FIRST_TARGET_BLOCK = 8; // sezione 9 (indice da 0)
const TEMPLATE_BLOCKS = 10; // sezioni presenti nel template
const MAX_PIECES = 20; // righe h / l / qtà per sezione
const TOTAL_OFFSET = 15; // riga di "TOTALE MATERIALE" (colonna P) rispetto al titolo

// Pezzi che non vanno in preventivo come pannelli da tagliare.
const EXCLUDED_ROLES: Role[] = [
  "Ferramenta / piccolo oggetto",
  "Blocco / elemento spesso",
  "Superficie senza spessore",
  "Oggetto / accessorio",
  "Ambiente / contesto",
];

export type PreventivoPiece = { h: number; l: number; qty: number };
export type PreventivoSection = {
  number: number;
  title: string;
  family: string;
  thickness: number;
  description: string;
  pieces: PreventivoPiece[];
};

const blockTop = (index: number) => FIRST_BLOCK_ROW + index * BLOCK_HEIGHT;

export function preventivoSections(components: Component[]): PreventivoSection[] {
  const panels = components.filter((c) => !EXCLUDED_ROLES.includes(c.role) && c.thickness >= 1);

  const familyCount = new Map<string, number>();
  for (const c of panels) familyCount.set(c.color.family, (familyCount.get(c.color.family) ?? 0) + 1);
  const families = [...familyCount.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);

  const sections: PreventivoSection[] = [];
  for (const family of families) {
    const ofFamily = panels.filter((c) => c.color.family === family);
    const thicknesses = [...new Set(ofFamily.map((c) => c.thickness))].sort((a, b) => b - a);
    for (const thickness of thicknesses) {
      const comps = ofFamily.filter((c) => c.thickness === thickness);
      // h = lato lungo, l = lato corto (lo spessore è la misura minore e viene escluso).
      const counts = new Map<string, PreventivoPiece>();
      for (const c of comps) {
        const [h, l] = [...c.size].sort((a, b) => b - a);
        const key = `${h}x${l}`;
        const p = counts.get(key);
        if (p) p.qty++;
        else counts.set(key, { h, l, qty: 1 });
      }
      const number = FIRST_TARGET_BLOCK + sections.length + 1;
      sections.push({
        number,
        title: `${number}   ${family} ${thickness} mm`,
        family,
        thickness,
        description: [...new Set(comps.map((c) => c.role))].join(", "),
        pieces: [...counts.values()].sort((a, b) => b.h - a.h || b.l - a.l),
      });
    }
  }
  return sections;
}

export async function buildPreventivo(template: ArrayBuffer, components: Component[]) {
  const zip = await JSZip.loadAsync(template);
  const warnings: string[] = [];
  const sections = preventivoSections(components);

  const sheetPath = await sheetXmlPath(zip, SHEET_NAME);
  let xml = await zip.file(sheetPath)!.async("string");

  // Sezioni oltre la 10: copie della sezione 10, aggiunte anche al totale materiali.
  const lastBlock = FIRST_TARGET_BLOCK + sections.length - 1;
  const newTotals: string[] = [];
  for (let b = TEMPLATE_BLOCKS; b <= lastBlock; b++) {
    xml = cloneBlock(xml, blockTop(TEMPLATE_BLOCKS - 1), blockTop(b));
    newTotals.push(`${SHEET_NAME}!P${blockTop(b) + TOTAL_OFFSET}`);
  }

  sections.forEach((s, k) => {
    const top = blockTop(FIRST_TARGET_BLOCK + k);
    xml = setCell(xml, `B${top}`, s.title);
    xml = setCell(xml, `C${top + 3}`, s.description); // Descrizione
    xml = setCell(xml, `C${top + 9}`, s.thickness); // Spessore
    if (s.pieces.length > MAX_PIECES)
      warnings.push(`${s.family} ${s.thickness} mm: ${s.pieces.length} misure diverse, nella sezione ne entrano ${MAX_PIECES}.`);
    s.pieces.slice(0, MAX_PIECES).forEach((p, i) => {
      const row = top + 3 + i;
      xml = setCell(xml, `F${row}`, p.h);
      xml = setCell(xml, `G${row}`, p.l);
      xml = setCell(xml, `H${row}`, p.qty);
    });
  });
  zip.file(sheetPath, xml);

  if (newTotals.length) {
    const totalsPath = await sheetXmlPath(zip, TOTALS_SHEET);
    const totals = await zip.file(totalsPath)!.async("string");
    const re = new RegExp(`(<c r="${TOTALS_CELL}"[^>]*>\\s*<f>)([^<]*)(</f>)`);
    if (!re.test(totals)) warnings.push(`Non ho trovato la formula ${TOTALS_SHEET}!${TOTALS_CELL}: aggiungi a mano le nuove sezioni al totale.`);
    else zip.file(totalsPath, totals.replace(re, (_m, a: string, f: string, c: string) => `${a}${f}+${newTotals.join("+")}${c}`));
  }

  // Fa ricalcolare tutte le formule all'apertura (i valori in cache non sono più validi).
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  zip.file(
    "xl/workbook.xml",
    /<calcPr\b/.test(wbXml)
      ? wbXml.replace(/<calcPr\b([^>]*?)\s*(\/?)>/, (_m, attrs: string, slash: string) =>
          `<calcPr${attrs.replace(/\s+fullCalcOnLoad="[^"]*"/, "")} fullCalcOnLoad="1"${slash}>`)
      : wbXml.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>'),
  );

  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { data, sections, warnings };
}

async function sheetXmlPath(zip: JSZip, name: string) {
  const wb = await zip.file("xl/workbook.xml")!.async("string");
  const sheet = wb.match(new RegExp(`<sheet\\b[^>]*name="${escapeRegExp(escapeXml(name))}"[^>]*>`))?.[0];
  const rid = sheet?.match(/r:id="([^"]+)"/)?.[1];
  if (!rid) throw new Error(`Foglio "${name}" non trovato nel template`);
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const rel = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`))?.[0];
  const target = rel?.match(/Target="([^"]+)"/)?.[1];
  if (!target) throw new Error(`Relazione ${rid} non trovata`);
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
}

const rowRe = (r: number) => new RegExp(`<row\\b[^>]*\\sr="${r}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`);

/** Copia le righe di una sezione (valori, stili, formule, celle unite) a partire da un'altra riga. */
function cloneBlock(xml: string, srcTop: number, dstTop: number) {
  const shift = dstTop - srcTop;
  const inBlock = (r: number) => r >= srcTop && r < srcTop + BLOCK_HEIGHT;
  const shiftRefs = (f: string) =>
    f.replace(/(\$?[A-Z]{1,3}\$?)(\d+)(?![\d(])/g, (m, col: string, row: string) =>
      inBlock(+row) && !col.endsWith("$") ? `${col}${+row + shift}` : m,
    );
  // Ogni copia ha i suoi indici di formula condivisa.
  let nextSi = Math.max(-1, ...[...xml.matchAll(/\ssi="(\d+)"/g)].map((m) => +m[1])) + 1;
  const siMap = new Map<string, number>();
  const newSi = (si: string) => {
    if (!siMap.has(si)) siMap.set(si, nextSi++);
    return siMap.get(si)!;
  };

  for (let i = 0; i < BLOCK_HEIGHT; i++) {
    const src = xml.match(rowRe(srcTop + i))?.[0];
    if (!src) continue;
    const dstRow = dstTop + i;
    const copy = src
      .replace(/^<row\b([^>]*?)\sr="\d+"/, `<row$1 r="${dstRow}"`)
      .replace(/<c r="([A-Z]{1,3})\d+"/g, `<c r="$1${dstRow}"`)
      .replace(/<f\b([^>]*)>([^<]*)<\/f>/g, (_m, attrs: string, f: string) => `<f${fixFormulaAttrs(attrs)}>${shiftRefs(f)}</f>`)
      .replace(/<f\b([^>]*?)\/>/g, (_m, attrs: string) => `<f${fixFormulaAttrs(attrs)}/>`);
    xml = insertRow(xml, dstRow, copy);
  }

  function fixFormulaAttrs(attrs: string) {
    return attrs
      .replace(/\ssi="(\d+)"/, (_m, si: string) => ` si="${newSi(si)}"`)
      .replace(/\sref="([^"]+)"/, (_m, ref: string) => ` ref="${shiftRefs(ref)}"`);
  }

  // Celle unite della sezione.
  const merges = [...xml.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g)]
    .filter((m) => inBlock(+m[2]))
    .map((m) => `<mergeCell ref="${m[1]}${+m[2] + shift}:${m[3]}${+m[4] + shift}"/>`);
  if (merges.length)
    xml = xml.replace(/<mergeCells count="(\d+)">([\s\S]*?)<\/mergeCells>/, (_m, count: string, body: string) =>
      `<mergeCells count="${+count + merges.length}">${body}${merges.join("")}</mergeCells>`,
    );

  const lastRow = dstTop + BLOCK_HEIGHT - 1;
  return xml.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\/>/, (m, a: string, col: string, row: string) =>
    +row < lastRow ? `<dimension ref="${a}:${col}${lastRow}"/>` : m,
  );
}

/** Sostituisce la riga se esiste già (anche vuota), altrimenti la inserisce in ordine. */
function insertRow(xml: string, r: number, rowXml: string) {
  if (rowRe(r).test(xml)) return xml.replace(rowRe(r), rowXml);
  const after = [...xml.matchAll(/<row\b[^>]*\sr="(\d+)"/g)].find((m) => +m[1] > r);
  if (after?.index !== undefined) return xml.slice(0, after.index) + rowXml + xml.slice(after.index);
  return xml.replace("</sheetData>", `${rowXml}</sheetData>`);
}

/** Scrive un valore in una cella esistente mantenendone lo stile. */
function setCell(xml: string, ref: string, value: string | number) {
  const re = new RegExp(`<c r="${ref}"((?:\\s+[\\w:]+="[^"]*")*)\\s*(?:/>|>[\\s\\S]*?</c>)`);
  const m = xml.match(re);
  if (!m) throw new Error(`Cella ${ref} non trovata nel template`);
  const style = m[1].match(/\ss="[^"]*"/)?.[0] ?? "";
  const cell =
    typeof value === "number"
      ? `<c r="${ref}"${style}><v>${value}</v></c>`
      : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  return xml.replace(re, cell);
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
