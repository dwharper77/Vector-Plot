// KML 3D Viewer PWA
// Renders KML in Cesium and provides a folder-tree toggle UI.

const els = {
  kmlInput: document.getElementById('kmlInput'),
  kmlInfo: document.getElementById('kmlInfo'),
  tree: document.getElementById('tree'),
  treeSummary: document.getElementById('treeSummary'),
  zoomTo: document.getElementById('zoomTo'),
  expandAll: document.getElementById('expandAll'),
  collapseAll: document.getElementById('collapseAll'),
  checkAll: document.getElementById('checkAll'),
  uncheckAll: document.getElementById('uncheckAll'),
  search: document.getElementById('search'),
  hideLabels: document.getElementById('hideLabels'),
  status: document.getElementById('status'),
};

function setStatus(msg) {
  if (els.status) els.status.textContent = msg || '';
}

function escapeText(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function roundCoord(n, digits) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function coordKey({ lon, lat }) {
  const lo = roundCoord(lon, 5);
  const la = roundCoord(lat, 5);
  if (lo === null || la === null) return null;
  return `${lo},${la}`;
}

function placemarkKey({ name, lon, lat }) {
  const ck = coordKey({ lon, lat });
  const nm = String(name ?? '').trim();
  return ck ? `${nm}|${ck}` : nm;
}

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad((b.lat ?? 0) - (a.lat ?? 0));
  const dLon = toRad((b.lon ?? 0) - (a.lon ?? 0));
  const lat1 = toRad(a.lat ?? 0);
  const lat2 = toRad(b.lat ?? 0);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------- Cesium init ----------

let viewer = null;
let kmlDataSource = null;

function initCesium() {
  if (viewer) return;

  // Avoid requiring an ion token by using OSM imagery + ellipsoid terrain.
  Cesium.Ion.defaultAccessToken = '';

  const imageryProvider = new Cesium.OpenStreetMapImageryProvider({
    url: 'https://a.tile.openstreetmap.org/',
  });

  viewer = new Cesium.Viewer('cesiumContainer', {
    imageryProvider,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: true,
    sceneModePicker: true,
    navigationHelpButton: true,
    animation: false,
    timeline: false,
    fullscreenButton: true,
    selectionIndicator: true,
    infoBox: true,
    shouldAnimate: true,
  });

  // Make the background match our theme.
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0b1220');

  setStatus('Ready. Load a KML to begin.');
}

// ---------- KML parsing (folders/placemarks) ----------

let state = {
  fileName: null,
  xml: null,
  rootFeature: null,
  nodesById: new Map(),
  rootNodeId: null,
  includePlacemarks: true,
  entityIndex: new Map(), // key -> Cesium.Entity[]
  placemarkIndex: new Map(), // key -> { placemarkEl, path }
  placemarkToEntity: new Map(), // placemarkKey -> Cesium.Entity[]
  filterText: '',
  userHasInteracted: false,
};

function nextIdFactory() {
  let n = 1;
  return () => `n${n++}`;
}

function getChildFeatures(featureEl) {
  return Array.from(featureEl.children).filter((c) => {
    const t = c.tagName;
    return t === 'Folder' || t === 'Placemark' || t === 'Document';
  });
}

function getFeatureName(featureEl) {
  const nameEl = featureEl.querySelector(':scope > name');
  const name = nameEl?.textContent?.trim();
  return name || featureEl.tagName;
}

function firstCoordFromPlacemark(placemarkEl) {
  const coordEl = placemarkEl.querySelector('Point > coordinates, LineString > coordinates, MultiGeometry coordinates');
  const txt = coordEl?.textContent?.trim();
  if (!txt) return null;

  // coordinates can be "lon,lat,alt lon,lat,alt ..." or newline-separated
  const firstToken = txt.split(/\s+/).find(Boolean);
  if (!firstToken) return null;

  const [lonS, latS] = firstToken.split(',');
  const lon = Number(lonS);
  const lat = Number(latS);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon, lat };
}

