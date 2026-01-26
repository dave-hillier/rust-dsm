import type { DependencyGraph, DsmData, DsmNode, SparseCell, Cycle } from '../types/graph.js';
import type { MetricsReport, NodeMetrics } from '../types/metrics.js';
import { getNodesInCycles } from '../analysis/cycle-detector.js';

export function buildDsmData(
  graph: DependencyGraph,
  metrics: MetricsReport,
  cycles: Cycle[]
): DsmData {
  const builder = new DsmBuilder(graph, metrics, cycles);
  return builder.build();
}

class DsmBuilder {
  private nodesInCycles: Set<string>;

  constructor(
    private graph: DependencyGraph,
    private metrics: MetricsReport,
    private cycles: Cycle[]
  ) {
    this.nodesInCycles = getNodesInCycles(cycles);
  }

  build(): DsmData {
    const nodes = this.buildNodes();
    const nodeIndexMap = new Map(nodes.map((n, i) => [n.id, i]));
    const matrix = this.buildMatrix(nodes, nodeIndexMap);
    const hierarchy = this.buildHierarchy(nodes);

    return {
      nodes,
      matrix,
      hierarchy,
      cycles: this.cycles,
      nodeIndexMap,
    };
  }

  private buildNodes(): DsmNode[] {
    const nodes: DsmNode[] = [];
    const sortedIds = this.getSortedNodeIds();

    for (const id of sortedIds) {
      const node = this.graph.nodes.get(id)!;
      const depth = this.calculateDepth(id);

      nodes.push({
        id: node.id,
        name: node.name,
        path: node.path,
        depth,
        parentId: node.parentId,
        kind: node.kind,
        isExpanded: true,
        childIds: node.children,
      });
    }

    return nodes;
  }

  private getSortedNodeIds(): string[] {
    const moduleNodes: string[] = [];
    const typeNodes: string[] = [];
    const functionNodes: string[] = [];

    for (const [id, node] of this.graph.nodes) {
      if (node.kind === 'module') {
        moduleNodes.push(id);
      } else if (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'trait') {
        typeNodes.push(id);
      } else {
        functionNodes.push(id);
      }
    }

    const sortByPath = (a: string, b: string) => a.localeCompare(b);
    moduleNodes.sort(sortByPath);
    typeNodes.sort(sortByPath);
    functionNodes.sort(sortByPath);

    return [...moduleNodes, ...typeNodes, ...functionNodes];
  }

  private calculateDepth(nodeId: string): number {
    let depth = 0;
    let current = this.graph.nodes.get(nodeId);

    while (current?.parentId) {
      depth++;
      current = this.graph.nodes.get(current.parentId);
    }

    return depth;
  }

  private buildMatrix(nodes: DsmNode[], nodeIndexMap: Map<string, number>): SparseCell[] {
    const cells: SparseCell[] = [];
    const cellMap = new Map<string, SparseCell>();

    for (const edge of this.graph.edges) {
      const fromIndex = nodeIndexMap.get(edge.from);
      const toIndex = nodeIndexMap.get(edge.to);

      if (fromIndex === undefined || toIndex === undefined) continue;

      const key = `${fromIndex},${toIndex}`;

      if (cellMap.has(key)) {
        const cell = cellMap.get(key)!;
        cell.value += edge.count;
        if (!cell.depTypes.includes(edge.depType)) {
          cell.depTypes.push(edge.depType);
        }
        cell.edges.push(edge);
      } else {
        const cell: SparseCell = {
          row: fromIndex,
          col: toIndex,
          value: edge.count,
          depTypes: [edge.depType],
          edges: [edge],
        };
        cellMap.set(key, cell);
        cells.push(cell);
      }
    }

    return cells;
  }

  private buildHierarchy(nodes: DsmNode[]): import('../types/graph.js').HierarchyGroup[] {
    const groups: import('../types/graph.js').HierarchyGroup[] = [];

    for (const node of nodes) {
      if (node.kind === 'module') {
        groups.push({
          id: node.id,
          name: node.name,
          parentId: node.parentId,
          childIds: node.childIds,
          depth: node.depth,
        });
      }
    }

    return groups;
  }
}

