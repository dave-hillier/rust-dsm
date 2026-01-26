import type { DependencyGraph, Cycle, DependencyEdge } from '../types/graph.js';

export function detectCycles(graph: DependencyGraph): Cycle[] {
  const detector = new TarjanSCC(graph);
  return detector.findCycles();
}

class TarjanSCC {
  private graph: DependencyGraph;
  private index = 0;
  private stack: string[] = [];
  private onStack: Set<string> = new Set();
  private indices: Map<string, number> = new Map();
  private lowLinks: Map<string, number> = new Map();
  private sccs: string[][] = [];

  constructor(graph: DependencyGraph) {
    this.graph = graph;
  }

  findCycles(): Cycle[] {
    for (const nodeId of this.graph.nodes.keys()) {
      if (!this.indices.has(nodeId)) {
        this.strongConnect(nodeId);
      }
    }

    const cycles: Cycle[] = [];
    for (const scc of this.sccs) {
      if (scc.length > 1) {
        cycles.push(this.buildCycle(scc));
      } else if (scc.length === 1) {
        const nodeId = scc[0];
        const neighbors = this.graph.adjacencyList.get(nodeId);
        if (neighbors?.has(nodeId)) {
          cycles.push(this.buildCycle(scc));
        }
      }
    }

    return cycles;
  }

  private strongConnect(nodeId: string): void {
    this.indices.set(nodeId, this.index);
    this.lowLinks.set(nodeId, this.index);
    this.index++;
    this.stack.push(nodeId);
    this.onStack.add(nodeId);

    const neighbors = this.graph.adjacencyList.get(nodeId) ?? new Set();
    for (const neighbor of neighbors) {
      if (!this.indices.has(neighbor)) {
        this.strongConnect(neighbor);
        this.lowLinks.set(nodeId, Math.min(this.lowLinks.get(nodeId)!, this.lowLinks.get(neighbor)!));
      } else if (this.onStack.has(neighbor)) {
        this.lowLinks.set(nodeId, Math.min(this.lowLinks.get(nodeId)!, this.indices.get(neighbor)!));
      }
    }

    if (this.lowLinks.get(nodeId) === this.indices.get(nodeId)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = this.stack.pop()!;
        this.onStack.delete(w);
        scc.push(w);
      } while (w !== nodeId);
      this.sccs.push(scc);
    }
  }

  private buildCycle(nodes: string[]): Cycle {
    const nodeSet = new Set(nodes);
    const edges: DependencyEdge[] = [];

    for (const edge of this.graph.edges) {
      if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
        edges.push(edge);
      }
    }

    return { nodes, edges };
  }
}

export function findAllPaths(
  graph: DependencyGraph,
  from: string,
  to: string,
  maxDepth = 10
): string[][] {
  const paths: string[][] = [];
  const visited = new Set<string>();

  function dfs(current: string, path: string[]): void {
    if (path.length > maxDepth) return;
    if (current === to) {
      paths.push([...path]);
      return;
    }

    visited.add(current);
    const neighbors = graph.adjacencyList.get(current) ?? new Set();

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        path.push(neighbor);
        dfs(neighbor, path);
        path.pop();
      }
    }

    visited.delete(current);
  }

  dfs(from, [from]);
  return paths;
}

export function getNodesInCycles(cycles: Cycle[]): Set<string> {
  const nodesInCycles = new Set<string>();
  for (const cycle of cycles) {
    for (const node of cycle.nodes) {
      nodesInCycles.add(node);
    }
  }
  return nodesInCycles;
}

export function getCycleForNode(nodeId: string, cycles: Cycle[]): Cycle | null {
  for (const cycle of cycles) {
    if (cycle.nodes.includes(nodeId)) {
      return cycle;
    }
  }
  return null;
}

export function sortCyclesBySize(cycles: Cycle[]): Cycle[] {
  return [...cycles].sort((a, b) => b.nodes.length - a.nodes.length);
}

export function detectModuleLevelCycles(graph: DependencyGraph): Cycle[] {
  const moduleGraph = aggregateToModules(graph);
  return detectCycles(moduleGraph);
}

function aggregateToModules(graph: DependencyGraph): DependencyGraph {
  const moduleNodes = new Map<string, import('../types/graph.js').GraphNode>();
  const moduleEdgeMap = new Map<string, DependencyEdge>();

  for (const [id, node] of graph.nodes) {
    if (node.kind === 'module') {
      moduleNodes.set(id, { ...node });
    }
  }

  for (const edge of graph.edges) {
    const fromModule = findAncestorModule(edge.from, graph);
    const toModule = findAncestorModule(edge.to, graph);

    if (fromModule && toModule && fromModule !== toModule) {
      const key = `${fromModule}|${toModule}`;
      if (moduleEdgeMap.has(key)) {
        moduleEdgeMap.get(key)!.count += edge.count;
      } else {
        moduleEdgeMap.set(key, {
          from: fromModule,
          to: toModule,
          depType: edge.depType,
          count: edge.count,
          locations: [...edge.locations],
        });
      }
    }
  }

  const adjacencyList = new Map<string, Set<string>>();
  const reverseAdjacencyList = new Map<string, Set<string>>();

  for (const id of moduleNodes.keys()) {
    adjacencyList.set(id, new Set());
    reverseAdjacencyList.set(id, new Set());
  }

  for (const edge of moduleEdgeMap.values()) {
    adjacencyList.get(edge.from)?.add(edge.to);
    reverseAdjacencyList.get(edge.to)?.add(edge.from);
  }

  return {
    nodes: moduleNodes,
    edges: Array.from(moduleEdgeMap.values()),
    adjacencyList,
    reverseAdjacencyList,
  };
}

function findAncestorModule(nodeId: string, graph: DependencyGraph): string | null {
  let current = graph.nodes.get(nodeId);
  while (current) {
    if (current.kind === 'module') {
      return current.id;
    }
    if (current.parentId) {
      current = graph.nodes.get(current.parentId);
    } else {
      break;
    }
  }
  return null;
}
