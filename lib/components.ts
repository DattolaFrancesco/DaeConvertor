// Individua i componenti del mobile (figli del nodo radice del modello),
// ne misura l'ingombro reale e ne stima il ruolo dalla geometria.

import * as THREE from "three";

export type Role =
  | "Fianco"
  | "Divisorio verticale"
  | "Cielo"
  | "Ripiano"
  | "Fondo"
  | "Schiena"
  | "Anta"
  | "Anta / frontale"
  | "Pannello verticale interno"
  | "Zoccolo"
  | "Listello / traverso"
  | "Blocco / elemento spesso"
  | "Superficie senza spessore"
  | "Ferramenta / piccolo oggetto"
  | "Oggetto / accessorio"
  | "Ambiente / contesto";

export const ROLE_ORDER: Role[] = [
  "Fianco",
  "Divisorio verticale",
  "Cielo",
  "Ripiano",
  "Fondo",
  "Schiena",
  "Anta",
  "Anta / frontale",
  "Pannello verticale interno",
  "Zoccolo",
  "Listello / traverso",
  "Blocco / elemento spesso",
  "Superficie senza spessore",
  "Ferramenta / piccolo oggetto",
  "Oggetto / accessorio",
  "Ambiente / contesto",
];

export const HIDEABLE_FRONTS: Role[] = ["Anta", "Anta / frontale"];

export type ColorInfo = {
  /** Colore del materiale prevalente (sRGB, es. "#58774f"). */
  hex: string;
  /** Famiglia cromatica: "Verde", "Bianco", … oppure "Con texture". */
  family: string;
  material: string;
  textured: boolean;
};

export type Component = {
  id: string;
  name: string;
  role: Role;
  color: ColorInfo;
  /** Ingombro in mm sugli assi del mobile: larghezza (X), altezza (Y), profondità (Z). */
  size: [number, number, number];
  thickness: number;
  /** Quota della base rispetto al pavimento del mobile, in mm. */
  elevation: number;
  materials: string[];
  triangles: number;
};

type Raw = {
  id: string;
  name: string;
  min: THREE.Vector3;
  max: THREE.Vector3;
  materials: string[];
  triangles: number;
  color: ColorInfo;
};

export function extractComponents(model: THREE.Object3D, xml: string) {
  model.updateMatrixWorld(true);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const byId = new Map<string, Element>();
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    const id = el.getAttribute("id");
    if (id) byId.set(id, el);
  }
  const childNodes = (el: Element): Element[] => Array.from(el.children).filter((c) => c.localName === "node");
  // Un nodo che contiene solo un'istanza di componente viene "fuso" da ColladaLoader con la definizione.
  const resolve = (el: Element): Element => {
    const inst = Array.from(el.children).filter((c) => c.localName === "instance_node");
    const geo = Array.from(el.children).some((c) => c.localName === "instance_geometry");
    if (!childNodes(el).length && !geo && inst.length === 1) {
      const def = byId.get((inst[0].getAttribute("url") ?? "").replace(/^#/, ""));
      if (def) return resolve(def);
    }
    return el;
  };

  const activeId = doc.getElementsByTagNameNS("*", "instance_visual_scene")[0]?.getAttribute("url")?.replace(/^#/, "");
  let dom: Element | undefined =
    (activeId && byId.get(activeId)) || doc.getElementsByTagNameNS("*", "visual_scene")[0];

  // Scende finché il modello è un unico contenitore (es. il nodo "SketchUp").
  let container: THREE.Object3D = model;
  for (;;) {
    const withMesh = container.children.filter(hasMesh);
    if (withMesh.length !== 1 || (withMesh[0] as THREE.Mesh).isMesh) break;
    const idx = container.children.indexOf(withMesh[0]);
    const domKids: Element[] = dom ? childNodes(dom) : [];
    dom = idx < domKids.length ? resolve(domKids[idx]) : undefined;
    container = withMesh[0];
  }

  // I primi N figli three.js corrispondono, in ordine, ai <node> figli nel DOM.
  const domKids: Element[] = dom ? childNodes(dom) : [];
  const raws: Raw[] = [];
  const objects = new Map<string, THREE.Object3D>();
  container.children.forEach((obj, i) => {
    if (!hasMesh(obj)) return;
    const el = domKids[i];
    const name = el ? displayName(el, resolve) : obj.name || "Geometria libera";
    const box = new THREE.Box3().setFromObject(obj, true);
    if (box.isEmpty()) return;
    const materials = new Set<string>();
    let triangles = 0;
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => mat.name && materials.add(mat.name));
    });
    const id = `c${i}`;
    objects.set(id, obj);
    raws.push({
      color: dominantColor(obj),
      id,
      name,
      min: box.min.clone().multiplyScalar(1000),
      max: box.max.clone().multiplyScalar(1000),
      materials: [...materials].filter((n) => !/^edge_color/.test(n)),
      triangles: Math.round(triangles),
    });
  });

  const { components, furniture } = classify(raws);
  return { components, objects, furniture };
}

