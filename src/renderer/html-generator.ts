import { writeFileSync } from 'fs';
import type { CrateDefinition } from '../types/ast.js';
import type { DependencyGraph, Cycle } from '../types/graph.js';
import type { MetricsReport } from '../types/metrics.js';
import { buildDsmData, generateDsmClientCode } from './dsm-renderer.js';
import { buildGraphViewData, generateGraphClientCode } from './graph-renderer.js';
import { buildFileTree, generateTreemapClientCode } from './treemap-renderer.js';
import { generateCirclePackClientCode } from './circle-pack-renderer.js';

export async function generateHtmlReport(
  crate: CrateDefinition,
  graph: DependencyGraph,
  cycles: Cycle[],
  metrics: MetricsReport,
  outputPath: string
): Promise<void> {
  const dsmData = buildDsmData(graph, metrics, cycles);
  const graphData = buildGraphViewData(graph, metrics);
  const fileTree = buildFileTree(crate);

  const metricsArray = Array.from(metrics.nodeMetrics.entries());

  const html = generateHtml(crate.name, dsmData, graphData, fileTree, metricsArray, metrics.crateMetrics);

  writeFileSync(outputPath, html, 'utf-8');
}

function generateHtml(
  crateName: string,
  dsmData: ReturnType<typeof buildDsmData>,
  graphData: ReturnType<typeof buildGraphViewData>,
  fileTree: ReturnType<typeof buildFileTree>,
  metricsArray: [string, import('../types/metrics.js').NodeMetrics][],
  crateMetrics: import('../types/metrics.js').CrateMetrics
): string {
  const dsmClientCode = generateDsmClientCode();
  const graphClientCode = generateGraphClientCode();
  const treemapClientCode = generateTreemapClientCode();
  const circlePackClientCode = generateCirclePackClientCode();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSM Report: ${crateName}</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      color: #333;
    }

    header {
      background: #2c3e50;
      color: white;
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    header h1 {
      font-size: 1.5rem;
      font-weight: 500;
    }

    .tabs {
      display: flex;
      gap: 0.5rem;
    }

    .tab {
      padding: 0.5rem 1rem;
      background: rgba(255,255,255,0.1);
      border: none;
      color: white;
      cursor: pointer;
      border-radius: 4px;
      font-size: 0.9rem;
    }

    .tab:hover {
      background: rgba(255,255,255,0.2);
    }

    .tab.active {
      background: #3498db;
    }

    .main-content {
      display: none;
      padding: 1rem;
    }

    .main-content.active {
      display: flex;
    }

    .split-view {
      display: flex;
      gap: 1rem;
      height: calc(100vh - 80px);
    }

    .panel {
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .panel-header {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid #eee;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .panel-header h2 {
      font-size: 1rem;
      font-weight: 500;
    }

    .controls {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }

    .controls select, .controls button {
      padding: 0.25rem 0.5rem;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 0.85rem;
      background: white;
      cursor: pointer;
    }

    .controls button:hover {
      background: #f0f0f0;
    }

    .panel-content {
      flex: 1;
      overflow: auto;
      padding: 1rem;
    }

    .sidebar {
      width: 300px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      display: flex;
      flex-direction: column;
    }

    .sidebar-section {
      padding: 1rem;
      border-bottom: 1px solid #eee;
    }

    .sidebar-section h3 {
      font-size: 0.9rem;
      font-weight: 500;
      margin-bottom: 0.5rem;
      color: #666;
    }

    .node-list {
      max-height: 200px;
      overflow-y: auto;
    }

    .node-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0;
      font-size: 0.85rem;
    }

    .node-item input {
      margin: 0;
    }

    .details-panel {
      flex: 1;
      overflow-y: auto;
    }

    .metric-row {
      display: flex;
      justify-content: space-between;
      padding: 0.25rem 0;
      font-size: 0.85rem;
    }

    .metric-label {
      color: #666;
    }

    .metric-value {
      font-weight: 500;
    }

    /* DSM Styles */
    .dsm-svg {
      font-family: inherit;
    }

    .dsm-svg .label {
      cursor: pointer;
      fill: #333;
    }

    .dsm-svg .label.module {
      font-weight: 500;
    }

    .dsm-svg .label.in-cycle {
      fill: #e74c3c;
    }

    .dsm-svg .label.selected {
      fill: #3498db;
      font-weight: bold;
    }

    .dsm-svg .cell {
      cursor: pointer;
    }

    .dsm-svg .cell:hover {
      stroke: #333;
      stroke-width: 2;
    }

    .dsm-svg .cell.highlighted {
      stroke: #3498db;
      stroke-width: 2;
    }

    /* Graph Styles */
    .node {
      cursor: pointer;
    }

    .node.module circle {
      fill: #3498db;
    }

    .node.struct circle {
      fill: #2ecc71;
    }

    .node.enum circle {
      fill: #9b59b6;
    }

    .node.trait circle {
      fill: #f39c12;
    }

    .node.function circle {
      fill: #e74c3c;
    }

    .link {
      stroke: #999;
      stroke-opacity: 0.6;
    }

    /* Tooltips */
    .dsm-tooltip, .graph-tooltip, .treemap-tooltip, .circle-tooltip {
      position: absolute;
      padding: 0.5rem 0.75rem;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      border-radius: 4px;
      font-size: 0.8rem;
      pointer-events: none;
      max-width: 300px;
      z-index: 1000;
    }

    .dsm-tooltip hr, .graph-tooltip hr {
      border: none;
      border-top: 1px solid rgba(255,255,255,0.2);
      margin: 0.25rem 0;
    }

    .dsm-tooltip .kind, .graph-tooltip .kind {
      color: #aaa;
      text-transform: uppercase;
      font-size: 0.7rem;
    }

    .dsm-tooltip .warning {
      color: #e74c3c;
    }

    /* Breadcrumb */
    .breadcrumb {
      padding: 0.5rem 1rem;
      background: #f9f9f9;
      border-bottom: 1px solid #eee;
      font-size: 0.85rem;
    }

    .breadcrumb a {
      color: #3498db;
      text-decoration: none;
    }

    .breadcrumb a:hover {
      text-decoration: underline;
    }

    .breadcrumb a.current {
      color: #333;
      font-weight: 500;
    }

    .breadcrumb .separator {
      color: #999;
      margin: 0 0.25rem;
    }

    /* Context Menu */
    .context-menu {
      position: absolute;
      background: white;
      border: 1px solid #ddd;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      z-index: 1000;
      min-width: 150px;
    }

    .context-menu-item {
      padding: 0.5rem 1rem;
      cursor: pointer;
      font-size: 0.85rem;
    }

    .context-menu-item:hover {
      background: #f0f0f0;
    }

    .context-menu-separator {
      border-top: 1px solid #eee;
      margin: 0.25rem 0;
    }

    /* Summary Cards */
    .summary-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin-bottom: 1rem;
    }

    .summary-card {
      background: white;
      padding: 1rem;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .summary-card .label {
      font-size: 0.8rem;
      color: #666;
      margin-bottom: 0.25rem;
    }

    .summary-card .value {
      font-size: 1.5rem;
      font-weight: 500;
    }

    .summary-card .value.warning {
      color: #e74c3c;
    }

    /* Metrics Table */
    .metrics-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }

    .metrics-table th, .metrics-table td {
      padding: 0.5rem;
      text-align: left;
      border-bottom: 1px solid #eee;
    }

    .metrics-table th {
      background: #f9f9f9;
      font-weight: 500;
      cursor: pointer;
    }

    .metrics-table th:hover {
      background: #f0f0f0;
    }

    .metrics-table tr:hover td {
      background: #f9f9f9;
    }

    .kind-badge {
      display: inline-block;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      font-size: 0.7rem;
      text-transform: uppercase;
    }

    .kind-badge.module { background: #e3f2fd; color: #1976d2; }
    .kind-badge.struct { background: #e8f5e9; color: #388e3c; }
    .kind-badge.enum { background: #f3e5f5; color: #7b1fa2; }
    .kind-badge.trait { background: #fff3e0; color: #f57c00; }
    .kind-badge.function { background: #ffebee; color: #d32f2f; }
  </style>
</head>
<body>
  <header>
    <h1>DSM Report: ${crateName}</h1>
    <nav class="tabs">
      <button class="tab active" data-tab="dependencies">Dependencies</button>
      <button class="tab" data-tab="structure">Structure</button>
      <button class="tab" data-tab="metrics">Metrics</button>
    </nav>
  </header>

  <main id="dependencies-tab" class="main-content active split-view">
    <section class="panel" style="flex: 2;">
      <div class="panel-header">
        <h2>Dependency Matrix</h2>
        <div class="controls">
          <select id="dsm-sort">
            <option value="path">Sort by Path</option>
            <option value="instability">Sort by Instability</option>
            <option value="coupling">Sort by Coupling</option>
          </select>
          <button id="dsm-expand-all">Expand All</button>
          <button id="dsm-collapse-all">Collapse All</button>
        </div>
      </div>
      <div class="panel-content" id="dsm-container"></div>
    </section>

    <section class="panel" style="flex: 2;">
      <div class="panel-header">
        <h2>Graph Explorer</h2>
        <div class="controls">
          <select id="graph-layout">
            <option value="force">Force Layout</option>
            <option value="tree">Tree Layout</option>
            <option value="radial">Radial Layout</option>
          </select>
          <button id="graph-reset">Reset View</button>
        </div>
      </div>
      <div class="panel-content" id="graph-container"></div>
    </section>

    <aside class="sidebar">
      <div class="sidebar-section">
        <h3>Filter Nodes</h3>
        <input type="text" id="node-search" placeholder="Search nodes..." style="width: 100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 0.5rem;">
        <div class="node-list" id="node-filter-list"></div>
        <div style="margin-top: 0.5rem;">
          <button id="show-all-nodes" style="width: 100%; padding: 0.5rem;">Show All</button>
        </div>
      </div>
      <div class="sidebar-section details-panel" id="details-panel">
        <h3>Details</h3>
        <p style="color: #999; font-size: 0.85rem;">Select a node to view details</p>
      </div>
    </aside>
  </main>

  <main id="structure-tab" class="main-content split-view">
    <section class="panel">
      <div class="panel-header">
        <h2>Treemap</h2>
        <div class="controls">
          <select id="treemap-size">
            <option value="linesOfCode">Size by Lines</option>
            <option value="fileSize">Size by File Size</option>
            <option value="complexity">Size by Complexity</option>
          </select>
          <select id="treemap-color">
            <option value="kind">Color by Depth</option>
            <option value="complexity">Color by Complexity</option>
            <option value="coupling">Color by Coupling</option>
          </select>
        </div>
      </div>
      <div class="panel-content" id="treemap-container"></div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>Circle Packing</h2>
        <div class="controls">
          <select id="circles-size">
            <option value="linesOfCode">Size by Lines</option>
            <option value="fileSize">Size by File Size</option>
            <option value="complexity">Size by Complexity</option>
          </select>
          <select id="circles-color">
            <option value="kind">Color by Depth</option>
            <option value="complexity">Color by Complexity</option>
            <option value="coupling">Color by Coupling</option>
          </select>
        </div>
      </div>
      <div class="panel-content" id="circles-container"></div>
    </section>
  </main>

  <main id="metrics-tab" class="main-content">
    <div style="flex: 1; padding: 0 1rem;">
      <div class="summary-cards">
        <div class="summary-card">
          <div class="label">Modules</div>
          <div class="value">${crateMetrics.totalModules}</div>
        </div>
        <div class="summary-card">
          <div class="label">Types</div>
          <div class="value">${crateMetrics.totalTypes}</div>
        </div>
        <div class="summary-card">
          <div class="label">Functions</div>
          <div class="value">${crateMetrics.totalFunctions}</div>
        </div>
        <div class="summary-card">
          <div class="label">Lines of Code</div>
          <div class="value">${crateMetrics.totalLines.toLocaleString()}</div>
        </div>
        <div class="summary-card">
          <div class="label">Avg Instability</div>
          <div class="value">${crateMetrics.averageInstability.toFixed(2)}</div>
        </div>
        <div class="summary-card">
          <div class="label">Cycles</div>
          <div class="value ${crateMetrics.cycleCount > 0 ? 'warning' : ''}">${crateMetrics.cycleCount}</div>
        </div>
      </div>

      <div class="panel" style="margin-bottom: 1rem;">
        <div class="panel-header">
          <h2>All Metrics</h2>
          <div class="controls">
            <input type="text" id="metrics-search" placeholder="Search..." style="padding: 0.25rem 0.5rem; border: 1px solid #ddd; border-radius: 4px;">
          </div>
        </div>
        <div class="panel-content" style="overflow-x: auto;">
          <table class="metrics-table" id="metrics-table">
            <thead>
              <tr>
                <th data-sort="name">Name</th>
                <th data-sort="kind">Kind</th>
                <th data-sort="ca">Ca</th>
                <th data-sort="ce">Ce</th>
                <th data-sort="instability">I</th>
                <th data-sort="abstractness">A</th>
                <th data-sort="distance">D</th>
                <th data-sort="fanIn">Fan In</th>
                <th data-sort="fanOut">Fan Out</th>
              </tr>
            </thead>
            <tbody id="metrics-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </main>

  <div class="context-menu" id="context-menu" style="display: none;">
    <div class="context-menu-item" data-action="hide">Hide</div>
    <div class="context-menu-item" data-action="focus">Focus (show only connected)</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-action="collapse">Collapse Group</div>
    <div class="context-menu-item" data-action="expand">Expand Group</div>
  </div>

  <script>
    // Data
    const dsmData = ${JSON.stringify({
      nodes: dsmData.nodes,
      matrix: dsmData.matrix,
      hierarchy: dsmData.hierarchy,
      cycles: dsmData.cycles.map((c) => ({ nodes: c.nodes })),
    })};

    const graphData = ${JSON.stringify(graphData)};
    const fileTreeData = ${JSON.stringify(fileTree)};
    const metricsData = new Map(${JSON.stringify(metricsArray)});

    // Event Bus for cross-component communication
    class EventBus {
      constructor() {
        this.listeners = new Map();
      }

      on(event, callback) {
        if (!this.listeners.has(event)) {
          this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
      }

      emit(event, data) {
        const callbacks = this.listeners.get(event) || [];
        callbacks.forEach(cb => cb(data));
      }
    }

    window.eventBus = new EventBus();

    ${dsmClientCode}
    ${graphClientCode}
    ${treemapClientCode}
    ${circlePackClientCode}

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.main-content').forEach(c => c.classList.remove('active'));

        tab.classList.add('active');
        document.getElementById(tab.dataset.tab + '-tab').classList.add('active');
      });
    });

    // Initialize visualizations
    let dsmMatrix, graphExplorer, treemapView, circlePackView;

    document.addEventListener('DOMContentLoaded', () => {
      dsmMatrix = new DsmMatrix('#dsm-container', dsmData, metricsData);
      graphExplorer = new GraphExplorer('#graph-container', graphData, metricsData);
      treemapView = new TreemapView('#treemap-container', fileTreeData);
      circlePackView = new CirclePackView('#circles-container', fileTreeData);

      // Setup controls
      document.getElementById('dsm-sort').addEventListener('change', (e) => {
        window.eventBus.emit('sort:change', { sortBy: e.target.value });
      });

      document.getElementById('graph-layout').addEventListener('change', (e) => {
        window.eventBus.emit('layout:change', { layout: e.target.value });
      });

      document.getElementById('graph-reset').addEventListener('click', () => {
        window.eventBus.emit('filter:reset');
      });

      document.getElementById('show-all-nodes').addEventListener('click', () => {
        window.eventBus.emit('filter:reset');
      });

      // Structure tab controls
      document.getElementById('treemap-size').addEventListener('change', (e) => {
        window.eventBus.emit('treemap:sizeBy', { sizeBy: e.target.value });
      });

      document.getElementById('treemap-color').addEventListener('change', (e) => {
        window.eventBus.emit('treemap:colorBy', { colorBy: e.target.value });
      });

      document.getElementById('circles-size').addEventListener('change', (e) => {
        window.eventBus.emit('circles:sizeBy', { sizeBy: e.target.value });
      });

      document.getElementById('circles-color').addEventListener('change', (e) => {
        window.eventBus.emit('circles:colorBy', { colorBy: e.target.value });
      });

      // Node filter list
      const filterList = document.getElementById('node-filter-list');
      dsmData.nodes.forEach(node => {
        const item = document.createElement('label');
        item.className = 'node-item';
        item.innerHTML = \`
          <input type="checkbox" checked data-node-id="\${node.id}">
          <span>\${node.name}</span>
        \`;
        item.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) {
            window.eventBus.emit('node:show', { nodeId: node.id });
          } else {
            window.eventBus.emit('node:hide', { nodeId: node.id });
          }
        });
        filterList.appendChild(item);
      });

      // Node search filter
      document.getElementById('node-search').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        filterList.querySelectorAll('.node-item').forEach(item => {
          const name = item.querySelector('span').textContent.toLowerCase();
          item.style.display = name.includes(query) ? 'flex' : 'none';
        });
      });

      // Details panel
      window.eventBus.on('node:selected', ({ nodeId }) => {
        const node = dsmData.nodes.find(n => n.id === nodeId);
        const metrics = metricsData.get(nodeId);
        const detailsPanel = document.getElementById('details-panel');

        if (node && metrics) {
          detailsPanel.innerHTML = \`
            <h3>\${node.name}</h3>
            <p style="font-size: 0.8rem; color: #666; margin-bottom: 1rem;">\${node.path}</p>
            <div class="metric-row">
              <span class="metric-label">Kind</span>
              <span class="kind-badge \${node.kind}">\${node.kind}</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Afferent Coupling (Ca)</span>
              <span class="metric-value">\${metrics.afferentCoupling}</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Efferent Coupling (Ce)</span>
              <span class="metric-value">\${metrics.efferentCoupling}</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Instability (I)</span>
              <span class="metric-value">\${metrics.instability.toFixed(2)}</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Abstractness (A)</span>
              <span class="metric-value">\${metrics.abstractness.toFixed(2)}</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Distance (D)</span>
              <span class="metric-value">\${metrics.distanceFromMainSequence.toFixed(2)}</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Fan In</span>
              <span class="metric-value">\${metrics.fanIn}</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Fan Out</span>
              <span class="metric-value">\${metrics.fanOut}</span>
            </div>
            \${metrics.inCycle ? '<p style="margin-top: 1rem; color: #e74c3c; font-weight: 500;">In dependency cycle</p>' : ''}
          \`;
        }
      });

      // Context menu
      const contextMenu = document.getElementById('context-menu');
      let contextNode = null;

      window.eventBus.on('contextmenu:show', ({ x, y, node }) => {
        contextNode = node;
        contextMenu.style.display = 'block';
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
      });

      document.addEventListener('click', () => {
        contextMenu.style.display = 'none';
      });

      contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
          if (!contextNode) return;

          switch (item.dataset.action) {
            case 'hide':
              window.eventBus.emit('node:hide', { nodeId: contextNode.id });
              break;
            case 'collapse':
              window.eventBus.emit('group:collapse', { groupId: contextNode.id });
              break;
            case 'expand':
              window.eventBus.emit('group:expand', { groupId: contextNode.id });
              break;
          }
        });
      });

      // Metrics table
      const tbody = document.getElementById('metrics-tbody');
      const rows = [];

      metricsData.forEach((metrics, id) => {
        rows.push({
          id,
          name: metrics.name,
          kind: metrics.kind,
          ca: metrics.afferentCoupling,
          ce: metrics.efferentCoupling,
          instability: metrics.instability,
          abstractness: metrics.abstractness,
          distance: metrics.distanceFromMainSequence,
          fanIn: metrics.fanIn,
          fanOut: metrics.fanOut
        });
      });

      function renderMetricsTable(data) {
        tbody.innerHTML = data.map(row => \`
          <tr>
            <td>\${row.name}</td>
            <td><span class="kind-badge \${row.kind}">\${row.kind}</span></td>
            <td>\${row.ca}</td>
            <td>\${row.ce}</td>
            <td>\${row.instability.toFixed(2)}</td>
            <td>\${row.abstractness.toFixed(2)}</td>
            <td>\${row.distance.toFixed(2)}</td>
            <td>\${row.fanIn}</td>
            <td>\${row.fanOut}</td>
          </tr>
        \`).join('');
      }

      renderMetricsTable(rows);

      // Table sorting
      let sortColumn = 'name';
      let sortAsc = true;

      document.querySelectorAll('.metrics-table th').forEach(th => {
        th.addEventListener('click', () => {
          const col = th.dataset.sort;
          if (col === sortColumn) {
            sortAsc = !sortAsc;
          } else {
            sortColumn = col;
            sortAsc = true;
          }

          const sorted = [...rows].sort((a, b) => {
            const va = a[col];
            const vb = b[col];
            if (typeof va === 'string') {
              return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
            }
            return sortAsc ? va - vb : vb - va;
          });

          renderMetricsTable(sorted);
        });
      });

      // Table search
      document.getElementById('metrics-search').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = rows.filter(row =>
          row.name.toLowerCase().includes(query) ||
          row.kind.toLowerCase().includes(query)
        );
        renderMetricsTable(filtered);
      });
    });
  </script>
</body>
</html>`;
}