function buildTreeFromKml(rootFeatureEl) {
  const nextId = nextIdFactory();
  const nodesById = new Map();
  const placemarkIndex = new Map();

  function buildNode(featureEl, parentId, pathNames) {
    const tag = featureEl.tagName;
    const name = getFeatureName(featureEl);
    const id = nextId();

    const node = {
      id,
      parentId,
      name,
      tag,
      featureEl,
      children: [],
      checked: true,
      indeterminate: false,
      expanded: tag !== 'Placemark',
      placemarkKeys: [],
    };

    nodesById.set(id, node);

    if (tag === 'Placemark') {
      const c = firstCoordFromPlacemark(featureEl);
      const key = placemarkKey({ name, lon: c?.lon, lat: c?.lat });
      node.placemarkKeys.push(key);
      placemarkIndex.set(key, { placemarkEl: featureEl, path: pathNames.concat([name]) });
      return node;
    }

    for (const childEl of getChildFeatures(featureEl)) {
      const childTag = childEl.tagName;
      const childName = getFeatureName(childEl);
      const childPath = (childTag === 'Placemark') ? pathNames : pathNames.concat([childName]);
      const childNode = buildNode(childEl, id, childPath);
      if (childNode) {
        node.children.push(childNode.id);
        // Aggregate placemark keys upward
        node.placemarkKeys.push(...childNode.placemarkKeys);
      }
    }

    // De-dupe keys
    if (node.placemarkKeys.length > 1) {
      node.placemarkKeys = Array.from(new Set(node.placemarkKeys));
    }

    return node;
  }

  const rootNode = buildNode(rootFeatureEl, null, [getFeatureName(rootFeatureEl)]);
  return { nodesById, rootNodeId: rootNode.id, placemarkIndex };
}

function findRootFeature(xml) {
  const docEl = xml.getElementsByTagName('Document')[0];
  if (docEl) return docEl;
  const folderEl = xml.getElementsByTagName('Folder')[0];
  if (folderEl) return folderEl;
  return null;
}

// ---------- Toggle math ----------

function setCheckedRecursive(nodeId, checked) {
  const node = state.nodesById.get(nodeId);
  if (!node) return;
  node.checked = checked;
  node.indeterminate = false;
  for (const childId of node.children) setCheckedRecursive(childId, checked);
}

function recomputeIndeterminateUp(nodeId) {
  let currentId = nodeId;
  while (true) {
    const node = state.nodesById.get(currentId);
    if (!node) break;

    if (node.children.length === 0) {
      node.indeterminate = false;
    } else {
      const childStates = node.children.map((id) => {
        const c = state.nodesById.get(id);
        return { checked: Boolean(c?.checked), ind: Boolean(c?.indeterminate) };
      });

      const allChecked = childStates.every((s) => s.checked && !s.ind);
      const allUnchecked = childStates.every((s) => !s.checked && !s.ind);

      if (allChecked) {
        node.checked = true;
        node.indeterminate = false;
      } else if (allUnchecked) {
        node.checked = false;
        node.indeterminate = false;
      } else {
        node.checked = true;
        node.indeterminate = true;
      }
    }

    if (!node.parentId) break;
    currentId = node.parentId;
  }
}

function setExpandedRecursive(nodeId, expanded) {
  const node = state.nodesById.get(nodeId);
  if (!node) return;
  if (node.children.length === 0) return;
  node.expanded = expanded;
  for (const childId of node.children) setExpandedRecursive(childId, expanded);
}

function getEffectiveChecked(nodeId) {
  let cur = state.nodesById.get(nodeId);
  if (!cur) return false;
  if (!cur.checked) return false;
  while (cur.parentId) {
    cur = state.nodesById.get(cur.parentId);
    if (!cur?.checked) return false;
  }
  return true;
}

// ---------- Entity indexing & visibility ----------

function firstCoordFromEntity(entity) {
  // Point
  if (entity.position) {
    const cart = entity.position.getValue(Cesium.JulianDate.now());
    if (cart) {
      const c = Cesium.Cartographic.fromCartesian(cart);
      return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
    }
  }

  // Polyline
  if (entity.polyline?.positions) {
    const pos = entity.polyline.positions.getValue(Cesium.JulianDate.now());
    if (Array.isArray(pos) && pos.length) {
      const c = Cesium.Cartographic.fromCartesian(pos[0]);
      return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
    }
  }

  return null;
}

