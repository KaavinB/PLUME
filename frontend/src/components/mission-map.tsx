"use client";

import maplibregl, { type GeoJSONSource, type Map as MLMap, type StyleSpecification } from "maplibre-gl";
import { useEffect, useRef } from "react";

import { fmtNum, INSTRUMENTS } from "@/lib/format";
import type { ObsGeoJSON } from "@/lib/types";

export type Basemap = "dark" | "satellite";

const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf",
  sources: {
    esri: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 18,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0a0c0f" } },
    { id: "esri", type: "raster", source: "esri", paint: { "raster-saturation": -0.35, "raster-brightness-max": 0.75 } },
  ],
};

// One-hue sequential ramp (amber), dark → bright with increasing reported emission rate.
export const RATE_STOPS: [number, string][] = [
  [0, "#6b4a1a"],
  [100, "#94651f"],
  [300, "#c48327"],
  [1000, "#eba039"],
  [3000, "#ffc56a"],
  [10000, "#ffe3a8"],
];
const NO_RATE = "#5f6670";
// Keep the focus point clear of the floating left column and right drawer.
const VIEW_PADDING = { left: 330, right: 410, top: 0, bottom: 0 };

export interface PlumeOverlay {
  url: string;
  bounds: [number, number, number, number];
}

interface Props {
  data: ObsGeoJSON | undefined;
  basemap: Basemap;
  showObservations: boolean;
  showPlume: boolean;
  cluster: boolean;
  selectedIncident: string | null;
  selectedObservation: string | null;
  plume: PlumeOverlay | null;
  flyTo: { lon: number; lat: number; zoom?: number; key: number } | null;
  /** Selected observation. The map flies to it unless the selection came from a click on the map. */
  focus: { id: string; lon: number; lat: number } | null;
  onSelect: (obsId: string) => void;
  onViewChange?: (bbox: [number, number, number, number]) => void;
}

const ATTRIB = 'Methane data © <a href="https://carbonmapper.org" target="_blank" rel="noreferrer">Carbon Mapper</a>';

export function MissionMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const propsRef = useRef(props);
  const readyRef = useRef(false);
  const clickedRef = useRef<string | null>(null);
  useEffect(() => {
    propsRef.current = props;
  });

  // --- create map once
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: props.basemap === "dark" ? DARK_STYLE : SATELLITE_STYLE,
      center: [-102.75, 32.1],
      zoom: 6.6,
      minZoom: 3,
      maxZoom: 17,
      attributionControl: { compact: true, customAttribution: ATTRIB },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: "260px" });

    map.on("style.load", () => {
      installLayers(map);
      readyRef.current = true;
      sync(map, propsRef.current);
    });
    map.on("click", "obs-cluster", async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const src = map.getSource("obs") as GeoJSONSource;
      const zoom = await src.getClusterExpansionZoom(f.properties.cluster_id as number);
      map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: zoom + 0.3 });
    });
    map.on("click", "obs-point", (e) => {
      const f = e.features?.[0];
      if (f) {
        clickedRef.current = String(f.properties.id);
        propsRef.current.onSelect(String(f.properties.id));
      }
    });
    for (const layer of ["obs-point", "obs-cluster"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
        hover.remove();
      });
    }
    map.on("mousemove", "obs-point", (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number | null>;
      const rate = p.rate === null || p.rate === "null" ? "No provider estimate" : `${fmtNum(Number(p.rate))} ± ${fmtNum(Number(p.unc))} kg/h`;
      hover
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:12px;line-height:1.5"><div style="font-family:var(--font-mono);font-size:11px;color:var(--text-2)">${p.id}</div>` +
            `<div style="margin-top:2px"><b>${rate}</b></div><div style="color:var(--text-3)">${p.t} · ${INSTRUMENTS[String(p.inst)] ?? p.inst} · ${p.incident}</div></div>`,
        )
        .addTo(map);
    });
    map.on("mousemove", "obs-cluster", (e) => {
      const f = e.features?.[0];
      if (!f) return;
      hover
        .setLngLat(e.lngLat)
        .setHTML(`<div style="font-size:12px">${f.properties.point_count} observations · click to expand</div>`)
        .addTo(map);
    });
    map.on("moveend", () => {
      const b = map.getBounds();
      propsRef.current.onViewChange?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    });
    return () => {
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- basemap switch (re-installs layers on style.load)
  const lastBasemap = useRef(props.basemap);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lastBasemap.current === props.basemap) return;
    lastBasemap.current = props.basemap;
    readyRef.current = false;
    map.setStyle(props.basemap === "dark" ? DARK_STYLE : SATELLITE_STYLE);
  }, [props.basemap]);

  // --- data / selection / overlays
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) sync(map, props);
  }, [props]);

  // --- follow the selection when it was made outside the map (URL, lists, search)
  const focusId = props.focus?.id ?? null;
  useEffect(() => {
    const map = mapRef.current;
    const f = propsRef.current.focus;
    if (!map || !f || f.id === clickedRef.current) return;
    clickedRef.current = f.id;
    map.flyTo({ center: [f.lon, f.lat], zoom: 12.5, speed: 1.6, padding: VIEW_PADDING });
  }, [focusId]);

  // --- fly to
  useEffect(() => {
    const map = mapRef.current;
    if (map && props.flyTo) map.flyTo({ center: [props.flyTo.lon, props.flyTo.lat], zoom: props.flyTo.zoom ?? 13, speed: 1.6, padding: VIEW_PADDING });
  }, [props.flyTo]);

  // maplibre's own stylesheet forces `position: relative` on the container, so size it via a wrapper.
  return (
    <div className="absolute inset-0">
      <div ref={container} style={{ width: "100%", height: "100%" }} data-testid="mission-map" />
    </div>
  );
}

