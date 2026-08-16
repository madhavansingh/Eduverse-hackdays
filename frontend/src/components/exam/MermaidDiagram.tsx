/**
 * MermaidDiagram — Pure SVG renderer for simple Mermaid graph/flowchart syntax.
 * Supports: graph LR, graph TD, graph RL, graph BT
 * Edge types: -->, ---, -- "label" -->, -- "label" ---
 * No external library required.
 */

import { useMemo } from 'react';

interface Edge {
  from: string;
  to: string;
  label?: string;
  directed: boolean;
}

interface Node {
  id: string;
  label: string;
}

interface ParsedGraph {
  direction: 'LR' | 'TD' | 'RL' | 'BT';
  nodes: Node[];
  edges: Edge[];
}

function parseMermaidGraph(code: string): ParsedGraph | null {
  const lines = code.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const header = lines[0].toUpperCase();
  let direction: ParsedGraph['direction'] = 'LR';
  if (header.includes('TD') || header.includes('TB')) direction = 'TD';
  else if (header.includes('RL')) direction = 'RL';
  else if (header.includes('BT')) direction = 'BT';

  const nodeMap = new Map<string, string>(); // id -> label
  const edges: Edge[] = [];

  // Regex patterns
  // Edge: A -- "label" --> B  or  A --> B  or  A --- B  or  A -- "label" --- B
  const edgeRe = /^(\w+)\s*(?:--\s*"([^"]+)"\s*)?(-->|---)\s*(\w+)$/;
  // Node with label: A[label text]  A(label)  A{label}
  const nodeLabelRe = /^(\w+)\s*[([{]([^)\]{}]+)[)\]{}]/;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Try node with label first
    const nlMatch = line.match(nodeLabelRe);
    if (nlMatch) {
      nodeMap.set(nlMatch[1], nlMatch[2]);
      continue;
    }

    // Try edge pattern
    const eMatch = line.match(edgeRe);
    if (eMatch) {
      const [, from, label, arrow, to] = eMatch;
      if (!nodeMap.has(from)) nodeMap.set(from, from);
      if (!nodeMap.has(to)) nodeMap.set(to, to);
      edges.push({
        from,
        to,
        label: label?.trim() || undefined,
        directed: arrow === '-->',
      });
    }
  }

  // Ensure all edge endpoints are in nodeMap
  edges.forEach((e) => {
    if (!nodeMap.has(e.from)) nodeMap.set(e.from, e.from);
    if (!nodeMap.has(e.to)) nodeMap.set(e.to, e.to);
  });

  if (nodeMap.size === 0) return null;

  const nodes: Node[] = Array.from(nodeMap.entries()).map(([id, label]) => ({ id, label }));
  return { direction, nodes, edges };
}

function layoutGraph(
  graph: ParsedGraph,
  svgWidth: number,
  svgHeight: number,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const { nodes, edges, direction } = graph;
  const n = nodes.length;

  if (n === 0) return positions;

  // Build adjacency for topological ordering
  const outEdges = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  nodes.forEach((node) => {
    outEdges.set(node.id, []);
    inDegree.set(node.id, 0);
  });
  edges.forEach((e) => {
    outEdges.get(e.from)?.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
  });

  // Kahn's topological sort into layers
  const layers: string[][] = [];
  const visited = new Set<string>();
  let queue = nodes.filter((nd) => (inDegree.get(nd.id) || 0) === 0).map((nd) => nd.id);

  while (queue.length > 0) {
    layers.push([...queue]);
    queue.forEach((id) => visited.add(id));
    const next: string[] = [];
    queue.forEach((id) => {
      (outEdges.get(id) || []).forEach((to) => {
        if (!visited.has(to)) {
          const deg = (inDegree.get(to) || 1) - 1;
          inDegree.set(to, deg);
          if (deg === 0) next.push(to);
        }
      });
    });
    queue = next;
  }

  // Nodes not visited (cycles) go into last layer
  const unvisited = nodes.filter((nd) => !visited.has(nd.id)).map((nd) => nd.id);
  if (unvisited.length > 0) layers.push(unvisited);

  const isHorizontal = direction === 'LR' || direction === 'RL';
  const padding = 60;

  const totalLayers = layers.length;

  layers.forEach((layer, li) => {
    const layerCount = layer.length;
    layer.forEach((id, ni) => {
      let x: number, y: number;
      if (isHorizontal) {
        x = padding + (li / Math.max(totalLayers - 1, 1)) * (svgWidth - padding * 2);
        y = padding + (ni / Math.max(layerCount - 1, 1)) * (svgHeight - padding * 2);
        if (layerCount === 1) y = svgHeight / 2;
      } else {
        x = padding + (ni / Math.max(layerCount - 1, 1)) * (svgWidth - padding * 2);
        y = padding + (li / Math.max(totalLayers - 1, 1)) * (svgHeight - padding * 2);
        if (layerCount === 1) x = svgWidth / 2;
      }
      positions.set(id, { x, y });
    });
  });

  return positions;
}