function rebuildEntityIndex() {
  state.entityIndex = new Map();
  if (!kmlDataSource) return;

  const ents = kmlDataSource.entities.values;
  for (const e of ents) {
    const name = e.name || '';
    const c = firstCoordFromEntity(e);
    const key = placemarkKey({ name, lon: c?.lon, lat: c?.lat });
    const arr = state.entityIndex.get(key) || [];
    arr.push(e);
    state.entityIndex.set(key, arr);
  }
}

function rebuildPlacemarkToEntityMap() {
  state.placemarkToEntity = new Map();
  if (!kmlDataSource || !state.placemarkIndex?.size) return;

  // Build candidate pools of entities by name, with coordinates for distance matching.
  const byName = new Map(); // name -> [{ entity, coord }]
  for (const e of kmlDataSource.entities.values) {
    // Heuristic: treat entities with some geometry as candidates.
    if (!e.position && !e.polyline && !e.polygon) continue;
    const name = String(e.name || '').trim();
    const coord = firstCoordFromEntity(e);
    const arr = byName.get(name) || [];
    arr.push({ entity: e, coord });
    byName.set(name, arr);
  }

  // For each Placemark in the KML, try to match to Cesium entities by name, then nearest coordinate.
  const used = new Set();
  for (const [pmKey, info] of state.placemarkIndex.entries()) {
    const pmEl = info.placemarkEl;
    const pmName = getFeatureName(pmEl);
    const pmCoord = firstCoordFromPlacemark(pmEl);

    const candidates = (byName.get(String(pmName).trim()) || []).filter((c) => !used.has(c.entity.id));
    let best = null;

    if (candidates.length === 1) {
      best = candidates[0];
    } else if (candidates.length > 1 && pmCoord) {
      let bestDist = Infinity;
      for (const c of candidates) {
        if (!c.coord) continue;
        const d = haversineMeters({ lon: pmCoord.lon, lat: pmCoord.lat }, c.coord);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      // If none have coords, just pick the first unused.
      if (!best) best = candidates[0];
    }

    // Fallback: if name match fails, try exact key match from entityIndex.
    if (!best) {
      const exact = state.entityIndex.get(pmKey);
      if (exact?.length) {
        state.placemarkToEntity.set(pmKey, exact);
        for (const e of exact) used.add(e.id);
        continue;
      }
    }

    if (best) {
      state.placemarkToEntity.set(pmKey, [best.entity]);
      used.add(best.entity.id);
    }
  }
}

function applyVisibilityFromTree() {
  if (!kmlDataSource) return;

  // Build a set of enabled placemark keys based on leaf placemark nodes effective checked.
  // We derive it by iterating all nodes and using their placemarkKeys.
  const enabledKeys = new Set();

  for (const node of state.nodesById.values()) {
    if (node.tag === 'Placemark') {
      const effective = getEffectiveChecked(node.id);
      for (const k of node.placemarkKeys) {
        if (effective) enabledKeys.add(k);
      }
    }
  }

  // If we haven't mapped placemarks to entities yet, do it now.
  if (!state.placemarkToEntity || state.placemarkToEntity.size === 0) {
    rebuildPlacemarkToEntityMap();
  }

  const mappedCount = state.placemarkToEntity?.size || 0;
  const totalEntities = kmlDataSource.entities.values.length;

  // If mapping is missing, do not risk hiding everything.
  if (mappedCount === 0) {
    for (const e of kmlDataSource.entities.values) e.show = true;
    setStatus(`Showing all entities (no placemark mapping yet). Entities: ${totalEntities.toLocaleString()}`);
    return;
  }

  // After the user interacts with the Places tree, treat it as authoritative:
  // - Start by hiding EVERYTHING, then only show enabled placemarks.
  // This makes "uncheck all" actually hide all vectors.
  if (state.userHasInteracted) {
    for (const e of kmlDataSource.entities.values) e.show = false;

    for (const key of enabledKeys) {
      const entities = state.placemarkToEntity.get(key);
      if (!entities) continue;
      for (const e of entities) e.show = true;
    }

    setStatus(
      `Toggles applied. Showing ${enabledKeys.size.toLocaleString()} placemarks • ` +
      `Mapped placemarks: ${mappedCount.toLocaleString()} • Entities: ${totalEntities.toLocaleString()}`
    );
  } else {
    // Before any interaction, keep the view permissive (show all).
    for (const e of kmlDataSource.entities.values) e.show = true;
    setStatus(`Ready. Entities: ${totalEntities.toLocaleString()} • Mapped placemarks: ${mappedCount.toLocaleString()}`);
  }

  // Optionally hide labels by hiding label/billboard (but keep geometry).
  const hideLabels = Boolean(els.hideLabels?.checked);
  for (const e of kmlDataSource.entities.values) {
    if (e.label) e.label.show = !hideLabels;
    if (e.billboard) e.billboard.show = !hideLabels;
  }

  // Status is updated above.
}

// ---------- Render tree UI ----------

function computeTotals() {
  let folders = 0;
  let placemarks = 0;
  for (const n of state.nodesById.values()) {
    if (n.tag === 'Placemark') placemarks += 1;
    else folders += 1;
  }
  return { folders, placemarks };
}

function matchesFilter(node) {
  const q = state.filterText.trim().toLowerCase();
  if (!q) return true;
  return String(node.name).toLowerCase().includes(q);
}

function subtreeMatches(nodeId) {
  const n = state.nodesById.get(nodeId);
  if (!n) return false;
  if (matchesFilter(n)) return true;
  return n.children.some(subtreeMatches);
}

function renderTree() {
  if (!els.tree) return;
  if (!state.rootNodeId) {
    els.tree.innerHTML = '<div class="placeholder">Waiting for KML…</div>';
    return;
  }

  const total = computeTotals();
  if (els.treeSummary) {
    els.treeSummary.textContent = `${total.folders.toLocaleString()} folders • ${total.placemarks.toLocaleString()} placemarks`;
  }

  els.tree.innerHTML = renderNode(state.rootNodeId);
  wireTreeHandlers();

  // Apply checkbox state + indeterminate
  const inputs = els.tree.querySelectorAll('input[type="checkbox"][data-action="check"]');
  for (const inp of inputs) {
    const id = inp.getAttribute('data-node-id');
    const node = state.nodesById.get(id);
    if (!node) continue;
    inp.checked = Boolean(node.checked);
    inp.indeterminate = Boolean(node.indeterminate);
  }
}

function renderNode(nodeId) {
  const node = state.nodesById.get(nodeId);
  if (!node) return '';

  if (!subtreeMatches(nodeId)) return '';

  const hasChildren = node.children.length > 0;
  const expanded = Boolean(node.expanded);

  const visibleChildren = node.children.filter(subtreeMatches);
  const meta = node.tag === 'Placemark'
    ? '<span class="node-meta">Placemark</span>'
    : `<span class="node-meta">${visibleChildren.length} items</span>`;

  const twistyDisabled = !hasChildren || visibleChildren.length === 0;
  const twistyLabel = expanded ? '−' : '+';

  const name = escapeText(node.name);

  const childrenHtml = (hasChildren && expanded)
    ? `<div class="tree-children">${visibleChildren.map(renderNode).join('')}</div>`
    : '';

  return `
    <div class="tree-item" data-node-id="${node.id}">
      <button class="twisty" data-action="toggle" ${twistyDisabled ? 'disabled' : ''}>${twistyLabel}</button>
      <label class="node-name">
        <input type="checkbox" data-action="check" data-node-id="${node.id}" />
        <span>${name}</span>
      </label>
      ${meta}
    </div>
    ${childrenHtml}
  `;
}

function wireTreeHandlers() {
  els.tree.querySelectorAll('button.twisty[data-action="toggle"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('[data-node-id]');
      const id = wrap?.getAttribute('data-node-id');
      if (!id) return;
      const node = state.nodesById.get(id);
      if (!node || node.children.length === 0) return;
      node.expanded = !node.expanded;
      renderTree();
    });
  });

  els.tree.querySelectorAll('input[type="checkbox"][data-action="check"]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const id = inp.getAttribute('data-node-id');
      if (!id) return;
      const node = state.nodesById.get(id);
      if (!node) return;
      setCheckedRecursive(id, inp.checked);
      if (node.parentId) recomputeIndeterminateUp(node.parentId);
      renderTree();
      state.userHasInteracted = true;
      applyVisibilityFromTree();
    });
  });
}

