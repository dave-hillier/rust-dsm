import type { DependencyGraph, GraphViewData, GraphViewNode, GraphViewLink } from '../types/graph.js';
import type { MetricsReport } from '../types/metrics.js';

export function buildGraphViewData(graph: DependencyGraph, metrics: MetricsReport): GraphViewData {
  const nodes: GraphViewNode[] = [];
  const links: GraphViewLink[] = [];

  for (const [id, node] of graph.nodes) {
    nodes.push({
      id: node.id,
      label: node.name,
      parent: node.parentId ?? undefined,
      kind: node.kind,
    });
  }

  for (const edge of graph.edges) {
    links.push({
      source: edge.from,
      target: edge.to,
      weight: edge.count,
      depType: edge.depType,
    });
  }

  return { nodes, links };
}

export function generateGraphClientCode(): string {
  return `
// Graph Explorer Visualization
class GraphExplorer {
  constructor(container, data, metrics) {
    this.container = container;
    this.data = data;
    this.metrics = metrics;
    this.width = 800;
    this.height = 600;
    this.layout = 'force';
    this.selectedNodes = new Set();
    this.hiddenNodes = new Set();
    this.groups = new Map();
    this.simulation = null;
    this.eventBus = window.eventBus;

    this.init();
  }

  init() {
    this.svg = d3.select(this.container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', \`0 0 \${this.width} \${this.height}\`);

    this.g = this.svg.append('g');

    this.zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
      });

    this.svg.call(this.zoom);

    this.tooltip = d3.select('body')
      .append('div')
      .attr('class', 'graph-tooltip')
      .style('opacity', 0);

    // Initialize node positions
    this.data.nodes.forEach((node, i) => {
      node.x = this.width / 2 + Math.random() * 100 - 50;
      node.y = this.height / 2 + Math.random() * 100 - 50;
    });

    this.render();
    this.setupEventListeners();
  }

  render() {
    this.g.selectAll('*').remove();

    switch (this.layout) {
      case 'force':
        this.renderForceLayout();
        break;
      case 'tree':
        this.renderTreeLayout();
        break;
      case 'radial':
        this.renderRadialLayout();
        break;
    }
  }

  getVisibleData() {
    const nodes = this.data.nodes.filter(n => !this.hiddenNodes.has(n.id));
    const nodeIds = new Set(nodes.map(n => n.id));
    const links = this.data.links.filter(l => {
      const sourceId = typeof l.source === 'string' ? l.source : l.source.id;
      const targetId = typeof l.target === 'string' ? l.target : l.target.id;
      return nodeIds.has(sourceId) && nodeIds.has(targetId);
    });
    return { nodes, links };
  }

  renderForceLayout() {
    const { nodes, links } = this.getVisibleData();

    // Stop existing simulation
    if (this.simulation) {
      this.simulation.stop();
    }

    // Create links
    const link = this.g.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(links)
      .enter()
      .append('line')
      .attr('class', 'link')
      .attr('stroke', '#999')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', d => Math.sqrt(d.weight));

    // Create node groups
    const node = this.g.append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(nodes)
      .enter()
      .append('g')
      .attr('class', d => \`node \${d.kind}\`)
      .call(d3.drag()
        .on('start', (event, d) => this.dragStarted(event, d))
        .on('drag', (event, d) => this.dragged(event, d))
        .on('end', (event, d) => this.dragEnded(event, d)));

    // Add circles
    node.append('circle')
      .attr('r', d => this.getNodeRadius(d))
      .attr('fill', d => this.getNodeColor(d))
      .attr('stroke', d => this.selectedNodes.has(d.id) ? '#000' : '#fff')
      .attr('stroke-width', d => this.selectedNodes.has(d.id) ? 3 : 1.5);

    // Add labels
    node.append('text')
      .attr('dx', d => this.getNodeRadius(d) + 5)
      .attr('dy', '.35em')
      .attr('font-size', '11px')
      .text(d => d.label);

    // Event handlers
    node
      .on('click', (event, d) => this.onNodeClick(event, d))
      .on('dblclick', (event, d) => this.onNodeDoubleClick(event, d))
      .on('mouseover', (event, d) => this.showTooltip(event, d))
      .on('mouseout', () => this.hideTooltip())
      .on('contextmenu', (event, d) => this.showContextMenu(event, d));

    // Create simulation
    this.simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2))
      .force('collision', d3.forceCollide().radius(30))
      .on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);

        node.attr('transform', d => \`translate(\${d.x}, \${d.y})\`);
      });
  }

  renderTreeLayout() {
    const { nodes, links } = this.getVisibleData();

    // Build hierarchy
    const hierarchy = this.buildHierarchy(nodes);
    if (!hierarchy) return;

    const treeLayout = d3.tree()
      .size([this.width - 100, this.height - 100]);

    const root = d3.hierarchy(hierarchy);
    treeLayout(root);

    // Create links
    this.g.append('g')
      .attr('class', 'links')
      .attr('transform', 'translate(50, 50)')
      .selectAll('path')
      .data(root.links())
      .enter()
      .append('path')
      .attr('class', 'tree-link')
      .attr('fill', 'none')
      .attr('stroke', '#999')
      .attr('stroke-width', 1.5)
      .attr('d', d3.linkVertical()
        .x(d => d.x)
        .y(d => d.y));

    // Create nodes
    const node = this.g.append('g')
      .attr('class', 'nodes')
      .attr('transform', 'translate(50, 50)')
      .selectAll('g')
      .data(root.descendants())
      .enter()
      .append('g')
      .attr('class', d => \`node \${d.data.kind}\`)
      .attr('transform', d => \`translate(\${d.x}, \${d.y})\`);

    node.append('circle')
      .attr('r', d => this.getNodeRadius(d.data))
      .attr('fill', d => this.getNodeColor(d.data))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5);

    node.append('text')
      .attr('dy', -15)
      .attr('text-anchor', 'middle')
      .attr('font-size', '10px')
      .text(d => d.data.label);

    node
      .on('click', (event, d) => this.onNodeClick(event, d.data))
      .on('mouseover', (event, d) => this.showTooltip(event, d.data))
      .on('mouseout', () => this.hideTooltip());
  }

  renderRadialLayout() {
    const { nodes, links } = this.getVisibleData();

    const hierarchy = this.buildHierarchy(nodes);
    if (!hierarchy) return;

    const radius = Math.min(this.width, this.height) / 2 - 100;

    const treeLayout = d3.tree()
      .size([2 * Math.PI, radius])
      .separation((a, b) => (a.parent === b.parent ? 1 : 2) / a.depth);

    const root = d3.hierarchy(hierarchy);
    treeLayout(root);

    const radialPoint = (x, y) => {
      return [(y = +y) * Math.cos(x -= Math.PI / 2), y * Math.sin(x)];
    };

    this.g.attr('transform', \`translate(\${this.width / 2}, \${this.height / 2})\`);

    // Links
    this.g.append('g')
      .attr('class', 'links')
      .selectAll('path')
      .data(root.links())
      .enter()
      .append('path')
      .attr('class', 'radial-link')
      .attr('fill', 'none')
      .attr('stroke', '#999')
      .attr('stroke-width', 1.5)
      .attr('d', d3.linkRadial()
        .angle(d => d.x)
        .radius(d => d.y));

    // Nodes
    const node = this.g.append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(root.descendants())
      .enter()
      .append('g')
      .attr('class', d => \`node \${d.data.kind}\`)
      .attr('transform', d => \`translate(\${radialPoint(d.x, d.y)})\`);

    node.append('circle')
      .attr('r', d => this.getNodeRadius(d.data))
      .attr('fill', d => this.getNodeColor(d.data))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5);

    node.append('text')
      .attr('dy', '0.31em')
      .attr('x', d => d.x < Math.PI === !d.children ? 15 : -15)
      .attr('text-anchor', d => d.x < Math.PI === !d.children ? 'start' : 'end')
      .attr('transform', d => d.x >= Math.PI ? 'rotate(180)' : null)
      .attr('font-size', '10px')
      .text(d => d.data.label);

    node
      .on('click', (event, d) => this.onNodeClick(event, d.data))
      .on('mouseover', (event, d) => this.showTooltip(event, d.data))
      .on('mouseout', () => this.hideTooltip());
  }

  buildHierarchy(nodes) {
    const nodeMap = new Map(nodes.map(n => [n.id, { ...n, children: [] }]));

    let root = null;
    for (const node of nodeMap.values()) {
      if (node.parent && nodeMap.has(node.parent)) {
        nodeMap.get(node.parent).children.push(node);
      } else if (!root || node.kind === 'module') {
        root = node;
      }
    }

    if (!root && nodeMap.size > 0) {
      root = nodeMap.values().next().value;
    }

    return root;
  }

  getNodeRadius(node) {
    const metrics = this.metrics.get(node.id);
    if (metrics) {
      const coupling = metrics.afferentCoupling + metrics.efferentCoupling;
      return Math.max(8, Math.min(20, 8 + coupling * 2));
    }
    return node.kind === 'module' ? 12 : 8;
  }

  getNodeColor(node) {
    const colors = {
      module: '#3498db',
      struct: '#2ecc71',
      enum: '#9b59b6',
      trait: '#f39c12',
      function: '#e74c3c',
      impl: '#1abc9c'
    };
    return colors[node.kind] || '#95a5a6';
  }

  dragStarted(event, d) {
    if (!event.active) this.simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  dragEnded(event, d) {
    if (!event.active) this.simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  onNodeClick(event, node) {
    if (event.shiftKey) {
      if (this.selectedNodes.has(node.id)) {
        this.selectedNodes.delete(node.id);
      } else {
        this.selectedNodes.add(node.id);
      }
    } else {
      this.selectedNodes.clear();
      this.selectedNodes.add(node.id);
    }

    this.eventBus.emit('node:selected', { nodeId: node.id, source: 'graph' });
    this.updateSelection();
  }

  onNodeDoubleClick(event, node) {
    if (node.kind === 'module') {
      this.eventBus.emit('group:toggle', { groupId: node.id });
    }
  }

  updateSelection() {
    this.g.selectAll('.node circle')
      .attr('stroke', d => this.selectedNodes.has(d.id) ? '#000' : '#fff')
      .attr('stroke-width', d => this.selectedNodes.has(d.id) ? 3 : 1.5);
  }

  showTooltip(event, node) {
    const metrics = this.metrics.get(node.id);
    let html = \`<strong>\${node.label}</strong><br>\`;
    html += \`<span class="kind">\${node.kind}</span><br>\`;

    if (metrics) {
      html += \`<hr>\`;
      html += \`Ca: \${metrics.afferentCoupling}<br>\`;
      html += \`Ce: \${metrics.efferentCoupling}<br>\`;
      html += \`Instability: \${metrics.instability.toFixed(2)}\`;
    }

    this.tooltip
      .html(html)
      .style('left', (event.pageX + 10) + 'px')
      .style('top', (event.pageY - 10) + 'px')
      .style('opacity', 1);
  }

  hideTooltip() {
    this.tooltip.style('opacity', 0);
  }

  showContextMenu(event, node) {
    event.preventDefault();
    this.eventBus.emit('contextmenu:show', {
      x: event.pageX,
      y: event.pageY,
      node,
      source: 'graph'
    });
  }

  setLayout(layout) {
    this.layout = layout;
    this.g.attr('transform', null); // Reset transform for non-radial layouts
    this.render();
  }

  centerOnNode(nodeId) {
    const node = this.data.nodes.find(n => n.id === nodeId);
    if (!node || node.x === undefined) return;

    const transform = d3.zoomIdentity
      .translate(this.width / 2 - node.x, this.height / 2 - node.y);

    this.svg.transition()
      .duration(500)
      .call(this.zoom.transform, transform);
  }

  setupEventListeners() {
    this.eventBus.on('node:selected', ({ nodeId, source }) => {
      if (source !== 'graph') {
        this.selectedNodes.clear();
        this.selectedNodes.add(nodeId);
        this.updateSelection();
        this.centerOnNode(nodeId);
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

    this.eventBus.on('layout:change', ({ layout }) => {
      this.setLayout(layout);
    });

    this.eventBus.on('filter:reset', () => {
      this.hiddenNodes.clear();
      this.selectedNodes.clear();
      this.render();
    });
  }
}

window.GraphExplorer = GraphExplorer;
`;
}