function displayName(el: Element, resolve: (el: Element) => Element) {
  const def = resolve(el);
  return def !== el ? def.getAttribute("name") || el.getAttribute("name") || "(senza nome)" : el.getAttribute("name") || "(senza nome)";
}

// Materiale che copre la superficie maggiore del componente.
function dominantColor(obj: THREE.Object3D): ColorInfo {
  const areas = new Map<THREE.Material, number>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const count = index ? index.count : pos.count;
    const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const g of groups) {
      const mat = mats[g.materialIndex ?? 0];
      if (!mat) continue;
      let area = 0;
      for (let k = g.start; k + 2 < Math.min(g.start + g.count, count); k += 3) {
        const v = (n: number) => (index ? index.getX(n) : n);
        a.fromBufferAttribute(pos, v(k)).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, v(k + 1)).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, v(k + 2)).applyMatrix4(mesh.matrixWorld);
        area += b.sub(a).cross(c.sub(a)).length() / 2;
      }
      areas.set(mat, (areas.get(mat) ?? 0) + area);
    }
  });
  const best = [...areas.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] as THREE.MeshLambertMaterial | undefined;
  if (!best) return { hex: "#cccccc", family: "Senza colore", material: "", textured: false };
  const textured = !!best.map;
  const hex = "#" + (best.color ? best.color.getHexString() : "cccccc");
  return { hex, family: textured ? "Con texture" : colorFamily(hex), material: best.name || "(senza nome)", textured };
}

export function colorFamily(hex: string) {
  const { h: hh, s, l } = new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 });
  const h = hh * 360;
  if (l < 0.12) return "Nero";
  if (s < 0.12 || (l > 0.92 && s < 0.5)) return l > 0.85 ? "Bianco" : "Grigio";
  if (h >= 20 && h < 50 && l < 0.45) return "Marrone";
  if (h >= 25 && h < 60 && l > 0.7 && s < 0.6) return "Beige";
  if (h < 15 || h >= 345) return "Rosso";
  if (h < 40) return "Arancione";
  if (h < 65) return "Giallo";
  if (h < 165) return "Verde";
  if (h < 200) return "Azzurro";
  if (h < 255) return "Blu";
  if (h < 290) return "Viola";
  return "Rosa";
}

function hasMesh(o: THREE.Object3D) {
  let found = false;
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) found = true;
  });
  return found;
}

const overlap = (a0: number, a1: number, b0: number, b1: number, tol = 5) => Math.min(a1, b1) - Math.max(a0, b0) > tol;