// ---------- Load KML ----------

async function loadKml(file) {
  initCesium();

  setStatus('Reading KML…');
  const text = await file.text();

  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'text/xml');
  const err = xml.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('KML parse error. Ensure the file is valid XML/KML.');

  const root = findRootFeature(xml);
  if (!root) throw new Error('KML contains no Document or Folder root.');

  state.fileName = file.name;
  state.xml = xml;
  state.rootFeature = root;
  state.filterText = '';
  if (els.search) {
    els.search.value = '';
    els.search.disabled = false;
  }

  const { nodesById, rootNodeId } = buildTreeFromKml(root);
  state.nodesById = nodesById;
  state.rootNodeId = rootNodeId;

  for (const n of nodesById.values()) {
    if (n.tag !== 'Placemark') n.expanded = true;
  }

  if (els.kmlInfo) {
    const totals = computeTotals();
    els.kmlInfo.textContent = `${file.name} • ${totals.folders.toLocaleString()} folders • ${totals.placemarks.toLocaleString()} placemarks`;
  }

  setStatus('Loading into 3D viewer…');

  // Clear previous data
  if (kmlDataSource && viewer) {
    try { await viewer.dataSources.remove(kmlDataSource, true); } catch { /* ignore */ }
  }

  // Load KML into Cesium
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'application/vnd.google-earth.kml+xml' }));
  try {
    kmlDataSource = await Cesium.KmlDataSource.load(blobUrl, {
      camera: viewer.scene.camera,
      canvas: viewer.scene.canvas,
      // KML from Results Archive uses absolute altitudes; clamping can help visibility if alts are off.
      clampToGround: true,
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  viewer.dataSources.add(kmlDataSource);
  rebuildEntityIndex();
  rebuildPlacemarkToEntityMap();
  applyVisibilityFromTree();

  // Enable controls
  for (const b of [els.zoomTo, els.expandAll, els.collapseAll, els.checkAll, els.uncheckAll]) {
    if (b) b.disabled = false;
  }

  // Zoom (prefer flyTo for reliability)
  try {
    await viewer.flyTo(kmlDataSource);
  } catch {
    try { await viewer.zoomTo(kmlDataSource); } catch { /* ignore */ }
  }

  renderTree();
  setStatus('Ready. Use the Places tree to toggle layers.');
}

// ---------- UI wiring ----------

els.kmlInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await loadKml(file);
  } catch (err) {
    console.error(err);
    setStatus(`Load failed: ${err?.message ?? String(err)}`);
    if (els.tree) els.tree.innerHTML = '<div class="placeholder">Failed to load KML.</div>';
  }
});

