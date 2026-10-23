"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { analyzeCollada, type Analysis } from "@/lib/collada";
import { groupComponents, type Component, type ComponentGroup } from "@/lib/components";
import { buildPreventivo } from "@/lib/preventivo";

const Preview = dynamic(() => import("@/components/Preview"), { ssr: false });

const NOT_FURNITURE = ["Oggetto / accessorio", "Ambiente / contesto"];

type Hovered = { key: string; ids: string[] } | null;

type ColorGroup = {
  family: string;
  ids: string[];
  swatches: { hex: string; material: string; textured: boolean }[];
  thicknesses: { thickness: number; ids: string[]; rows: ComponentGroup[] }[];
};

function buildColorGroups(list: Component[]): ColorGroup[] {
  const byFamily = new Map<string, Component[]>();
  for (const c of list) byFamily.set(c.color.family, [...(byFamily.get(c.color.family) ?? []), c]);
  return [...byFamily.entries()]
    .map(([family, comps]) => {
      const byThickness = new Map<number, Component[]>();
      for (const c of comps) byThickness.set(c.thickness, [...(byThickness.get(c.thickness) ?? []), c]);
      const swatches = new Map<string, ColorGroup["swatches"][number]>();
      for (const c of comps) swatches.set(c.color.hex + c.color.material, c.color);
      return {
        family,
        ids: comps.map((c) => c.id),
        swatches: [...swatches.values()],
        thicknesses: [...byThickness.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([thickness, cs]) => ({ thickness, ids: cs.map((c) => c.id), rows: groupComponents(cs) })),
      };
    })
    .sort((a, b) => b.ids.length - a.ids.length);
}

