// Parser COLLADA (.dae): estrae metadati, geometrie, materiali, scena e animazioni.

export type Row = Record<string, string | number>;

export type Section = {
  id: string;
  title: string;
  description?: string;
  kind: "kv" | "table" | "tree";
  rows?: Row[];
  columns?: string[];
  text?: string;
};

export type Analysis = {
  fileName: string;
  fileSize: number;
  summary: { label: string; value: string }[];
  sections: Section[];
  warnings: string[];
  text: string;
};

const all = (root: Element | Document, name: string) =>
  Array.from(root.getElementsByTagNameNS("*", name));
const first = (root: Element | Document, name: string) =>
  root.getElementsByTagNameNS("*", name)[0] as Element | undefined;
const kids = (el: Element | undefined, name?: string) =>
  el ? Array.from(el.children).filter((c) => !name || c.localName === name) : [];
const kid = (el: Element | undefined, name: string) => kids(el, name)[0];
const text = (el: Element | undefined) => el?.textContent?.trim() ?? "";
const ref = (url: string | null | undefined) => (url ?? "").replace(/^#/, "");
const nums = (s: string) => (s.trim() ? s.trim().split(/\s+/).map(Number) : []);
const label = (el: Element) => el.getAttribute("name") || el.getAttribute("id") || "(senza nome)";
const fmt = (n: number, d = 3) =>
  Number.isFinite(n) ? n.toLocaleString("it-IT", { maximumFractionDigits: d }) : "-";

const PRIMITIVES = ["triangles", "polylist", "polygons", "lines", "linestrips", "trifans", "tristrips"];

export function analyzeCollada(fileName: string, fileSize: number, xml: string): Analysis {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("XML non valido: " + (err.textContent ?? "").slice(0, 300));
  const root = doc.documentElement;
  if (root.localName !== "COLLADA")
    throw new Error(`Il file non è COLLADA (elemento radice: <${root.localName}>)`);

  const warnings: string[] = [];
  const sections: Section[] = [];
  const byId = new Map<string, Element>();
  for (const el of all(doc, "*")) {
    const id = el.getAttribute("id");
    if (id) byId.set(id, el);
  }

  // ---------- Asset / metadati ----------
  const asset = kid(root, "asset");
  const assetRows: Row[] = [];
  const push = (k: string, v: string | undefined | null) => v && assetRows.push({ Campo: k, Valore: v });
  push("Versione COLLADA", root.getAttribute("version"));
  push("Namespace", root.namespaceURI);
  for (const c of kids(asset, "contributor")) {
    push("Autore", text(kid(c, "author")));
    push("Email autore", text(kid(c, "author_email")));
    push("Sito autore", text(kid(c, "author_website")));
    push("Software di creazione", text(kid(c, "authoring_tool")));
    push("Commenti", text(kid(c, "comments")));
    push("Copyright", text(kid(c, "copyright")));
    push("File sorgente", text(kid(c, "source_data")));
  }
  push("Titolo", text(kid(asset, "title")));
  push("Oggetto", text(kid(asset, "subject")));
  push("Parole chiave", text(kid(asset, "keywords")));
  push("Revisione", text(kid(asset, "revision")));
  push("Creato il", formatDate(text(kid(asset, "created"))));
  push("Modificato il", formatDate(text(kid(asset, "modified"))));
  const unit = kid(asset, "unit");
  const unitMeter = Number(unit?.getAttribute("meter") ?? 1) || 1;
  const unitName = unit?.getAttribute("name") ?? "meter";
  push("Unità di misura", `${unitName} (1 unità = ${unitMeter} m)`);
  const upAxis = text(kid(asset, "up_axis")) || "Y_UP";
  push("Asse verticale", upAxis);
  const geoloc = first(asset ?? root, "geographic_location");
  if (geoloc) {
    push("Longitudine", text(kid(geoloc, "longitude")));
    push("Latitudine", text(kid(geoloc, "latitude")));
    push("Altitudine", text(kid(geoloc, "altitude")));
  }
  sections.push({ id: "asset", title: "Metadati", kind: "kv", rows: assetRows });

  // ---------- Geometrie ----------
  const bbMin = [Infinity, Infinity, Infinity];
  const bbMax = [-Infinity, -Infinity, -Infinity];
  let totVerts = 0;
  let totTris = 0;
  let totLines = 0;
  const geoRows: Row[] = [];
  const primRows: Row[] = [];
  for (const g of all(doc, "geometry")) {
    const mesh = kid(g, "mesh") ?? kid(g, "convex_mesh");
    if (!mesh) {
      const other = kids(g).find((c) => c.localName !== "asset" && c.localName !== "extra");
      geoRows.push({ Nome: label(g), ID: g.getAttribute("id") ?? "", Tipo: other?.localName ?? "?" });
      continue;
    }
    const sourceCount = (id: string) => {
      const s = byId.get(id);
      const acc = s && first(s, "accessor");
      return Number(acc?.getAttribute("count") ?? 0);
    };
    const vertices = kid(mesh, "vertices");
    const posInput = kids(vertices, "input").find((i) => i.getAttribute("semantic") === "POSITION");
    const posId = ref(posInput?.getAttribute("source"));
    const vertCount = sourceCount(posId);
    totVerts += vertCount;

    // bounding box (non trasformato)
    const posSrc = byId.get(posId);
    const fa = posSrc && kid(posSrc, "float_array");
    const stride = Number((posSrc && first(posSrc, "accessor"))?.getAttribute("stride") ?? 3) || 3;
    if (fa) {
      const v = nums(fa.textContent ?? "");
      for (let i = 0; i + 2 < v.length; i += stride)
        for (let a = 0; a < 3; a++) {
          if (v[i + a] < bbMin[a]) bbMin[a] = v[i + a];
          if (v[i + a] > bbMax[a]) bbMax[a] = v[i + a];
        }
    }

    const semantics = new Set<string>();
    let tris = 0;
    let lines = 0;
    let faces = 0;
    for (const p of kids(mesh).filter((c) => PRIMITIVES.includes(c.localName))) {
      const inputs = kids(p, "input");
      inputs.forEach((i) => semantics.add(i.getAttribute("semantic") + (i.getAttribute("set") ? i.getAttribute("set")! : "")));
      const offsetStride = Math.max(0, ...inputs.map((i) => Number(i.getAttribute("offset") ?? 0))) + 1;
      const count = Number(p.getAttribute("count") ?? 0);
      let t = 0;
      let l = 0;
      switch (p.localName) {
        case "triangles":
          t = count;
          break;
        case "polylist":
          for (const n of nums(text(kid(p, "vcount")))) t += Math.max(0, n - 2);
          break;
        case "polygons":
          for (const pe of kids(p, "p")) t += Math.max(0, nums(pe.textContent ?? "").length / offsetStride - 2);
          break;
        case "trifans":
        case "tristrips":
          for (const pe of kids(p, "p")) t += Math.max(0, nums(pe.textContent ?? "").length / offsetStride - 2);
          break;
        case "lines":
          l = count;
          break;
        case "linestrips":
          for (const pe of kids(p, "p")) l += Math.max(0, nums(pe.textContent ?? "").length / offsetStride - 1);
          break;
      }
      tris += t;
      lines += l;
      faces += count;
      primRows.push({
        Geometria: label(g),
        Tipo: p.localName,
        Elementi: count,
        Triangoli: t,
        Materiale: p.getAttribute("material") ?? "",
        Input: inputs.map((i) => i.getAttribute("semantic")).join(", "),
      });
    }
    totTris += tris;
    totLines += lines;
    geoRows.push({
      Nome: label(g),
      ID: g.getAttribute("id") ?? "",
      Tipo: mesh.localName,
      Vertici: vertCount,
      Facce: faces,
      Triangoli: tris,
      Linee: lines,
      Normali: [...semantics].some((s) => s.startsWith("NORMAL")) ? "sì" : "no",
      "UV (set)": [...semantics].filter((s) => s.startsWith("TEXCOORD")).length,
      "Colori vertice": [...semantics].some((s) => s.startsWith("COLOR")) ? "sì" : "no",
    });
  }
  sections.push({ id: "geometries", title: `Geometrie (${geoRows.length})`, kind: "table", rows: geoRows });
  if (primRows.length)
    sections.push({
      id: "primitives",
      title: `Primitive / gruppi di facce (${primRows.length})`,
      kind: "table",
      rows: primRows,
    });

  // ---------- Immagini / texture ----------
  const imgRows: Row[] = [];
  for (const img of all(doc, "image")) {
    if (img.parentElement?.localName === "library_images" || img.parentElement?.localName === "profile_COMMON" || img.getAttribute("id")) {
      const init = kid(img, "init_from");
      const path = init ? text(kid(init, "ref")) || text(init) : "";
      imgRows.push({
        Nome: label(img),
        ID: img.getAttribute("id") ?? "",
        File: decodeURIComponentSafe(path),
        Formato: path.split(".").pop()?.toUpperCase() ?? "",
        Dimensioni:
          img.getAttribute("width") && img.getAttribute("height")
            ? `${img.getAttribute("width")}×${img.getAttribute("height")}`
            : "",
      });
    }
  }
  if (imgRows.length) {
    sections.push({ id: "images", title: `Texture / immagini (${imgRows.length})`, kind: "table", rows: imgRows });
    warnings.push(
      "Le texture sono file esterni referenziati: l'anteprima 3D le mostrerà solo se incorporate.",
    );
  }

  // ---------- Effetti e materiali ----------
  const resolveTexture = (effect: Element, sampler: string) => {
    // 1.4: sampler2D -> surface -> init_from ; 1.5: sampler2D -> instance_image
    const np = all(effect, "newparam").find((n) => n.getAttribute("sid") === sampler);
    if (!np) return sampler;
    const s2d = first(np, "sampler2D");
    const inst = s2d && first(s2d, "instance_image");
    if (inst) return imageFile(ref(inst.getAttribute("url")));
    const surfSid = text(s2d && kid(s2d, "source"));
    const surf = all(effect, "newparam").find((n) => n.getAttribute("sid") === surfSid);
    const imgId = text(surf && first(surf, "init_from"));
    return imageFile(imgId || sampler);
  };
  const imageFile = (id: string) => {
    const img = byId.get(id);
    if (!img) return id;
    const init = kid(img, "init_from");
    return decodeURIComponentSafe((init ? text(kid(init, "ref")) || text(init) : "") || id);
  };
  const effectInfo = new Map<string, Row>();
  for (const eff of all(doc, "effect")) {
    const tech = first(eff, "technique");
    const shader = kids(tech).find((c) => ["phong", "lambert", "blinn", "constant"].includes(c.localName));
    const info: Row = { Shader: shader?.localName ?? "?" };
    for (const ch of ["diffuse", "ambient", "specular", "emission", "reflective", "transparent"]) {
      const el = shader && kid(shader, ch);
      if (!el) continue;
      const col = kid(el, "color");
      const tex = kid(el, "texture");
      if (tex) info[cap(ch)] = "texture: " + resolveTexture(eff, tex.getAttribute("texture") ?? "");
      else if (col) info[cap(ch)] = colorStr(nums(text(col)));
    }
    const shin = shader && first(shader, "shininess");
    if (shin) info.Shininess = text(first(shin, "float"));
    const tr = shader && kid(shader, "transparency");
    if (tr) info["Trasparenza"] = text(first(tr, "float"));
    if (first(eff, "bump")) info.Bump = "sì";
    if (kid(eff, "profile_COMMON") == null) info.Profilo = kids(eff).map((c) => c.localName).join(", ");
    effectInfo.set(eff.getAttribute("id") ?? "", info);
  }
  const matRows: Row[] = [];
  for (const m of all(doc, "material")) {
    if (!m.getAttribute("id")) continue;
    const effId = ref(kid(m, "instance_effect")?.getAttribute("url"));
    matRows.push({ Materiale: label(m), ID: m.getAttribute("id") ?? "", Effetto: effId, ...(effectInfo.get(effId) ?? {}) });
  }
  if (matRows.length)
    sections.push({ id: "materials", title: `Materiali (${matRows.length})`, kind: "table", rows: matRows });

  // ---------- Luci ----------
  const lightRows: Row[] = [];
  for (const l of all(doc, "light")) {
    const tc = kid(l, "technique_common");
    const t = kids(tc)[0];
    if (!t) continue;
    lightRows.push({
      Nome: label(l),
      Tipo: t.localName,
      Colore: colorStr(nums(text(kid(t, "color")))),
      "Att. costante": text(kid(t, "constant_attenuation")),
      "Att. lineare": text(kid(t, "linear_attenuation")),
      "Att. quadratica": text(kid(t, "quadratic_attenuation")),
      "Angolo cono": text(kid(t, "falloff_angle")),
    });
  }
  if (lightRows.length)
    sections.push({ id: "lights", title: `Luci (${lightRows.length})`, kind: "table", rows: lightRows });

  // ---------- Camere ----------
  const camRows: Row[] = [];
  for (const c of all(doc, "camera")) {
    const tc = first(c, "technique_common");
    const t = kids(tc)[0];
    if (!t) continue;
    camRows.push({
      Nome: label(c),
      Proiezione: t.localName === "perspective" ? "prospettica" : t.localName === "orthographic" ? "ortografica" : t.localName,
      "FOV X": text(kid(t, "xfov")),
      "FOV Y": text(kid(t, "yfov")),
      "Mag X": text(kid(t, "xmag")),
      "Mag Y": text(kid(t, "ymag")),
      Aspect: text(kid(t, "aspect_ratio")),
      "Z near": text(kid(t, "znear")),
      "Z far": text(kid(t, "zfar")),
    });
  }
  if (camRows.length)
    sections.push({ id: "cameras", title: `Camere (${camRows.length})`, kind: "table", rows: camRows });

  // ---------- Controller (skin / morph) ----------
  const ctrlRows: Row[] = [];
  const jointNames = new Set<string>();
  for (const c of all(doc, "controller")) {
    const skin = kid(c, "skin");
    const morph = kid(c, "morph");
    if (skin) {
      const jointsInput = kids(kid(skin, "joints"), "input").find((i) => i.getAttribute("semantic") === "JOINT");
      const src = byId.get(ref(jointsInput?.getAttribute("source")));
      const names = text(src && (first(src, "Name_array") ?? first(src, "IDREF_array"))).split(/\s+/).filter(Boolean);
      names.forEach((n) => jointNames.add(n));
      const vw = kid(skin, "vertex_weights");
      const vcount = nums(text(kid(vw, "vcount")));
      ctrlRows.push({
        Nome: label(c),
        Tipo: "skin",
        Sorgente: ref(skin.getAttribute("source")),
        Joint: names.length,
        "Vertici pesati": Number(vw?.getAttribute("count") ?? 0),
        "Max influenze/vertice": vcount.length ? Math.max(...vcount) : "",
      });
    } else if (morph) {
      const targets = kids(kid(morph, "targets"), "input").find((i) => i.getAttribute("semantic") === "MORPH_TARGET");
      const src = byId.get(ref(targets?.getAttribute("source")));
      ctrlRows.push({
        Nome: label(c),
        Tipo: "morph (" + (morph.getAttribute("method") ?? "NORMALIZED") + ")",
        Sorgente: ref(morph.getAttribute("source")),
        "Target morph": Number(first(src ?? c, "IDREF_array")?.getAttribute("count") ?? 0),
      });
    }
  }
  if (ctrlRows.length)
    sections.push({ id: "controllers", title: `Skin e morph (${ctrlRows.length})`, kind: "table", rows: ctrlRows });

  // ---------- Animazioni ----------
  const animRows: Row[] = [];
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const ch of all(doc, "channel")) {
    const sampler = byId.get(ref(ch.getAttribute("source")));
    const inp = kids(sampler, "input");
    const timeSrc = byId.get(ref(inp.find((i) => i.getAttribute("semantic") === "INPUT")?.getAttribute("source")));
    const times = nums(text(timeSrc && kid(timeSrc, "float_array")));
    const interpSrc = byId.get(ref(inp.find((i) => i.getAttribute("semantic") === "INTERPOLATION")?.getAttribute("source")));
    const interp = [...new Set(text(interpSrc && first(interpSrc, "Name_array")).split(/\s+/).filter(Boolean))];
    if (times.length) {
      tMin = Math.min(tMin, times[0]);
      tMax = Math.max(tMax, times[times.length - 1]);
    }
    const anim = ch.closest("animation") ?? ch.parentElement!;
    animRows.push({
      Animazione: label(anim),
      Target: ch.getAttribute("target") ?? "",
      Keyframe: times.length,
      Inizio: times.length ? fmt(times[0]) + " s" : "",
      Fine: times.length ? fmt(times[times.length - 1]) + " s" : "",
      Interpolazione: interp.join(", "),
    });
  }
  if (animRows.length)
    sections.push({ id: "animations", title: `Canali di animazione (${animRows.length})`, kind: "table", rows: animRows });
  const clipRows: Row[] = all(doc, "animation_clip").map((c) => ({
    Clip: label(c),
    Inizio: c.getAttribute("start") ?? "0",
    Fine: c.getAttribute("end") ?? "",
    Animazioni: kids(c, "instance_animation").length,
  }));
  if (clipRows.length)
    sections.push({ id: "clips", title: `Clip di animazione (${clipRows.length})`, kind: "table", rows: clipRows });

  // ---------- Scena / gerarchia nodi ----------
  let nodeCount = 0;
  let jointCount = 0;
  const instanceCounts: Record<string, number> = {};
  const lines: string[] = [];
  const walk = (n: Element, depth: number) => {
    nodeCount++;
    const isJoint = n.getAttribute("type") === "JOINT";
    if (isJoint) jointCount++;
    const inst = kids(n).filter((c) => c.localName.startsWith("instance_"));
    const instDesc = inst.map((i) => {
      instanceCounts[i.localName] = (instanceCounts[i.localName] ?? 0) + 1;
      const target = ref(i.getAttribute("url"));
      const t = byId.get(target);
      return `${i.localName.replace("instance_", "")}: ${t ? label(t) : target}`;
    });
    const transforms = kids(n)
      .filter((c) => ["matrix", "translate", "rotate", "scale", "lookat", "skew"].includes(c.localName))
      .map((c) => c.localName);
    lines.push(
      `${"  ".repeat(depth)}${isJoint ? "🦴" : "▸"} ${label(n)}` +
        (instDesc.length ? `  [${instDesc.join("; ")}]` : "") +
        (transforms.length ? `  {${transforms.join(", ")}}` : ""),
    );
    kids(n, "node").forEach((c) => walk(c, depth + 1));
  };
  const activeScene = ref(first(kid(root, "scene") ?? root, "instance_visual_scene")?.getAttribute("url"));
  for (const vs of all(doc, "visual_scene")) {
    lines.push(`■ ${label(vs)}${vs.getAttribute("id") === activeScene ? "  (scena attiva)" : ""}`);
    kids(vs, "node").forEach((n) => walk(n, 1));
  }
  if (lines.length)
    sections.push({
      id: "scene",
      title: `Gerarchia della scena (${nodeCount} nodi)`,
      description: "▸ nodo, 🦴 joint; tra [ ] le istanze collegate, tra { } le trasformazioni.",
      kind: "tree",
      text: lines.join("\n"),
    });

  // ---------- Librerie ed estensioni ----------
  const libRows: Row[] = kids(root)
    .filter((c) => c.localName.startsWith("library_"))
    .map((c) => ({ Libreria: c.localName.replace("library_", ""), Elementi: c.children.length }));
  const profiles = [...new Set(all(doc, "technique").map((t) => t.getAttribute("profile")).filter(Boolean))] as string[];
  if (libRows.length)
    sections.push({ id: "libraries", title: "Librerie presenti", kind: "table", rows: libRows });
  if (profiles.length)
    sections.push({
      id: "extras",
      title: "Estensioni specifiche (profili <technique>)",
      kind: "kv",
      rows: profiles.map((p) => ({ Campo: "Profilo", Valore: p })),
    });

  // ---------- Riepilogo ----------
  const hasBB = Number.isFinite(bbMin[0]);
  const summary = [
    { label: "Versione COLLADA", value: root.getAttribute("version") ?? "?" },
    { label: "Software", value: text(first(asset ?? root, "authoring_tool")) || "—" },
    { label: "Unità", value: `${unitName} (${unitMeter} m)` },
    { label: "Asse verticale", value: upAxis },
    { label: "Geometrie", value: fmt(geoRows.length, 0) },
    { label: "Vertici", value: fmt(totVerts, 0) },
    { label: "Triangoli", value: fmt(totTris, 0) },
    ...(totLines ? [{ label: "Linee", value: fmt(totLines, 0) }] : []),
    { label: "Materiali", value: fmt(matRows.length, 0) },
    { label: "Texture", value: fmt(imgRows.length, 0) },
    { label: "Nodi scena", value: fmt(nodeCount, 0) },
    ...(jointCount || jointNames.size ? [{ label: "Joint / ossa", value: fmt(Math.max(jointCount, jointNames.size), 0) }] : []),
    ...(lightRows.length ? [{ label: "Luci", value: fmt(lightRows.length, 0) }] : []),
    ...(camRows.length ? [{ label: "Camere", value: fmt(camRows.length, 0) }] : []),
    ...(animRows.length
      ? [{ label: "Animazione", value: `${animRows.length} canali, ${fmt(tMin)}–${fmt(tMax)} s` }]
      : []),
  ];
  if (hasBB)
    assetRows.push(
      { Campo: "Bounding box min", Valore: bbMin.map((v) => fmt(v)).join(", ") },
      { Campo: "Bounding box max", Valore: bbMax.map((v) => fmt(v)).join(", ") },
    );

  return { fileName, fileSize, summary, sections, warnings, text: xml };
}

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}

function colorStr(c: number[]) {
  if (c.length < 3) return "";
  const hex = "#" + c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
  return c.length > 3 && c[3] !== 1 ? `${hex} (α ${c[3]})` : hex;
}

function formatDate(s: string) {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : `${d.toLocaleString("it-IT")} (${s})`;
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