els.zoomTo?.addEventListener('click', async () => {
  if (!viewer || !kmlDataSource) return;
  try { await viewer.zoomTo(kmlDataSource); } catch { /* ignore */ }
});

els.expandAll?.addEventListener('click', () => {
  if (!state.rootNodeId) return;
  setExpandedRecursive(state.rootNodeId, true);
  renderTree();
});

els.collapseAll?.addEventListener('click', () => {
  if (!state.rootNodeId) return;
  setExpandedRecursive(state.rootNodeId, false);
  const root = state.nodesById.get(state.rootNodeId);
  if (root) root.expanded = true;
  renderTree();
});

els.checkAll?.addEventListener('click', () => {
  if (!state.rootNodeId) return;
  setCheckedRecursive(state.rootNodeId, true);
  renderTree();
  state.userHasInteracted = true;
  applyVisibilityFromTree();
});

els.uncheckAll?.addEventListener('click', () => {
  if (!state.rootNodeId) return;
  setCheckedRecursive(state.rootNodeId, false);
  const root = state.nodesById.get(state.rootNodeId);
  if (root) root.checked = true, root.indeterminate = true;
  renderTree();
  state.userHasInteracted = true;
  applyVisibilityFromTree();
});

els.search?.addEventListener('input', () => {
  state.filterText = els.search.value || '';
  renderTree();
});

els.hideLabels?.addEventListener('change', () => {
  applyVisibilityFromTree();
});

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const swUrl = new URL('./service-worker.js', window.location.href);
      swUrl.searchParams.set('v', '6');
      const reg = await navigator.serviceWorker.register(swUrl.toString());
      // Proactively check for updates.
      await reg.update();

      // If an update takes over, reload to pick up new HTML/JS.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });
    } catch {
      // ignore
    }
  });
}

initCesium();
