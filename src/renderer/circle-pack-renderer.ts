export function generateCirclePackClientCode(): string {
  return `
// Circle Packing Visualization
class CirclePackView {
  constructor(container, data) {
    this.container = container;
    this.data = data;
    this.width = 800;
    this.height = 600;
    this.sizeBy = 'linesOfCode';
    this.colorBy = 'kind';
    this.currentView = null;
    this.eventBus = window.eventBus;

    this.init();
  }

  init() {
    this.svg = d3.select(this.container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', \`0 0 \${this.width} \${this.height}\`);

    this.g = this.svg.append('g')
      .attr('transform', \`translate(\${this.width / 2}, \${this.height / 2})\`);

    this.tooltip = d3.select('body')
      .append('div')
      .attr('class', 'circle-tooltip')
      .style('opacity', 0);

    this.render();
    this.setupEventListeners();
  }

  render() {
    this.g.selectAll('*').remove();

    const pack = d3.pack()
      .size([this.width - 20, this.height - 20])
      .padding(3);

    const root = d3.hierarchy(this.data)
      .sum(d => this.getValue(d))
      .sort((a, b) => b.value - a.value);

    pack(root);

    this.currentView = root;

    const node = this.g.selectAll('g')
      .data(root.descendants())
      .enter()
      .append('g')
      .attr('transform', d => \`translate(\${d.x - this.width / 2}, \${d.y - this.height / 2})\`)
      .attr('class', d => d.children ? 'node-parent' : 'node-leaf');

    // Draw circles
    node.append('circle')
      .attr('r', d => d.r)
      .attr('fill', d => this.getColor(d))
      .attr('fill-opacity', d => d.children ? 0.3 : 0.8)
      .attr('stroke', d => d.children ? this.getColor(d) : 'none')
      .attr('stroke-width', d => d.children ? 2 : 0)
      .on('click', (event, d) => this.onClick(event, d))
      .on('mouseover', (event, d) => this.showTooltip(event, d))
      .on('mouseout', () => this.hideTooltip());

    // Labels for larger circles
    node.filter(d => d.r > 20)
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', d => d.children ? -d.r + 15 : '.3em')
      .attr('font-size', d => Math.min(d.r / 3, 14) + 'px')
      .attr('fill', d => d.children ? '#333' : '#fff')
      .attr('pointer-events', 'none')
      .text(d => this.truncate(d.data.name, Math.floor(d.r / 4)));

    // Value labels for leaf nodes
    node.filter(d => !d.children && d.r > 30)
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '1.5em')
      .attr('font-size', '10px')
      .attr('fill', 'rgba(255,255,255,0.7)')
      .attr('pointer-events', 'none')
      .text(d => this.formatValue(this.getValue(d.data)));
  }

  getValue(node) {
    switch (this.sizeBy) {
      case 'fileSize':
        return node.fileSize || 1;
      case 'complexity':
        return node.complexity || 1;
      default:
        return node.linesOfCode || 1;
    }
  }

  getColor(d) {
    const node = d.data;
    const depth = d.depth;

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
        const colors = d3.scaleOrdinal()
          .domain([0, 1, 2, 3, 4])
          .range(['#3498db', '#2ecc71', '#9b59b6', '#f39c12', '#e74c3c']);
        return colors(depth % 5);
    }
  }

  onClick(event, d) {
    event.stopPropagation();

    if (d === this.currentView) {
      // Zoom out to parent
      if (d.parent) {
        this.zoomTo(d.parent);
      }
    } else if (d.children) {
      // Zoom in to this node
      this.zoomTo(d);
    }
  }

  zoomTo(d) {
    this.currentView = d;

    const transition = this.svg.transition()
      .duration(750);

    const k = this.width / (d.r * 2);

    this.g.selectAll('g')
      .transition(transition)
      .attr('transform', node => {
        const x = (node.x - d.x) * k;
        const y = (node.y - d.y) * k;
        return \`translate(\${x}, \${y})\`;
      });

    this.g.selectAll('circle')
      .transition(transition)
      .attr('r', node => node.r * k);

    this.g.selectAll('text')
      .transition(transition)
      .attr('font-size', node => Math.min((node.r * k) / 3, 14) + 'px')
      .style('opacity', node => {
        const r = node.r * k;
        return r > 20 ? 1 : 0;
      });
  }

  showTooltip(event, d) {
    const node = d.data;
    let html = \`<strong>\${node.name}</strong><br>\`;
    html += \`Path: \${node.path}<br>\`;
    html += \`Lines: \${node.linesOfCode || 0}<br>\`;
    html += \`Size: \${this.formatBytes(node.fileSize || 0)}<br>\`;
    html += \`Complexity: \${node.complexity || 0}\`;

    if (d.children) {
      html += \`<br>Children: \${d.children.length}\`;
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
    this.render();
  }

  setupEventListeners() {
    this.eventBus.on('circles:sizeBy', ({ sizeBy }) => {
      this.setSizeBy(sizeBy);
    });

    this.eventBus.on('circles:colorBy', ({ colorBy }) => {
      this.setColorBy(colorBy);
    });

    this.eventBus.on('circles:reset', () => {
      this.reset();
    });

    // Click on SVG background to zoom out
    this.svg.on('click', () => {
      if (this.currentView && this.currentView.parent) {
        this.zoomTo(this.currentView.parent);
      }
    });
  }
}

window.CirclePackView = CirclePackView;
`;
}