interface MermaidDiagramProps {
  code: string;
  className?: string;
}

const NODE_RADIUS = 22;
const COLORS = {
  nodeFill: 'hsl(265, 70%, 55%)',
  nodeFillLight: 'hsl(265, 70%, 65%)',
  nodeStroke: 'hsl(265, 60%, 40%)',
  nodeText: '#ffffff',
  edgeStroke: 'hsl(215, 30%, 50%)',
  labelBg: 'hsla(0,0%,100%,0.85)',
  labelText: 'hsl(215, 30%, 20%)',
};

export function MermaidDiagram({ code, className }: MermaidDiagramProps) {
  const graph = useMemo(() => parseMermaidGraph(code), [code]);

  if (!graph || graph.nodes.length === 0) {
    return (
      <pre className="text-xs bg-muted p-3 rounded font-mono overflow-x-auto">
        {code}
      </pre>
    );
  }

  const svgWidth = 520;
  const svgHeight = graph.nodes.length <= 3 ? 160 : graph.nodes.length <= 6 ? 220 : 300;
  const positions = layoutGraph(graph, svgWidth, svgHeight);

  return (
    <div className={`my-3 flex justify-center ${className ?? ''}`}>
      <svg
        width="100%"
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="max-w-[520px] rounded-xl border border-border bg-muted/30 p-2"
        aria-label="Graph diagram"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill={COLORS.edgeStroke} />
          </marker>
        </defs>

        {/* Edges */}
        {graph.edges.map((edge, i) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;

          // Shorten line to node radius boundary
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = dx / dist;
          const ny = dy / dist;

          const x1 = from.x + nx * NODE_RADIUS;
          const y1 = from.y + ny * NODE_RADIUS;
          const x2 = to.x - nx * (NODE_RADIUS + (edge.directed ? 10 : 0));
          const y2 = to.y - ny * (NODE_RADIUS + (edge.directed ? 10 : 0));

          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;

          return (
            <g key={`edge-${i}`}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={COLORS.edgeStroke}
                strokeWidth={1.8}
                markerEnd={edge.directed ? 'url(#arrowhead)' : undefined}
              />
              {edge.label && (
                <>
                  <rect
                    x={mx - edge.label.length * 3.5}
                    y={my - 9}
                    width={edge.label.length * 7}
                    height={18}
                    rx={4}
                    fill={COLORS.labelBg}
                    stroke={COLORS.edgeStroke}
                    strokeWidth={0.5}
                  />
                  <text
                    x={mx}
                    y={my + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fill={COLORS.labelText}
                    fontWeight="600"
                    fontFamily="monospace"
                  >
                    {edge.label}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {graph.nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          return (
            <g key={`node-${node.id}`}>
              <circle
                cx={pos.x}
                cy={pos.y}
                r={NODE_RADIUS}
                fill={COLORS.nodeFill}
                stroke={COLORS.nodeStroke}
                strokeWidth={2}
              />
              <text
                x={pos.x}
                y={pos.y + 4}
                textAnchor="middle"
                fontSize={12}
                fontWeight="700"
                fill={COLORS.nodeText}
                fontFamily="system-ui, sans-serif"
              >
                {node.label.length > 4 ? node.label.slice(0, 4) : node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