export function generateDsmClientCode(): string {
  return `
// DSM Matrix Visualization
class DsmMatrix {
  constructor(container, data, metrics) {
    this.container = container;
    this.data = data;
    this.metrics = metrics;
    this.cellSize = 20;
    this.headerHeight = 150;
    this.labelWidth = 200;
    this.selectedNode = null;
    this.collapsedGroups = new Set();
    this.hiddenNodes = new Set();
    this.hiddenCrates = new Set();
    this.hiddenKinds = new Set();
    this.sortBy = 'path';
    this.eventBus = window.eventBus;

    // Build lookup maps for performance
    this.nodeMap = new Map(this.data.nodes.map(n => [n.id, n]));
    this.crateIdCache = new Map();
    this.data.nodes.forEach(n => {
      this.crateIdCache.set(n.id, this.computeCrateId(n));
    });

    // Start collapsed to top level (crate level) by default
    this.initCollapsedState();

    this.init();
  }

  computeCrateId(node) {
    if (!node.parentId) return node.id;
    let current = node;
    while (current.parentId) {
      const parent = this.nodeMap.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  initCollapsedState() {
    // Collapse all modules at depth 0 (crate level) so only crates show initially
    this.data.nodes.forEach(node => {
      if (node.kind === 'module' && node.depth === 0 && node.childIds && node.childIds.length > 0) {
        this.collapsedGroups.add(node.id);
      }
    });
  }

  init() {
    this.svg = d3.select(this.container)
      .append('svg')
      .attr('class', 'dsm-svg');

    this.g = this.svg.append('g');

    this.zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
      });

    this.svg.call(this.zoom);

    this.tooltip = d3.select('body')
      .append('div')
      .attr('class', 'dsm-tooltip')
      .style('opacity', 0);

    this.render();
    this.setupEventListeners();
  }

  render() {
    this.g.selectAll('*').remove();

    const visibleNodes = this.getVisibleNodes();
    const n = visibleNodes.length;
    this.matrixWidth = this.labelWidth + n * this.cellSize + 50;
    this.matrixHeight = this.headerHeight + n * this.cellSize + 50;

    this.svg.attr('width', this.matrixWidth).attr('height', this.matrixHeight);

    const matrixG = this.g.append('g')
      .attr('transform', \`translate(\${this.labelWidth}, \${this.headerHeight})\`);

    this.renderGroupBands(visibleNodes);
    this.renderRowLabels(visibleNodes);
    this.renderColumnHeaders(visibleNodes);
    this.renderCells(matrixG, visibleNodes);
    this.renderDiagonal(matrixG, visibleNodes);
    this.renderCycleHighlights(matrixG, visibleNodes);
  }

  getGroupColor(index) {
    // Alternating pastel colors for group bands
    const colors = [
      '#fff9c4', // yellow
      '#ffecb3', // amber
      '#ffe0b2', // orange
      '#ffccbc', // deep orange
      '#f8bbd9', // pink
      '#e1bee7', // purple
      '#d1c4e9', // deep purple
      '#c5cae9', // indigo
      '#bbdefb', // blue
      '#b2ebf2', // cyan
      '#b2dfdb', // teal
      '#c8e6c9', // green
    ];
    return colors[index % colors.length];
  }

  renderGroupBands(nodes) {
    // Find top-level groups (depth 0 modules)
    const groups = [];
    let currentGroup = null;
    let startIndex = 0;

    nodes.forEach((node, i) => {
      const topParent = this.getTopLevelParent(node);
      if (topParent !== currentGroup) {
        if (currentGroup !== null) {
          groups.push({ id: currentGroup, start: startIndex, end: i - 1 });
        }
        currentGroup = topParent;
        startIndex = i;
      }
    });
    if (currentGroup !== null) {
      groups.push({ id: currentGroup, start: startIndex, end: nodes.length - 1 });
    }

    // Render horizontal bands for rows
    const bandG = this.g.append('g').attr('class', 'group-bands');

    groups.forEach((group, gi) => {
      const color = this.getGroupColor(gi);
      const y = this.headerHeight + group.start * this.cellSize;
      const height = (group.end - group.start + 1) * this.cellSize;

      // Row band
      bandG.append('rect')
        .attr('x', 0)
        .attr('y', y)
        .attr('width', this.matrixWidth)
        .attr('height', height)
        .attr('fill', color)
        .attr('opacity', 0.3);

      // Column band
      bandG.append('rect')
        .attr('x', this.labelWidth + group.start * this.cellSize)
        .attr('y', 0)
        .attr('width', (group.end - group.start + 1) * this.cellSize)
        .attr('height', this.matrixHeight)
        .attr('fill', color)
        .attr('opacity', 0.3);
    });
  }

  getTopLevelParent(node) {
    if (node.depth === 0) return node.id;
    let current = node;
    while (current.parentId) {
      const parent = this.nodeMap.get(current.parentId);
      if (!parent || parent.depth === 0) return current.parentId || current.id;
      current = parent;
    }
    return current.id;
  }

  getVisibleNodes() {
    let nodes = this.data.nodes.filter(n =>
      !this.hiddenNodes.has(n.id) && !this.hiddenKinds.has(n.kind)
    );

    // Filter out nodes belonging to hidden crates
    if (this.hiddenCrates.size > 0) {
      nodes = nodes.filter(n => {
        const crateId = this.getCrateId(n);
        return !this.hiddenCrates.has(crateId);
      });
    }

    // Filter out children of collapsed groups
    for (const groupId of this.collapsedGroups) {
      nodes = nodes.filter(n => !this.isDescendantOf(n.id, groupId));
    }

    return this.sortNodes(nodes);
  }

  getCrateId(node) {
    return this.crateIdCache.get(node.id) || node.id;
  }

  isDescendantOf(nodeId, ancestorId) {
    let current = this.nodeMap.get(nodeId);
    while (current && current.parentId) {
      if (current.parentId === ancestorId) return true;
      current = this.nodeMap.get(current.parentId);
    }
    return false;
  }

  sortNodes(nodes) {
    // Build a hierarchical sort that keeps children immediately after parents
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const result = [];
    const visited = new Set();

    // Get comparison function based on sort mode
    const compare = (a, b) => {
      switch (this.sortBy) {
        case 'instability': {
          const ma = this.metrics.get(a.id);
          const mb = this.metrics.get(b.id);
          return (mb?.instability ?? 0) - (ma?.instability ?? 0);
        }
        case 'coupling': {
          const ma = this.metrics.get(a.id);
          const mb = this.metrics.get(b.id);
          const ca = (ma?.afferentCoupling ?? 0) + (ma?.efferentCoupling ?? 0);
          const cb = (mb?.afferentCoupling ?? 0) + (mb?.efferentCoupling ?? 0);
          return cb - ca;
        }
        default:
          return a.name.localeCompare(b.name);
      }
    };

    // Recursively add node and its visible children
    const addNodeWithChildren = (node) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      result.push(node);

      // Find and sort children that are in our visible set
      const children = nodes.filter(n => n.parentId === node.id);
      children.sort(compare);
      children.forEach(child => addNodeWithChildren(child));
    };

    // Start with root nodes (no parent or parent not in visible set)
    const roots = nodes.filter(n => !n.parentId || !nodeMap.has(n.parentId));
    roots.sort(compare);
    roots.forEach(root => addNodeWithChildren(root));

    return result;
  }

  renderRowLabels(nodes) {
    const rowLabels = this.g.append('g')
      .attr('class', 'row-labels')
      .attr('transform', \`translate(0, \${this.headerHeight})\`);

    const indentSize = 12;
    const expanderWidth = 16;

    // Create row groups
    const rowGroups = rowLabels.selectAll('g.row-label-group')
      .data(nodes)
      .enter()
      .append('g')
      .attr('class', 'row-label-group')
      .attr('transform', (d, i) => \`translate(0, \${i * this.cellSize})\`);

    // Row index number
    rowGroups.append('text')
      .attr('x', 18)
      .attr('y', this.cellSize / 2)
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', '9px')
      .attr('fill', '#999')
      .text((d, i) => i);

    // Expand/collapse indicator (tree-style box with +/-)
    rowGroups.filter(d => d.kind === 'module' && d.childIds && d.childIds.length > 0)
      .append('rect')
      .attr('class', 'expander-box')
      .attr('x', d => 22 + d.depth * indentSize)
      .attr('y', (this.cellSize - 10) / 2)
      .attr('width', 10)
      .attr('height', 10)
      .attr('fill', 'white')
      .attr('stroke', '#999')
      .attr('stroke-width', 1)
      .attr('cursor', 'pointer')
      .on('click', (event, d) => {
        event.stopPropagation();
        if (this.collapsedGroups.has(d.id)) {
          this.eventBus.emit('group:expand', { groupId: d.id });
        } else {
          this.eventBus.emit('group:collapse', { groupId: d.id });
        }
      });

    rowGroups.filter(d => d.kind === 'module' && d.childIds && d.childIds.length > 0)
      .append('text')
      .attr('class', 'expander-text')
      .attr('x', d => 27 + d.depth * indentSize)
      .attr('y', this.cellSize / 2)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', '10px')
      .attr('font-weight', 'bold')
      .attr('fill', '#666')
      .attr('cursor', 'pointer')
      .attr('pointer-events', 'none')
      .text(d => this.collapsedGroups.has(d.id) ? '+' : '-');

    // Tree lines (optional visual connector)
    rowGroups.filter(d => d.depth > 0)
      .append('line')
      .attr('x1', d => 22 + (d.depth - 1) * indentSize + 5)
      .attr('y1', 0)
      .attr('x2', d => 22 + (d.depth - 1) * indentSize + 5)
      .attr('y2', this.cellSize / 2)
      .attr('stroke', '#ccc')
      .attr('stroke-width', 1);

    rowGroups.filter(d => d.depth > 0)
      .append('line')
      .attr('x1', d => 22 + (d.depth - 1) * indentSize + 5)
      .attr('y1', this.cellSize / 2)
      .attr('x2', d => 22 + d.depth * indentSize)
      .attr('y2', this.cellSize / 2)
      .attr('stroke', '#ccc')
      .attr('stroke-width', 1);

    // Node type icon/indicator
    const iconOffset = 35;
    rowGroups.append('text')
      .attr('x', d => iconOffset + d.depth * indentSize + (d.kind === 'module' && d.childIds?.length > 0 ? 12 : 0))
      .attr('y', this.cellSize / 2)
      .attr('dominant-baseline', 'middle')
      .attr('font-size', '9px')
      .attr('fill', d => this.getKindColor(d.kind))
      .text(d => this.getKindIcon(d.kind));

    // Node name
    rowGroups.append('text')
      .attr('x', d => iconOffset + 14 + d.depth * indentSize + (d.kind === 'module' && d.childIds?.length > 0 ? 12 : 0))
      .attr('y', this.cellSize / 2)
      .attr('dominant-baseline', 'middle')
      .attr('class', d => \`label \${d.kind} \${this.isInCycle(d.id) ? 'in-cycle' : ''}\`)
      .attr('font-size', '11px')
      .text(d => this.truncateLabel(d.name, 22 - d.depth))
      .on('click', (event, d) => this.onNodeClick(d))
      .on('mouseover', (event, d) => this.showTooltip(event, d))
      .on('mouseout', () => this.hideTooltip())
      .on('contextmenu', (event, d) => this.showContextMenu(event, d));
  }

  getKindIcon(kind) {
    const icons = {
      module: 'M',
      struct: 'S',
      enum: 'E',
      trait: 'T',
      function: 'f',
    };
    return icons[kind] || '?';
  }

  getKindColor(kind) {
    const colors = {
      module: '#1976d2',
      struct: '#388e3c',
      enum: '#7b1fa2',
      trait: '#f57c00',
      function: '#d32f2f',
    };
    return colors[kind] || '#666';
  }

  renderColumnHeaders(nodes) {
    const colHeaders = this.g.append('g')
      .attr('class', 'col-headers')
      .attr('transform', \`translate(\${this.labelWidth}, \${this.headerHeight})\`);

    // Simple numbered column headers matching row indices
    colHeaders.selectAll('text')
      .data(nodes)
      .enter()
      .append('text')
      .attr('x', (d, i) => i * this.cellSize + this.cellSize / 2)
      .attr('y', -5)
      .attr('text-anchor', 'middle')
      .attr('font-size', '9px')
      .attr('fill', '#666')
      .text((d, i) => i)
      .on('mouseover', (event, d) => this.showTooltip(event, d))
      .on('mouseout', () => this.hideTooltip());
  }

  renderCells(g, nodes) {
    const nodeIndexMap = new Map(nodes.map((n, i) => [n.id, i]));
    const visibleIds = new Set(nodes.map(n => n.id));

    // Aggregate cells to visible ancestors
    const aggregatedCells = new Map();

    for (const cell of this.data.matrix) {
      const fromNode = this.data.nodes[cell.row];
      const toNode = this.data.nodes[cell.col];
      if (!fromNode || !toNode) continue;

      // Find visible ancestor for each node
      const visibleFrom = this.findVisibleAncestor(fromNode.id, visibleIds);
      const visibleTo = this.findVisibleAncestor(toNode.id, visibleIds);

      if (visibleFrom && visibleTo && visibleFrom !== visibleTo) {
        const key = \`\${visibleFrom}|\${visibleTo}\`;
        if (aggregatedCells.has(key)) {
          const existing = aggregatedCells.get(key);
          existing.value += cell.value;
          existing.edges.push(...cell.edges);
        } else {
          aggregatedCells.set(key, {
            fromId: visibleFrom,
            toId: visibleTo,
            value: cell.value,
            depTypes: [...cell.depTypes],
            edges: [...cell.edges]
          });
        }
      }
    }

    const visibleCells = Array.from(aggregatedCells.values());
    const maxValue = Math.max(...visibleCells.map(c => c.value), 1);

    // NDepend-style colors: green for upper triangle (uses), blue for lower triangle (is used by)
    const greenScale = d3.scaleSequential()
      .domain([0, Math.log(maxValue + 1)])
      .interpolator(t => d3.interpolateGreens(0.3 + t * 0.7));
    const blueScale = d3.scaleSequential()
      .domain([0, Math.log(maxValue + 1)])
      .interpolator(t => d3.interpolateBlues(0.3 + t * 0.7));

    // Background grid
    g.selectAll('.grid-row')
      .data(nodes)
      .enter()
      .append('line')
      .attr('class', 'grid-row')
      .attr('x1', 0)
      .attr('y1', (d, i) => i * this.cellSize)
      .attr('x2', nodes.length * this.cellSize)
      .attr('y2', (d, i) => i * this.cellSize)
      .attr('stroke', '#eee');

    g.selectAll('.grid-col')
      .data(nodes)
      .enter()
      .append('line')
      .attr('class', 'grid-col')
      .attr('x1', (d, i) => i * this.cellSize)
      .attr('y1', 0)
      .attr('x2', (d, i) => i * this.cellSize)
      .attr('y2', nodes.length * this.cellSize)
      .attr('stroke', '#eee');

    // Cells - NDepend style: green for upper triangle (row uses col), blue for lower (row is used by col)
    for (const cell of visibleCells) {
      const row = nodeIndexMap.get(cell.fromId);
      const col = nodeIndexMap.get(cell.toId);

      if (row === undefined || col === undefined) continue;

      // Upper triangle (col > row): green - "row uses col"
      // Lower triangle (row > col): blue - "row is used by col"
      const isUpperTriangle = col > row;
      const colorScale = isUpperTriangle ? greenScale : blueScale;
      const strokeColor = isUpperTriangle ? '#2e7d32' : '#1565c0';

      const cellG = g.append('g')
        .attr('class', 'cell-group')
        .attr('data-from', cell.fromId)
        .attr('data-to', cell.toId)
        .on('mouseover', (event) => this.showAggregatedCellTooltip(event, cell, isUpperTriangle))
        .on('mouseout', () => this.hideTooltip())
        .on('click', () => this.onAggregatedCellClick(cell));

      cellG.append('rect')
        .attr('class', 'cell')
        .attr('x', col * this.cellSize + 1)
        .attr('y', row * this.cellSize + 1)
        .attr('width', this.cellSize - 2)
        .attr('height', this.cellSize - 2)
        .attr('fill', colorScale(Math.log(cell.value + 1)))
        .attr('stroke', strokeColor)
        .attr('stroke-width', 0.5);

      // Show count in cell
      const countText = cell.value > 999 ? Math.round(cell.value / 1000) + 'k' : cell.value.toString();
      cellG.append('text')
        .attr('x', col * this.cellSize + this.cellSize / 2)
        .attr('y', row * this.cellSize + this.cellSize / 2)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('font-size', cell.value > 99 ? '7px' : '9px')
        .attr('font-weight', 'bold')
        .attr('fill', cell.value > 5 ? '#fff' : '#333')
        .attr('pointer-events', 'none')
        .text(countText);
    }
  }

  findVisibleAncestor(nodeId, visibleIds) {
    if (visibleIds.has(nodeId)) return nodeId;
    const node = this.nodeMap.get(nodeId);
    if (!node || !node.parentId) return null;
    return this.findVisibleAncestor(node.parentId, visibleIds);
  }

  showAggregatedCellTooltip(event, cell, isUpperTriangle = true) {
    const fromNode = this.nodeMap.get(cell.fromId);
    const toNode = this.nodeMap.get(cell.toId);

    // Upper triangle (green): fromNode uses toNode
    // Lower triangle (blue): fromNode is used by toNode
    let html;
    if (isUpperTriangle) {
      html = \`<strong>\${fromNode?.name || cell.fromId}</strong> uses <strong>\${toNode?.name || cell.toId}</strong><br>\`;
    } else {
      html = \`<strong>\${fromNode?.name || cell.fromId}</strong> is used by <strong>\${toNode?.name || cell.toId}</strong><br>\`;
    }
    html += \`Dependencies: \${cell.value}<br>\`;
    html += \`Types: \${[...new Set(cell.depTypes)].join(', ')}\`;

    this.tooltip
      .html(html)
      .style('left', (event.pageX + 10) + 'px')
      .style('top', (event.pageY - 10) + 'px')
      .style('opacity', 1);
  }

  onAggregatedCellClick(cell) {
    this.eventBus.emit('edge:selected', {
      from: cell.fromId,
      to: cell.toId,
      cell
    });
  }

  renderDiagonal(g, nodes) {
    const n = nodes.length;
    const matrixSize = n * this.cellSize;

    // Draw diagonal line through the matrix (NDepend style)
    g.append('line')
      .attr('class', 'diagonal-line')
      .attr('x1', 0)
      .attr('y1', 0)
      .attr('x2', matrixSize)
      .attr('y2', matrixSize)
      .attr('stroke', '#999')
      .attr('stroke-width', 1);

    // Add subtle diagonal cell backgrounds
    g.selectAll('.diagonal-cell')
      .data(nodes)
      .enter()
      .append('rect')
      .attr('class', 'diagonal-cell')
      .attr('x', (d, i) => i * this.cellSize)
      .attr('y', (d, i) => i * this.cellSize)
      .attr('width', this.cellSize)
      .attr('height', this.cellSize)
      .attr('fill', '#f5f5f5')
      .attr('stroke', '#e0e0e0')
      .attr('stroke-width', 0.5);
  }

  renderCycleHighlights(g, nodes) {
    const nodeIndexMap = new Map(nodes.map((n, i) => [n.id, i]));
    const visibleIds = new Set(nodes.map(n => n.id));

    for (const cycle of this.data.cycles) {
      // Map cycle nodes to their visible ancestors
      const visibleCycleNodes = new Set();
      for (const nodeId of cycle.nodes) {
        const visibleAncestor = this.findVisibleAncestor(nodeId, visibleIds);
        if (visibleAncestor) {
          visibleCycleNodes.add(visibleAncestor);
        }
      }

      const cycleNodeIndices = Array.from(visibleCycleNodes)
        .map(id => nodeIndexMap.get(id))
        .filter(i => i !== undefined);

      if (cycleNodeIndices.length < 2) continue;

      const minIdx = Math.min(...cycleNodeIndices);
      const maxIdx = Math.max(...cycleNodeIndices);

      g.append('rect')
        .attr('class', 'cycle-highlight')
        .attr('x', minIdx * this.cellSize - 2)
        .attr('y', minIdx * this.cellSize - 2)
        .attr('width', (maxIdx - minIdx + 1) * this.cellSize + 4)
        .attr('height', (maxIdx - minIdx + 1) * this.cellSize + 4)
        .attr('fill', 'none')
        .attr('stroke', '#e74c3c')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '4,2');
    }
  }

  isInCycle(nodeId) {
    return this.data.cycles.some(c => c.nodes.includes(nodeId));
  }

  truncateLabel(text, maxLen) {
    return text.length > maxLen ? text.slice(0, maxLen - 2) + '..' : text;
  }

  showTooltip(event, node) {
    const metrics = this.metrics.get(node.id);
    let html = \`<strong>\${node.name}</strong><br>\`;
    html += \`<span class="kind">\${node.kind}</span><br>\`;
    html += \`Path: \${node.path}<br>\`;

    if (metrics) {
      html += \`<hr>\`;
      html += \`Ca: \${metrics.afferentCoupling}<br>\`;
      html += \`Ce: \${metrics.efferentCoupling}<br>\`;
      html += \`I: \${metrics.instability.toFixed(2)}<br>\`;
      if (metrics.inCycle) {
        html += \`<span class="warning">In cycle</span>\`;
      }
    }

    this.tooltip
      .html(html)
      .style('left', (event.pageX + 10) + 'px')
      .style('top', (event.pageY - 10) + 'px')
      .style('opacity', 1);
  }

  showCellTooltip(event, cell, fromNode, toNode) {
    let html = \`<strong>\${fromNode.name}</strong> → <strong>\${toNode.name}</strong><br>\`;
    html += \`Dependencies: \${cell.value}<br>\`;
    html += \`Types: \${cell.depTypes.join(', ')}\`;

    this.tooltip
      .html(html)
      .style('left', (event.pageX + 10) + 'px')
      .style('top', (event.pageY - 10) + 'px')
      .style('opacity', 1);
  }

  hideTooltip() {
    this.tooltip.style('opacity', 0);
  }

  onNodeClick(node) {
    this.selectedNode = node.id;
    this.eventBus.emit('node:selected', { nodeId: node.id, source: 'dsm' });
    this.highlightNode(node.id);
  }

  onCellClick(cell, fromNode, toNode) {
    this.eventBus.emit('edge:selected', {
      from: fromNode.id,
      to: toNode.id,
      cell
    });
  }

  highlightNode(nodeId) {
    this.g.selectAll('.label')
      .classed('selected', d => d.id === nodeId);

    this.g.selectAll('.cell-group')
      .classed('highlighted', function() {
        return this.dataset.from === nodeId || this.dataset.to === nodeId;
      });

    this.g.selectAll('.cell-group.highlighted .cell')
      .attr('stroke', '#f39c12')
      .attr('stroke-width', 2);

    this.g.selectAll('.cell-group:not(.highlighted) .cell')
      .attr('stroke', '#1565c0')
      .attr('stroke-width', 0.5);
  }

  showContextMenu(event, node) {
    event.preventDefault();
    this.eventBus.emit('contextmenu:show', {
      x: event.pageX,
      y: event.pageY,
      node,
      source: 'dsm'
    });
  }

  zoomIn() {
    this.svg.transition().duration(300).call(this.zoom.scaleBy, 1.5);
  }

  zoomOut() {
    this.svg.transition().duration(300).call(this.zoom.scaleBy, 0.67);
  }

  fitToView() {
    if (!this.matrixWidth || !this.matrixHeight) return;

    const bounds = this.g.node().getBBox();
    if (bounds.width === 0 || bounds.height === 0) return;

    const containerWidth = parseInt(this.svg.style('width')) || this.matrixWidth;
    const containerHeight = parseInt(this.svg.style('height')) || this.matrixHeight;

    const scale = 0.9 / Math.max(bounds.width / containerWidth, bounds.height / containerHeight);
    const midX = bounds.x + bounds.width / 2;
    const midY = bounds.y + bounds.height / 2;
    const transform = d3.zoomIdentity
      .translate(containerWidth / 2 - scale * midX, containerHeight / 2 - scale * midY)
      .scale(scale);
    this.svg.transition().duration(500).call(this.zoom.transform, transform);
  }

  collapseAll() {
    const moduleNodes = this.data.nodes.filter(n => n.kind === 'module');
    moduleNodes.forEach(n => this.collapsedGroups.add(n.id));
    this.render();
  }

  expandAll() {
    this.collapsedGroups.clear();
    this.render();
  }

  collapseToLevel(level) {
    this.collapsedGroups.clear();
    const moduleNodes = this.data.nodes.filter(n => n.kind === 'module');
    moduleNodes.forEach(n => {
      if (n.depth >= level) {
        this.collapsedGroups.add(n.id);
      }
    });
    this.render();
  }

  setupEventListeners() {
    this.eventBus.on('node:selected', ({ nodeId, source }) => {
      if (source !== 'dsm') {
        this.highlightNode(nodeId);
      }
    });

    this.eventBus.on('node:hide', ({ nodeId }) => {
      this.hiddenNodes.add(nodeId);
      this.render();
    });

    this.eventBus.on('node:show', ({ nodeId }) => {
      this.hiddenNodes.delete(nodeId);
      this.render();
    });

    this.eventBus.on('group:collapse', ({ groupId }) => {
      this.collapsedGroups.add(groupId);
      this.render();
    });

    this.eventBus.on('group:expand', ({ groupId }) => {
      this.collapsedGroups.delete(groupId);
      this.render();
    });

    this.eventBus.on('sort:change', ({ sortBy }) => {
      this.sortBy = sortBy;
      this.render();
    });

    this.eventBus.on('filter:reset', () => {
      this.hiddenNodes.clear();
      this.hiddenCrates.clear();
      this.collapsedGroups.clear();
      this.render();
    });

    this.eventBus.on('crates:filter', ({ hiddenCrates }) => {
      this.hiddenCrates = new Set(hiddenCrates);
      this.render();
    });

    this.eventBus.on('dsm:zoomIn', () => {
      this.zoomIn();
    });

    this.eventBus.on('dsm:zoomOut', () => {
      this.zoomOut();
    });

    this.eventBus.on('dsm:fitToView', () => {
      this.fitToView();
    });

    this.eventBus.on('dsm:collapseAll', () => {
      this.collapseAll();
    });

    this.eventBus.on('dsm:expandAll', () => {
      this.expandAll();
    });

    this.eventBus.on('dsm:collapseToLevel', ({ level }) => {
      this.collapseToLevel(level);
    });

    this.eventBus.on('kind:toggle', ({ kind, visible }) => {
      if (visible) {
        this.hiddenKinds.delete(kind);
      } else {
        this.hiddenKinds.add(kind);
      }
      this.render();
    });

    this.eventBus.on('kind:showAll', () => {
      this.hiddenKinds.clear();
      this.render();
    });

    this.eventBus.on('kind:showTypesOnly', () => {
      this.hiddenKinds.clear();
      this.hiddenKinds.add('module');
      this.hiddenKinds.add('function');
      this.render();
    });

    this.eventBus.on('kind:showFunctionsOnly', () => {
      this.hiddenKinds.clear();
      this.hiddenKinds.add('module');
      this.hiddenKinds.add('struct');
      this.hiddenKinds.add('enum');
      this.hiddenKinds.add('trait');
      this.render();
    });

    // Sync from graph - apply the same visibility
    this.eventBus.on('sync:fromGraph', ({ visibleNodeIds }) => {
      // Determine which groups should be collapsed based on visible nodes
      this.collapsedGroups.clear();
      const visibleSet = new Set(visibleNodeIds);

      this.data.nodes.forEach(node => {
        if (node.kind === 'module' && node.childIds && node.childIds.length > 0) {
          // If none of the children are visible, collapse this group
          const hasVisibleChild = node.childIds.some(childId => visibleSet.has(childId));
          if (!hasVisibleChild) {
            this.collapsedGroups.add(node.id);
          }
        }
      });

      this.render();
    });
  }

  // Get the IDs of currently visible nodes (for syncing to graph)
  getVisibleNodeIds() {
    return this.getVisibleNodes().map(n => n.id);
  }

  // Emit sync event to graph
  syncToGraph() {
    const visibleNodeIds = this.getVisibleNodeIds();
    this.eventBus.emit('sync:fromDsm', { visibleNodeIds });
  }
}

window.DsmMatrix = DsmMatrix;
`;
}
