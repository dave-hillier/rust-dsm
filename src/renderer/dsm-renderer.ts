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
    this.sortBy = 'path';
    this.eventBus = window.eventBus;

    this.init();
  }

  init() {
    this.svg = d3.select(this.container)
      .append('svg')
      .attr('class', 'dsm-svg');

    this.tooltip = d3.select('body')
      .append('div')
      .attr('class', 'dsm-tooltip')
      .style('opacity', 0);

    this.render();
    this.setupEventListeners();
  }

  render() {
    this.svg.selectAll('*').remove();

    const visibleNodes = this.getVisibleNodes();
    const n = visibleNodes.length;
    const width = this.labelWidth + n * this.cellSize + 50;
    const height = this.headerHeight + n * this.cellSize + 50;

    this.svg.attr('width', width).attr('height', height);

    const g = this.svg.append('g')
      .attr('transform', \`translate(\${this.labelWidth}, \${this.headerHeight})\`);

    this.renderRowLabels(visibleNodes);
    this.renderColumnLabels(visibleNodes);
    this.renderCells(g, visibleNodes);
    this.renderCycleHighlights(g, visibleNodes);
  }

  getVisibleNodes() {
    let nodes = this.data.nodes.filter(n => !this.hiddenNodes.has(n.id));

    // Filter out children of collapsed groups
    for (const groupId of this.collapsedGroups) {
      nodes = nodes.filter(n => !this.isDescendantOf(n.id, groupId));
    }

    return this.sortNodes(nodes);
  }

  isDescendantOf(nodeId, ancestorId) {
    let current = this.data.nodes.find(n => n.id === nodeId);
    while (current && current.parentId) {
      if (current.parentId === ancestorId) return true;
      current = this.data.nodes.find(n => n.id === current.parentId);
    }
    return false;
  }

  sortNodes(nodes) {
    const sorted = [...nodes];

    switch (this.sortBy) {
      case 'instability':
        sorted.sort((a, b) => {
          const ma = this.metrics.get(a.id);
          const mb = this.metrics.get(b.id);
          return (mb?.instability ?? 0) - (ma?.instability ?? 0);
        });
        break;
      case 'coupling':
        sorted.sort((a, b) => {
          const ma = this.metrics.get(a.id);
          const mb = this.metrics.get(b.id);
          const ca = (ma?.afferentCoupling ?? 0) + (ma?.efferentCoupling ?? 0);
          const cb = (mb?.afferentCoupling ?? 0) + (mb?.efferentCoupling ?? 0);
          return cb - ca;
        });
        break;
      default:
        sorted.sort((a, b) => a.path.localeCompare(b.path));
    }

    return sorted;
  }

  renderRowLabels(nodes) {
    const g = this.svg.append('g')
      .attr('class', 'row-labels')
      .attr('transform', \`translate(0, \${this.headerHeight})\`);

    g.selectAll('text')
      .data(nodes)
      .enter()
      .append('text')
      .attr('x', this.labelWidth - 5)
      .attr('y', (d, i) => i * this.cellSize + this.cellSize / 2)
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'middle')
      .attr('class', d => \`label \${d.kind} \${this.isInCycle(d.id) ? 'in-cycle' : ''}\`)
      .attr('font-size', '11px')
      .text(d => this.truncateLabel(d.name, 25))
      .on('click', (event, d) => this.onNodeClick(d))
      .on('mouseover', (event, d) => this.showTooltip(event, d))
      .on('mouseout', () => this.hideTooltip())
      .on('contextmenu', (event, d) => this.showContextMenu(event, d));
  }

  renderColumnLabels(nodes) {
    const g = this.svg.append('g')
      .attr('class', 'col-labels')
      .attr('transform', \`translate(\${this.labelWidth}, \${this.headerHeight})\`);

    g.selectAll('text')
      .data(nodes)
      .enter()
      .append('text')
      .attr('x', 0)
      .attr('y', 0)
      .attr('transform', (d, i) => \`translate(\${i * this.cellSize + this.cellSize / 2}, -5) rotate(-45)\`)
      .attr('text-anchor', 'start')
      .attr('class', d => \`label \${d.kind} \${this.isInCycle(d.id) ? 'in-cycle' : ''}\`)
      .attr('font-size', '11px')
      .text(d => this.truncateLabel(d.name, 15))
      .on('click', (event, d) => this.onNodeClick(d))
      .on('mouseover', (event, d) => this.showTooltip(event, d))
      .on('mouseout', () => this.hideTooltip());
  }

  renderCells(g, nodes) {
    const nodeIndexMap = new Map(nodes.map((n, i) => [n.id, i]));
    const visibleCells = this.data.matrix.filter(cell => {
      const fromNode = this.data.nodes[cell.row];
      const toNode = this.data.nodes[cell.col];
      return nodeIndexMap.has(fromNode?.id) && nodeIndexMap.has(toNode?.id);
    });

    const maxValue = Math.max(...visibleCells.map(c => c.value), 1);
    const colorScale = d3.scaleSequential(d3.interpolateBlues)
      .domain([0, maxValue]);

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

    // Cells
    for (const cell of visibleCells) {
      const fromNode = this.data.nodes[cell.row];
      const toNode = this.data.nodes[cell.col];
      const row = nodeIndexMap.get(fromNode.id);
      const col = nodeIndexMap.get(toNode.id);

      if (row === undefined || col === undefined) continue;

      g.append('rect')
        .attr('class', 'cell')
        .attr('x', col * this.cellSize + 1)
        .attr('y', row * this.cellSize + 1)
        .attr('width', this.cellSize - 2)
        .attr('height', this.cellSize - 2)
        .attr('fill', colorScale(cell.value))
        .attr('data-from', fromNode.id)
        .attr('data-to', toNode.id)
        .on('mouseover', (event) => this.showCellTooltip(event, cell, fromNode, toNode))
        .on('mouseout', () => this.hideTooltip())
        .on('click', () => this.onCellClick(cell, fromNode, toNode));
    }

    // Diagonal
    g.selectAll('.diagonal')
      .data(nodes)
      .enter()
      .append('rect')
      .attr('class', 'diagonal')
      .attr('x', (d, i) => i * this.cellSize)
      .attr('y', (d, i) => i * this.cellSize)
      .attr('width', this.cellSize)
      .attr('height', this.cellSize)
      .attr('fill', '#f0f0f0');
  }

  renderCycleHighlights(g, nodes) {
    const nodeIndexMap = new Map(nodes.map((n, i) => [n.id, i]));

    for (const cycle of this.data.cycles) {
      const cycleNodeIndices = cycle.nodes
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
    this.svg.selectAll('.label')
      .classed('selected', d => d.id === nodeId);

    this.svg.selectAll('.cell')
      .classed('highlighted', function() {
        return this.dataset.from === nodeId || this.dataset.to === nodeId;
      });
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
      this.collapsedGroups.clear();
      this.render();
    });
  }
}

window.DsmMatrix = DsmMatrix;
`;
}