export default function Home() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [components, setComponents] = useState<Component[]>([]);
  const [hovered, setHovered] = useState<Hovered>(null);
  const [hover3d, setHover3d] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setLoading(true);
    try {
      if (!/\.dae$/i.test(file.name)) throw new Error(`"${file.name}" non è un file .dae`);
      const xml = await file.text();
      setComponents([]);
      setHovered(null);
      setHover3d(null);
      setSelected(null);
      setExportMsg(null);
      setAnalysis(analyzeCollada(file.name, file.size, xml));
    } catch (e) {
      setAnalysis(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const onComponents = useCallback((list: Component[]) => setComponents(list), []);

  const colorGroups = useMemo(
    () => buildColorGroups(components.filter((c) => !NOT_FURNITURE.includes(c.role))),
    [components],
  );
  const excluded = useMemo(
    () => groupComponents(components.filter((c) => NOT_FURNITURE.includes(c.role))),
    [components],
  );
  const EXCLUDED = "__esclusi";
  const current =
    selected === EXCLUDED && excluded.length
      ? EXCLUDED
      : colorGroups.find((g) => g.family === selected)?.family ?? colorGroups[0]?.family ?? null;
  const excludedIds = excluded.flatMap((g) => g.ids);
  const highlight = useMemo(() => hovered?.ids ?? (hover3d ? [hover3d] : []), [hovered, hover3d]);
  const isActive = (key: string, ids: string[]) => hovered?.key === key || (hover3d !== null && ids.includes(hover3d));
  const hoverProps = (key: string, ids: string[]) => ({ onMouseEnter: () => setHovered({ key, ids }) });

  const exportExcel = async () => {
    if (!analysis) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const res = await fetch("/templates/preventivo-template.xlsx");
      if (!res.ok) throw new Error("Template Excel non trovato (public/templates/preventivo-template.xlsx)");
      const { data, sections, warnings } = await buildPreventivo(await res.arrayBuffer(), components);
      const blob = new Blob([data as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `PREVENTIVO - ${analysis.fileName.replace(/\.dae$/i, "")}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      setExportMsg({
        text:
          `Compilate ${sections.length} sezioni: ${sections.map((s) => `${s.number}. ${s.family} ${s.thickness} mm`).join(", ")}.` +
          (warnings.length ? " " + warnings.join(" ") : ""),
        error: warnings.length > 0,
      });
    } catch (e) {
      setExportMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setExporting(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  return (
    <main
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <header>
        <h1>DAE Analyzer</h1>
        <p className="muted">Trascina un file COLLADA (.dae) per vedere i suoi dati principali, i componenti e il modello 3D. Tutto avviene nel browser: il file non viene caricato da nessuna parte.</p>
      </header>

      <label className={`drop ${dragging ? "over" : ""} ${analysis ? "compact" : ""}`}>
        <input type="file" accept=".dae" hidden onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        {loading ? "Analisi in corso…" : dragging ? "Rilascia qui" : analysis ? "Trascina un altro .dae o clicca per sceglierlo" : "Trascina qui il file .dae oppure clicca per sceglierlo"}
      </label>

      {error && <div className="error">{error}</div>}

      {analysis && (
        <>
          <div className="filebar">
            <div>
              <strong>{analysis.fileName}</strong>{" "}
              <span className="muted">{formatBytes(analysis.fileSize)}</span>
            </div>
          </div>

          <div className="top">
            <div className="left">
              {colorGroups.length > 0 && (
                <section className="components" onMouseLeave={() => setHovered(null)}>
                  <div className="section-head">
                    <h2>Componenti per colore e spessore</h2>
                    <button className="primary" onClick={exportExcel} disabled={exporting}>
                      {exporting ? "Preparazione…" : "Esporta preventivo Excel"}
                    </button>
                  </div>
                  {exportMsg && <p className={`export-msg ${exportMsg.error ? "warn" : ""}`}>{exportMsg.text}</p>}
                  <div className="color-toggles" role="tablist">
                    {colorGroups.map((cg) => (
                      <button
                        key={cg.family}
                        role="tab"
                        aria-selected={current === cg.family}
                        className={`color-toggle ${current === cg.family ? "on" : ""} ${isActive("f:" + cg.family, cg.ids) ? "hot" : ""}`}
                        onClick={() => setSelected(cg.family)}
                        {...hoverProps("f:" + cg.family, cg.ids)}
                        title={cg.swatches.map((w) => `${w.material} ${w.hex}`).join(", ")}
                      >
                        <span className="swatches">
                          {cg.swatches.map((w) => (
                            <span
                              key={w.hex + w.material}
                              className={`swatch ${w.textured ? "textured" : ""}`}
                              style={{ background: w.hex }}
                            />
                          ))}
                        </span>
                        {cg.family}
                        <span className="count">{cg.ids.length}</span>
                      </button>
                    ))}
                    {excluded.length > 0 && (
                      <button
                        role="tab"
                        aria-selected={current === EXCLUDED}
                        className={`color-toggle ${current === EXCLUDED ? "on" : ""} ${isActive("f:" + EXCLUDED, excludedIds) ? "hot" : ""}`}
                        onClick={() => setSelected(EXCLUDED)}
                        {...hoverProps("f:" + EXCLUDED, excludedIds)}
                        title="Accessori e ambiente, non fanno parte del mobile"
                      >
                        Non inclusi
                        <span className="count">{excludedIds.length}</span>
                      </button>
                    )}
                  </div>

                  <div className="components-scroll">
                  {colorGroups
                    .filter((cg) => cg.family === current)
                    .map((cg) => (
                      <div key={cg.family} className="color-group">
                        <div className="color-head">
                          <strong>{cg.family}</strong>
                          <span className="muted">
                            {pezzi(cg.ids.length)} · {cg.swatches.map((w) => w.material).join(", ")}
                          </span>
                        </div>
                        {cg.thicknesses.map((t) => {
                          const key = `t:${cg.family}:${t.thickness}`;
                          return (
                            <div key={key} className="thick-group">
                              <div className={`thick-head ${isActive(key, t.ids) ? "active" : ""}`} {...hoverProps(key, t.ids)}>
                                Spessore <strong>{t.thickness} mm</strong> <span className="muted">· {pezzi(t.ids.length)}</span>
                              </div>
                              <RowsTable rows={t.rows} isActive={isActive} hoverProps={hoverProps} />
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  {current === EXCLUDED && (
                    <div className="color-group">
                      <div className="color-head">
                        <strong>Non inclusi</strong>
                        <span className="muted">accessori e ambiente, non fanno parte del mobile</span>
                      </div>
                      <RowsTable rows={excluded} isActive={isActive} hoverProps={hoverProps} dim showThickness />
                    </div>
                  )}
                  </div>
                </section>
              )}
            </div>
            <div className="right">
              <Preview xml={analysis.text} highlight={highlight} onComponents={onComponents} onHover={setHover3d} />
            </div>
          </div>

          {analysis.warnings.map((w) => (
            <p className="note" key={w}>ℹ︎ {w}</p>
          ))}
        </>
      )}
    </main>
  );
}

function RowsTable({
  rows,
  isActive,
  hoverProps,
  dim,
  showThickness,
}: {
  rows: ComponentGroup[];
  isActive: (key: string, ids: string[]) => boolean;
  hoverProps: (key: string, ids: string[]) => { onMouseEnter: () => void };
  dim?: boolean;
  showThickness?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Componente</th>
            <th>Ruolo stimato</th>
            <th className="num">Q.tà</th>
            <th>L × A × P</th>
            {showThickness && <th className="num">Sp.</th>}
            <th>Quota da terra</th>
            <th>Materiale</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key} className={`${isActive("r:" + g.key, g.ids) ? "active" : ""} ${dim ? "dim" : ""}`} {...hoverProps("r:" + g.key, g.ids)}>
              <td>{g.name}</td>
              <td>{g.role}</td>
              <td className="num">{g.ids.length}</td>
              <td>{g.size.join(" × ")}</td>
              {showThickness && <td className="num">{g.thickness}</td>}
              <td>{[...new Set(g.elevations)].sort((a, b) => a - b).join(", ")}</td>
              <td>{g.materials.join(", ") || <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const pezzi = (n: number) => `${n} ${n === 1 ? "pezzo" : "pezzi"}`;

function formatBytes(n: number) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString("it-IT", { maximumFractionDigits: 1 })} ${u[i]}`;
}
