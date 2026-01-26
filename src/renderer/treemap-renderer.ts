import type { FileNode } from '../types/graph.js';
import type { CrateDefinition, ModuleDefinition } from '../types/ast.js';
import { readFileSync } from 'fs';

export function buildFileTree(crate: CrateDefinition): FileNode {
  // Check if this is a workspace (virtual crate with multiple submodules named 'crate')
  const isWorkspace = crate.rootModule.submodules.length > 0 &&
    crate.rootModule.submodules.every(m => m.name === 'crate');

  if (isWorkspace) {
    return buildWorkspaceTree(crate);
  }

  return buildModuleTree(crate.rootModule, crate.name);
}

function buildWorkspaceTree(workspace: CrateDefinition): FileNode {
  // Each submodule is a crate root, give it the crate's name
  const children: FileNode[] = workspace.rootModule.submodules.map((crateRoot, index) => {
    // Find the crate name from the path - look for parent of 'src' directory
    // Path is like /path/to/kernel/hx-alias/src/lib.rs
    const pathParts = crateRoot.filePath.split('/');
    const srcIndex = pathParts.lastIndexOf('src');
    const crateName = srcIndex > 0 ? pathParts[srcIndex - 1] : `crate_${index}`;
    return buildModuleTree(crateRoot, crateName);
  });

  return {
    name: workspace.name,
    path: 'workspace',
    children,
    linesOfCode: 0,
    fileSize: 0,
    complexity: 0,
  };
}

function buildModuleTree(module: ModuleDefinition, crateName?: string): FileNode {
  let linesOfCode = 0;
  let fileSize = 0;

  try {
    const content = readFileSync(module.filePath, 'utf-8');
    linesOfCode = content.split('\n').length;
    fileSize = Buffer.byteLength(content, 'utf-8');
  } catch {
    // File might not be readable
  }

  const complexity =
    module.functions.reduce((sum, fn) => sum + fn.bodyCallsites.length + 1, 0) +
    module.impls.reduce((sum, impl) => sum + impl.methods.length, 0);

  const children: FileNode[] = module.submodules.map(m => buildModuleTree(m));

  // Use crate name for root modules (named 'crate')
  const displayName = (module.name === 'crate' && crateName) ? crateName : module.name;
  const displayPath = (module.name === 'crate' && crateName) ? crateName : module.path;

  return {
    name: displayName,
    path: displayPath,
    children: children.length > 0 ? children : undefined,
    linesOfCode,
    fileSize,
    complexity,
  };
}