let lastCluster: boolean | null = null;

function installLayers(map: MLMap) {
  lastCluster = null;
  map.addSource("sel", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "sel-ring",
    type: "circle",
    source: "sel",
    paint: {
      "circle-radius": ["case", ["==", ["get", "primary"], true], 11, 8],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": ["case", ["==", ["get", "primary"], true], "#ede8df", "#4fb3a9"],
      "circle-stroke-width": ["case", ["==", ["get", "primary"], true], 2, 1.5],
    },
  });
}

function ensureObsSource(map: MLMap, cluster: boolean, data: ObsGeoJSON) {
  if (lastCluster === cluster && map.getSource("obs")) {
    (map.getSource("obs") as GeoJSONSource).setData(data as unknown as GeoJSON.FeatureCollection);
    return;
  }
  for (const id of ["obs-cluster", "obs-cluster-count", "obs-point"]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource("obs")) map.removeSource("obs");
  lastCluster = cluster;
  map.addSource("obs", {
    type: "geojson",
    data: data as unknown as GeoJSON.FeatureCollection,
    cluster,
    clusterRadius: 38,
    clusterMaxZoom: 9,
  });
  const before = map.getLayer("sel-ring") ? "sel-ring" : undefined;
  map.addLayer(
    {
      id: "obs-cluster",
      type: "circle",
      source: "obs",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "rgba(17,21,26,0.85)",
        "circle-stroke-color": "#f2a93b",
        "circle-stroke-opacity": 0.7,
        "circle-stroke-width": 1.5,
        "circle-radius": ["step", ["get", "point_count"], 13, 25, 16, 100, 20, 500, 25],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: "obs-cluster-count",
      type: "symbol",
      source: "obs",
      filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11, "text-font": ["Montserrat Medium", "Open Sans Bold", "Noto Sans Regular"] },
      paint: { "text-color": "#ede8df" },
    },
    before,
  );
  map.addLayer(
    {
      id: "obs-point",
      type: "circle",
      source: "obs",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 5, 14, 7],
        "circle-color": [
          "case",
          ["==", ["get", "rate"], null],
          NO_RATE,
          ["interpolate", ["linear"], ["get", "rate"], ...RATE_STOPS.flat()],
        ],
        "circle-stroke-color": "#0a0c0f",
        "circle-stroke-width": 1.2,
      },
    },
    before,
  );
}

function sync(map: MLMap, p: Props) {
  if (p.data) ensureObsSource(map, p.cluster, p.data);
  for (const id of ["obs-cluster", "obs-cluster-count", "obs-point"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", p.showObservations ? "visible" : "none");
  }
  // Selection ring: all observations of the selected incident, primary = selected observation
  const feats = (p.data?.features ?? [])
    .filter((f) => p.selectedIncident && f.properties.incident === p.selectedIncident)
    .map((f) => ({ ...f, properties: { primary: f.properties.id === p.selectedObservation } }));
  (map.getSource("sel") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: feats } as GeoJSON.FeatureCollection);

  // Provider plume raster
  const current = map.getSource("plume") as maplibregl.ImageSource | undefined;
  const want = p.showPlume && p.plume;
  const key = want ? `${p.plume!.url}` : null;
  const existingKey = (map as unknown as { __plumeKey?: string | null }).__plumeKey ?? null;
  if (key !== existingKey) {
    if (map.getLayer("plume")) map.removeLayer("plume");
    if (current) map.removeSource("plume");
    (map as unknown as { __plumeKey?: string | null }).__plumeKey = key;
    if (want) {
      const [minx, miny, maxx, maxy] = p.plume!.bounds;
      map.addSource("plume", {
        type: "image",
        url: p.plume!.url,
        coordinates: [
          [minx, maxy],
          [maxx, maxy],
          [maxx, miny],
          [minx, miny],
        ],
      });
      map.addLayer({ id: "plume", type: "raster", source: "plume", paint: { "raster-opacity": 0.9, "raster-fade-duration": 200 } }, map.getLayer("obs-cluster") ? "obs-cluster" : undefined);
    }
  }
}