function classify(raws: Raw[]) {
  const sizeOf = (r: Raw) => r.max.clone().sub(r.min);
  const vol = (r: Raw) => {
    const s = sizeOf(r);
    return s.x * s.y * s.z;
  };

  // Ambiente: il volume più grande che contiene il centro della maggior parte degli altri.
  const contextIds = new Set<string>();
  if (raws.length >= 4) {
    const biggest = [...raws].sort((a, b) => vol(b) - vol(a))[0];
    const box = new THREE.Box3(biggest.min, biggest.max);
    const inside = raws.filter((r) => r !== biggest && box.containsPoint(r.min.clone().add(r.max).multiplyScalar(0.5)));
    if (inside.length >= 0.7 * (raws.length - 1) && biggest.triangles > 24) contextIds.add(biggest.id);
  }

  type Info = { r: Raw; s: THREE.Vector3; sorted: number[]; thinAxis: 0 | 1 | 2; isPanel: boolean };
  const infos: Info[] = raws.map((r) => {
    const s = sizeOf(r);
    const arr = [s.x, s.y, s.z];
    const sorted = [...arr].sort((a, b) => b - a);
    const thinAxis = arr.indexOf(sorted[2]) as 0 | 1 | 2;
    const isPanel = sorted[2] >= 1 && sorted[2] <= 40 && sorted[1] >= 60 && r.triangles <= 400;
    return { r, s, sorted, thinAxis, isPanel };
  });

  // Ingombro del mobile: solo pannelli e listelli, così gli oggetti appoggiati non lo alterano.
  const furn = new THREE.Box3();
  const structural = infos.filter(
    (i) => !contextIds.has(i.r.id) && i.sorted[2] >= 1 && i.sorted[2] <= 40 && i.sorted[0] >= 250 && i.r.triangles <= 400,
  );
  (structural.length ? structural : infos.filter((i) => !contextIds.has(i.r.id))).forEach((i) =>
    furn.union(new THREE.Box3(i.r.min, i.r.max)),
  );
  const floor = furn.min.y;
  const height = furn.max.y - furn.min.y;
  const insideFurn = (i: Info) => furn.containsPoint(i.r.min.clone().add(i.r.max).multiplyScalar(0.5));

  // Fronte: il lato (Z min o Z max) con più pannelli verticali affacciati.
  const zPanels = infos.filter((i) => i.isPanel && i.thinAxis === 2 && !contextIds.has(i.r.id));
  const nearMax = zPanels.filter((i) => furn.max.z - i.r.max.z < 60).length;
  const nearMin = zPanels.filter((i) => i.r.min.z - furn.min.z < 60).length;
  const frontIsMax = nearMax >= nearMin;
  const frontDist = (i: Info) => (frontIsMax ? furn.max.z - i.r.max.z : i.r.min.z - furn.min.z);
  const ahead = (a: Info, b: Info) => (frontIsMax ? a.r.min.z > b.r.max.z - 1 : a.r.max.z < b.r.min.z + 1);
  const xOverlap = (a: Info, b: Info) => overlap(a.r.min.x, a.r.max.x, b.r.min.x, b.r.max.x);
  const yOverlap = (a: Info, b: Info) => overlap(a.r.min.y, a.r.max.y, b.r.min.y, b.r.max.y);
  const xzOverlap = (a: Info, b: Info) => xOverlap(a, b) && overlap(a.r.min.z, a.r.max.z, b.r.min.z, b.r.max.z);

  const roleOf = (i: Info): Role => {
    const { r, s, sorted } = i;
    const elevation = r.min.y - floor;
    if (contextIds.has(r.id)) return "Ambiente / contesto";
    if (sorted[2] < 1) return "Superficie senza spessore";
    if (sorted[0] < 250) return "Ferramenta / piccolo oggetto";
    if (elevation < 10 && s.y <= 150 && sorted[2] <= 40 && Math.max(s.x, s.z) >= 300) return "Zoccolo";
    if (!i.isPanel) {
      if (sorted[1] < 60 && sorted[2] <= 40) return "Listello / traverso";
      return r.triangles <= 100 && insideFurn(i) ? "Blocco / elemento spesso" : "Oggetto / accessorio";
    }
    if (sorted[1] <= 120) return "Listello / traverso";
    if (i.thinAxis === 0) return s.y >= 0.6 * height ? "Fianco" : "Divisorio verticale";
    if (i.thinAxis === 1) {
      if (elevation <= 120) return "Fondo";
      const above = infos.some((o) => o !== i && o.isPanel && o.thinAxis === 1 && o.sorted[1] > 120 && o.r.min.y > r.max.y && xzOverlap(o, i));
      return above ? "Ripiano" : "Cielo";
    }
    // Pannello sul piano frontale/posteriore.
    const others = zPanels.filter((o) => o !== i && xOverlap(o, i) && yOverlap(o, i) && o.sorted[1] > 120 && insideFurn(o));
    const frontmost = !others.some((o) => ahead(o, i));
    const rearmost = !others.some((o) => ahead(i, o));
    if (frontmost && frontDist(i) < 60) return s.y >= 0.5 * height ? "Anta" : "Anta / frontale";
    if ((rearmost || sorted[2] <= 12) && s.x >= 300 && s.y >= 0.5 * height) return "Schiena";
    return "Pannello verticale interno";
  };

  const components: Component[] = infos.map((i) => ({
    id: i.r.id,
    name: i.r.name,
    role: roleOf(i),
    size: [i.s.x, i.s.y, i.s.z].map((v) => Math.round(v)) as [number, number, number],
    thickness: Math.round(i.sorted[2]),
    elevation: Math.round(i.r.min.y - floor),
    materials: i.r.materials,
    triangles: i.r.triangles,
    color: i.r.color,
  }));
  const fs = furn.getSize(new THREE.Vector3());
  return {
    components,
    furniture: furn.isEmpty() ? null : ([fs.x, fs.y, fs.z].map((v) => Math.round(v)) as [number, number, number]),
  };
}

export type ComponentGroup = {
  key: string;
  name: string;
  role: Role;
  size: [number, number, number];
  thickness: number;
  materials: string[];
  ids: string[];
  elevations: number[];
};

export function groupComponents(list: Component[]): ComponentGroup[] {
  const map = new Map<string, ComponentGroup>();
  for (const c of list) {
    const key = `${c.name}|${c.role}|${[...c.size].sort((a, b) => b - a).join("x")}`;
    const g = map.get(key);
    if (g) {
      g.ids.push(c.id);
      g.elevations.push(c.elevation);
    } else
      map.set(key, {
        key,
        name: c.name,
        role: c.role,
        size: c.size,
        thickness: c.thickness,
        materials: c.materials,
        ids: [c.id],
        elevations: [c.elevation],
      });
  }
  return [...map.values()].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.size[1] - a.size[1] || a.name.localeCompare(b.name),
  );
}
