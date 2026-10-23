"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { extractComponents, HIDEABLE_FRONTS, type Component } from "@/lib/components";

const WHITE_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const HIGHLIGHT = 0x2f6bff;

type Props = {
  xml: string;
  highlight: string[];
  onComponents: (list: Component[], furniture: [number, number, number] | null) => void;
  onHover: (id: string | null) => void;
};

type Saved = { opacity: number; transparent: boolean; depthWrite: boolean; emissive?: THREE.Color };

export default function Preview({ xml, highlight, onComponents, onHover }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [wire, setWire] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [hideFronts, setHideFronts] = useState(false);
  const [tip, setTip] = useState<Component | null>(null);

  const modelRef = useRef<THREE.Object3D | null>(null);
  const objectsRef = useRef(new Map<string, THREE.Object3D>());
  const compsRef = useRef(new Map<string, Component>());
  const helpersRef = useRef<THREE.Group | null>(null);
  const cbRef = useRef({ onComponents, onHover });
  cbRef.current = { onComponents, onHover };

  useEffect(() => {
    const el = ref.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
    const dir = new THREE.DirectionalLight(0xffffff, 2);
    dir.position.set(3, 5, 4);
    scene.add(dir);
    const helpers = new THREE.Group();
    scene.add(helpers);
    helpersRef.current = helpers;

    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.001, 1e7);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const meshToComp = new Map<THREE.Object3D, string>();
    try {
      // Le texture esterne non sono disponibili nel browser: le sostituisce con un pixel bianco.
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => (url.startsWith("data:") || url.startsWith("blob:") ? url : WHITE_PIXEL));
      const collada = new ColladaLoader(manager).parse(xml, "");
      if (!collada?.scene) throw new Error("Nessuna scena trovata");
      const model = collada.scene;
      scene.add(model);
      modelRef.current = model;

      // Materiali per-mesh, così l'evidenziazione non si propaga ai pezzi che li condividono.
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.material) return;
        m.material = Array.isArray(m.material) ? m.material.map(cloneMat) : cloneMat(m.material);
      });

      const { components, objects, furniture } = extractComponents(model, xml);
      objectsRef.current = objects;
      compsRef.current = new Map(components.map((c) => [c.id, c]));
      for (const [id, obj] of objects) obj.traverse((o) => meshToComp.set(o, id));
      cbRef.current.onComponents(components, furniture);

      // Inquadra il mobile, escluso l'ambiente.
      const box = new THREE.Box3();
      for (const c of components) if (c.role !== "Ambiente / contesto") box.expandByObject(objects.get(c.id)!);
      if (box.isEmpty()) box.setFromObject(model);
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      const center = box.getCenter(new THREE.Vector3());
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(size * 0.55, size * 0.35, size * 0.9));
      camera.near = size / 1000;
      camera.far = size * 100;
      camera.updateProjectionMatrix();
      const grid = new THREE.GridHelper(size * 1.5, 15, 0x888888, 0x444444);
      grid.position.set(center.x, box.min.y, center.z);
      scene.add(grid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }

    // Hover nel 3D: individua il componente sotto il cursore.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered: string | null = null;
    const setHovered = (id: string | null) => {
      if (id === hovered) return;
      hovered = id;
      setTip(id ? compsRef.current.get(id) ?? null : null);
      cbRef.current.onHover(id);
    };
    const onMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      if (tipRef.current) tipRef.current.style.transform = `translate(${e.clientX - rect.left + 14}px, ${e.clientY - rect.top + 14}px)`;
      if (e.buttons) return; // durante la rotazione non cambia selezione
      raycaster.setFromCamera(pointer, camera);
      const pickable: THREE.Object3D[] = [];
      for (const [, obj] of objectsRef.current) {
        if (!obj.visible) continue;
        obj.traverse((o) => (o as THREE.Mesh).isMesh && o.visible && pickable.push(o));
      }
      const hit = raycaster.intersectObjects(pickable, false)[0];
      setHovered(hit ? meshToComp.get(hit.object) ?? null : null);
    };
    const onLeave = () => setHovered(null);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerleave", onLeave);

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    const ro = new ResizeObserver(() => {
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      modelRef.current = null;
      objectsRef.current = new Map();
      compsRef.current = new Map();
    };
  }, [xml]);

  // Evidenzia i componenti selezionati e rende trasparenti gli altri.
  useEffect(() => {
    const set = new Set(highlight);
    const helpers = helpersRef.current;
    helpers?.clear();
    for (const [id, obj] of objectsRef.current) {
      const on = set.has(id);
      obj.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) applyState(mat, set.size === 0 ? "normal" : on ? "on" : "ghost");
      });
      if (on && obj.visible) helpers?.add(new THREE.Box3Helper(new THREE.Box3().setFromObject(obj, true), HIGHLIGHT));
    }
  }, [highlight]);

  useEffect(() => {
    for (const [id, obj] of objectsRef.current) {
      const role = compsRef.current.get(id)?.role;
      obj.visible =
        (role !== "Ambiente / contesto" || showContext) && !(hideFronts && role && HIDEABLE_FRONTS.includes(role));
    }
  }, [showContext, hideFronts, xml]);

  useEffect(() => {
    modelRef.current?.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      (Array.isArray(m) ? m : m ? [m] : []).forEach((mat) => {
        if ("wireframe" in mat) (mat as THREE.MeshBasicMaterial).wireframe = wire;
      });
    });
  }, [wire]);

  return (
    <div className="preview">
      <div ref={ref} className="preview-canvas" />
      <div className="preview-tools">
        <label>
          <input type="checkbox" checked={hideFronts} onChange={(e) => setHideFronts(e.target.checked)} /> Nascondi ante
        </label>
        <label>
          <input type="checkbox" checked={showContext} onChange={(e) => setShowContext(e.target.checked)} /> Mostra ambiente
        </label>
        <label>
          <input type="checkbox" checked={wire} onChange={(e) => setWire(e.target.checked)} /> Wireframe
        </label>
      </div>
      <div ref={tipRef} className="tip" style={{ display: tip ? "block" : "none" }}>
        {tip && (
          <>
            <strong>{tip.name}</strong>
            <div>{tip.role}</div>
            <div className="muted">
              {tip.size.join(" × ")} mm · sp. {tip.thickness}
            </div>
          </>
        )}
      </div>
      {error && <div className="preview-error">Anteprima non disponibile: {error}</div>}
    </div>
  );
}

function cloneMat(mat: THREE.Material) {
  const c = mat.clone();
  const saved: Saved = { opacity: c.opacity, transparent: c.transparent, depthWrite: c.depthWrite };
  if ("emissive" in c) saved.emissive = (c as THREE.MeshLambertMaterial).emissive.clone();
  c.userData.saved = saved;
  return c;
}

function applyState(mat: THREE.Material, state: "normal" | "on" | "ghost") {
  const s = mat.userData.saved as Saved | undefined;
  if (!s) return;
  mat.opacity = state === "ghost" ? s.opacity * 0.12 : s.opacity;
  mat.transparent = state === "ghost" ? true : s.transparent;
  mat.depthWrite = state === "ghost" ? false : s.depthWrite;
  if (s.emissive) (mat as THREE.MeshLambertMaterial).emissive.copy(state === "on" ? new THREE.Color(HIGHLIGHT).multiplyScalar(0.6) : s.emissive);
  mat.needsUpdate = true;
}
