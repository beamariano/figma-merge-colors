// Color Merger - Figma Plugin
// Scans all nodes for fill/stroke colors, groups similar ones, and replaces them

figma.showUI(__html__, { width: 480, height: 600, title: "Color Merger" });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toHex(r, g, b) {
  return [r, g, b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

function colorDistance(a, b) {
  // Simple Euclidean distance in RGB space (0–255 scale each)
  const dr = (a.r - b.r) * 255;
  const dg = (a.g - b.g) * 255;
  const db = (a.b - b.b) * 255;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

function getAllNodes() {
  return figma.currentPage.findAll();
}

function extractPaints(paints) {
  if (!paints || paints === figma.mixed) return [];
  return paints
    .filter((p) => p.type === "SOLID" && p.visible !== false)
    .map((p) => ({
      r: p.color.r,
      g: p.color.g,
      b: p.color.b,
      a: p.opacity ?? 1,
    }));
}

function scanColors() {
  const nodes = getAllNodes();
  // Map: hex -> { color, nodes: [{node, source: 'fill'|'stroke', index}] }
  const colorMap = {};

  for (const node of nodes) {
    // fills
    if ("fills" in node) {
      const paints = extractPaints(node.fills);
      paints.forEach((c, i) => {
        const hex = toHex(c.r, c.g, c.b);
        if (!colorMap[hex]) colorMap[hex] = { color: c, hex, nodes: [] };
        colorMap[hex].nodes.push({ nodeId: node.id, source: "fill", index: i });
      });
    }
    // strokes
    if ("strokes" in node) {
      const paints = extractPaints(node.strokes);
      paints.forEach((c, i) => {
        const hex = toHex(c.r, c.g, c.b);
        if (!colorMap[hex]) colorMap[hex] = { color: c, hex, nodes: [] };
        colorMap[hex].nodes.push({
          nodeId: node.id,
          source: "stroke",
          index: i,
        });
      });
    }
  }

  return colorMap;
}

function groupSimilarColors(colorMap, threshold) {
  const entries = Object.values(colorMap);
  const groups = []; // [{representative, hexes, totalCount}]
  const assigned = new Set();

  for (let i = 0; i < entries.length; i++) {
    if (assigned.has(entries[i].hex)) continue;
    const group = { representative: entries[i], members: [entries[i]] };
    assigned.add(entries[i].hex);

    for (let j = i + 1; j < entries.length; j++) {
      if (assigned.has(entries[j].hex)) continue;
      if (colorDistance(entries[i].color, entries[j].color) <= threshold) {
        group.members.push(entries[j]);
        assigned.add(entries[j].hex);
      }
    }
    groups.push(group);
  }

  // Sort by total node usage desc
  groups.sort((a, b) => {
    const countA = a.members.reduce((s, m) => s + m.nodes.length, 0);
    const countB = b.members.reduce((s, m) => s + m.nodes.length, 0);
    return countB - countA;
  });

  return groups;
}

// ─── Apply merge ──────────────────────────────────────────────────────────────

async function applyMerge(groups, targetHex) {
  const targetColor = hexToRgb(targetHex);
  let changed = 0;

  for (const group of groups) {
    // Collect all node refs across all members
    for (const member of group.members) {
      for (const ref of member.nodes) {
        const node = await figma.getNodeByIdAsync(ref.nodeId);
        if (!node) continue;

        try {
          if (
            ref.source === "fill" &&
            "fills" in node &&
            node.fills !== figma.mixed
          ) {
            const fills = JSON.parse(JSON.stringify(node.fills));
            if (fills[ref.index] && fills[ref.index].type === "SOLID") {
              fills[ref.index].color = targetColor;
              node.fills = fills;
              changed++;
            }
          } else if (
            ref.source === "stroke" &&
            "strokes" in node &&
            node.strokes !== figma.mixed
          ) {
            const strokes = JSON.parse(JSON.stringify(node.strokes));
            if (strokes[ref.index] && strokes[ref.index].type === "SOLID") {
              strokes[ref.index].color = targetColor;
              node.strokes = strokes;
              changed++;
            }
          }
        } catch (e) {
          // skip locked/component nodes
        }
      }
    }
  }

  return changed;
}

// ─── Message handling ─────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type === "scan") {
    try {
      const colorMap = scanColors();
      const threshold = msg.threshold ?? 20;
      const groups = groupSimilarColors(colorMap, threshold);

      const payload = groups.map((g) => ({
        representative: g.representative.hex,
        members: g.members.map((m) => ({
          hex: m.hex,
          count: m.nodes.length,
        })),
        totalCount: g.members.reduce((s, m) => s + m.nodes.length, 0),
      }));

      figma.ui.postMessage({ type: "scan-result", groups: payload, threshold });
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: `Scan failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  if (msg.type === "merge") {
    try {
      // msg.groups: array of group indices to merge, msg.targetHex: target color
      const colorMap = scanColors();
      const threshold = msg.threshold ?? 20;
      const allGroups = groupSimilarColors(colorMap, threshold);

      const selectedGroups = msg.groupIndices
        .map((i) => allGroups[i])
        .filter(Boolean);
      const changed = await applyMerge(selectedGroups, msg.targetHex);

      let styleCreated = false;
      if (msg.styleName) {
        const style = figma.createPaintStyle();
        style.name = msg.styleName;
        style.paints = [{ type: "SOLID", color: hexToRgb(msg.targetHex) }];
        styleCreated = true;
      }

      figma.ui.postMessage({ type: "merge-done", changed, styleCreated, styleName: msg.styleName });
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: `Merge failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  if (msg.type === "close") {
    figma.closePlugin();
  }
};