export function generateTreemapClientCode(): string {
  return `
// Treemap Visualization
class TreemapView {
  constructor(container, data) {
    this.container = container;
    this.data = data;
    this.width = 800;
    this.height = 600;
    this.sizeBy = 'linesOfCode';
    this.colorBy = 'kind';
    this.currentRoot = data;
    this.breadcrumb = [data];
    this.eventBus = window.eventBus;

    this.init();
  }

  init() {
    this.svg = d3.select(this.container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', \`0 0 \${this.width} \${this.height}\`);

    this.tooltip = d3.select('body')
      .append('div')
      .attr('class', 'treemap-tooltip')
      .style('opacity', 0);

    this.breadcrumbContainer = d3.select(this.container)
      .insert('div', ':first-child')
      .attr('class', 'breadcrumb');

    this.render();
    this.setupEventListeners();
  }

  render() {
    this.svg.selectAll('*').remove();
    this.renderBreadcrumb();

    const treemap = d3.treemap()
      .size([this.width, this.height])
      .paddingTop(20)
      .paddingInner(2)
      .paddingOuter(4)
      .round(true);

    const root = d3.hierarchy(this.currentRoot)
      .sum(d => this.getLeafValue(d))
      .sort((a, b) => b.value - a.value);

    if (root.value === 0) {
      this.svg.append('text')
        .attr('x', this.width / 2)
        .attr('y', this.height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', '#999')
        .text('No data to display');
      return;
    }

    treemap(root);

    // Render all nodes (not just leaves) for nested treemap
    const allNodes = root.descendants();

    // First render parent group backgrounds
    const parents = this.svg.selectAll('g.parent')
      .data(allNodes.filter(d => d.children))
      .enter()
      .append('g')
      .attr('class', 'parent')
      .attr('transform', d => \`translate(\${d.x0}, \${d.y0})\`);

    parents.append('rect')
      .attr('width', d => Math.max(0, d.x1 - d.x0))
      .attr('height', d => Math.max(0, d.y1 - d.y0))
      .attr('fill', d => d.depth === 0 ? '#f8f9fa' : this.getParentColor(d.depth))
      .attr('stroke', '#ccc')
      .attr('stroke-width', 1);

    parents.append('text')
      .attr('x', 4)
      .attr('y', 14)
      .attr('font-size', '11px')
      .attr('font-weight', 'bold')
      .attr('fill', '#333')
      .text(d => {
        const width = d.x1 - d.x0;
        if (width < 50) return '';
        return this.truncate(d.data.name, Math.floor(width / 7));
      });

    // Then render leaf cells
    const leaves = this.svg.selectAll('g.leaf')
      .data(root.leaves())
      .enter()
      .append('g')
      .attr('class', 'leaf')
      .attr('transform', d => \`translate(\${d.x0}, \${d.y0})\`);

    leaves.append('rect')
      .attr('width', d => Math.max(0, d.x1 - d.x0))
      .attr('height', d => Math.max(0, d.y1 - d.y0))
      .attr('fill', d => this.getColor(d.data))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1)
      .on('click', (event, d) => this.onClick(d))
      .on('mouseover', (event, d) => this.showTooltip(event, d))
      .on('mouseout', () => this.hideTooltip());

    leaves.append('clipPath')
      .attr('id', (d, i) => \`clip-\${i}\`)
      .append('rect')
      .attr('width', d => Math.max(0, d.x1 - d.x0))
      .attr('height', d => Math.max(0, d.y1 - d.y0));

    leaves.append('text')
      .attr('clip-path', (d, i) => \`url(#clip-\${i})\`)
      .attr('x', 4)
      .attr('y', 14)
      .attr('font-size', '10px')
      .attr('fill', '#fff')
      .text(d => {
        const width = d.x1 - d.x0;
        if (width < 30) return '';
        return this.truncate(d.data.name, Math.floor(width / 7));
      });
  }

  getLeafValue(node) {
    // Only count leaf nodes' values
    if (!node.children || node.children.length === 0) {
      let value;
      switch (this.sizeBy) {
        case 'fileSize':
          value = node.fileSize || 0;
          break;
        case 'complexity':
          value = node.complexity || 0;
          break;
        default:
          value = node.linesOfCode || 0;
      }
      return Math.max(value, 1);
    }
    return 0; // Non-leaf nodes get value from sum of children
  }

  getParentColor(depth) {
    const colors = ['#f8f9fa', '#e9ecef', '#dee2e6', '#ced4da', '#adb5bd'];
    return colors[Math.min(depth, colors.length - 1)];
  }

  renderBreadcrumb() {
    this.breadcrumbContainer.selectAll('*').remove();

    this.breadcrumb.forEach((node, i) => {
      if (i > 0) {
        this.breadcrumbContainer.append('span')
          .attr('class', 'separator')
          .text(' / ');
      }

      this.breadcrumbContainer.append('a')
        .attr('href', '#')
        .attr('class', i === this.breadcrumb.length - 1 ? 'current' : '')
        .text(node.name)
        .on('click', (event) => {
          event.preventDefault();
          this.zoomTo(node, i);
        });
    });
  }

  getValue(node) {
    if (node.children) {
      return node.children.reduce((sum, child) => sum + this.getValue(child), 0);
    }

    let value;
    switch (this.sizeBy) {
      case 'fileSize':
        value = node.fileSize || 0;
        break;
      case 'complexity':
        value = node.complexity || 0;
        break;
      default:
        value = node.linesOfCode || 0;
    }
    // Ensure minimum value to prevent zero-area rectangles
    return Math.max(value, 1);
  }

  filterEmptyNodes(node) {
    if (!node.children) {
      // Leaf node - check if it has any meaningful value
      const hasValue = (node.linesOfCode > 0) || (node.fileSize > 0) || (node.complexity > 0);
      return hasValue ? node : null;
    }

    const filteredChildren = node.children
      .map(child => this.filterEmptyNodes(child))
      .filter(Boolean);

    if (filteredChildren.length === 0) {
      return null;
    }

    return { ...node, children: filteredChildren };
  }

  getColor(node) {
    switch (this.colorBy) {
      case 'complexity':
        const complexity = node.complexity || 0;
        const scale = d3.scaleSequential(d3.interpolateRdYlGn)
          .domain([20, 0]);
        return scale(Math.min(complexity, 20));

      case 'coupling':
        const coupling = (node.afferentCoupling || 0) + (node.efferentCoupling || 0);
        const couplingScale = d3.scaleSequential(d3.interpolateOrRd)
          .domain([0, 10]);
        return couplingScale(Math.min(coupling, 10));

      default:
        const depth = this.getDepth(node);
        const colors = ['#3498db', '#2980b9', '#1f618d', '#154360'];
        return colors[Math.min(depth, colors.length - 1)];
    }
  }

  getDepth(node) {
    let depth = 0;
    let path = node.path;
    for (const crumb of this.breadcrumb) {
      if (path.startsWith(crumb.path)) {
        depth++;
      }
    }
    return depth;
  }

  onClick(d) {
    const node = d.data;

    // Find the parent node that has children
    let current = this.currentRoot;
    const path = node.path.split('::');

    for (const segment of path) {
      if (current.children) {
        const child = current.children.find(c => c.name === segment);
        if (child && child.children) {
          current = child;
        }
      }
    }

    if (current !== this.currentRoot && current.children) {
      this.zoomTo(current, this.breadcrumb.length);
    }
  }

  zoomTo(node, breadcrumbIndex) {
    this.currentRoot = node;
    this.breadcrumb = this.breadcrumb.slice(0, breadcrumbIndex + 1);
    if (!this.breadcrumb.includes(node)) {
      this.breadcrumb.push(node);
    }
    this.render();
  }

  showTooltip(event, d) {
    const node = d.data;
    let html = \`<strong>\${node.name}</strong><br>\`;
    html += \`Path: \${node.path}<br>\`;
    html += \`Lines: \${node.linesOfCode || 0}<br>\`;
    html += \`Size: \${this.formatBytes(node.fileSize || 0)}<br>\`;
    html += \`Complexity: \${node.complexity || 0}\`;

    this.tooltip
      .html(html)
      .style('left', (event.pageX + 10) + 'px')
      .style('top', (event.pageY - 10) + 'px')
      .style('opacity', 1);
  }

  hideTooltip() {
    this.tooltip.style('opacity', 0);
  }

  truncate(text, maxLen) {
    return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
  }

  formatValue(value) {
    if (this.sizeBy === 'fileSize') {
      return this.formatBytes(value);
    }
    return value.toLocaleString();
  }

  formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  setSizeBy(sizeBy) {
    this.sizeBy = sizeBy;
    this.render();
  }

  setColorBy(colorBy) {
    this.colorBy = colorBy;
    this.render();
  }

  reset() {
    this.currentRoot = this.data;
    this.breadcrumb = [this.data];
    this.render();
  }

  setupEventListeners() {
    this.eventBus.on('treemap:sizeBy', ({ sizeBy }) => {
      this.setSizeBy(sizeBy);
    });

    this.eventBus.on('treemap:colorBy', ({ colorBy }) => {
      this.setColorBy(colorBy);
    });

    this.eventBus.on('treemap:reset', () => {
      this.reset();
    });
  }
}

window.TreemapView = TreemapView;
`;
}
