import { readFileSync } from 'fs';
import type { CrateDefinition, ModuleDefinition } from '../types/ast.js';
import type { DependencyGraph, Cycle } from '../types/graph.js';
import type { NodeMetrics, ModuleMetrics, CrateMetrics, MetricsReport } from '../types/metrics.js';
import { getNodesInCycles, getCycleForNode } from './cycle-detector.js';

export function calculateMetrics(
  graph: DependencyGraph,
  crate: CrateDefinition,
  cycles: Cycle[]
): MetricsReport {
  const calculator = new MetricsCalculator(graph, crate, cycles);
  return calculator.calculate();
}

class MetricsCalculator {
  private nodesInCycles: Set<string>;
  private cycleMap: Map<string, number> = new Map();

  constructor(
    private graph: DependencyGraph,
    private crate: CrateDefinition,
    private cycles: Cycle[]
  ) {
    this.nodesInCycles = getNodesInCycles(cycles);
    this.buildCycleMap();
  }

  private buildCycleMap(): void {
    this.cycles.forEach((cycle, index) => {
      for (const nodeId of cycle.nodes) {
        this.cycleMap.set(nodeId, index);
      }
    });
  }

  calculate(): MetricsReport {
    const nodeMetrics = new Map<string, NodeMetrics>();
    const moduleMetrics = new Map<string, ModuleMetrics>();

    for (const [id, node] of this.graph.nodes) {
      const metrics = this.calculateNodeMetrics(id);
      nodeMetrics.set(id, metrics);

      if (node.kind === 'module') {
        const modMetrics = this.calculateModuleMetrics(id, metrics);
        moduleMetrics.set(id, modMetrics);
      }
    }

    const crateMetrics = this.calculateCrateMetrics(nodeMetrics, moduleMetrics);

    return {
      generated: new Date().toISOString(),
      crateName: this.crate.name,
      crateMetrics,
      moduleMetrics,
      nodeMetrics,
    };
  }

  private calculateNodeMetrics(nodeId: string): NodeMetrics {
    const node = this.graph.nodes.get(nodeId)!;

    const afferentCoupling = this.graph.reverseAdjacencyList.get(nodeId)?.size ?? 0;
    const efferentCoupling = this.graph.adjacencyList.get(nodeId)?.size ?? 0;

    const totalCoupling = afferentCoupling + efferentCoupling;
    const instability = totalCoupling === 0 ? 0 : efferentCoupling / totalCoupling;

    const abstractness = node.kind === 'trait' ? 1 : 0;
    const distanceFromMainSequence = Math.abs(abstractness + instability - 1);

    const fanIn = this.calculateFanIn(nodeId);
    const fanOut = this.calculateFanOut(nodeId);

    const linesOfCode = this.estimateLinesOfCode(nodeId);
    const complexity = this.estimateComplexity(nodeId);

    const inCycle = this.nodesInCycles.has(nodeId);
    const cycleId = this.cycleMap.get(nodeId) ?? null;

    return {
      id: nodeId,
      name: node.name,
      path: node.path,
      kind: node.kind,
      afferentCoupling,
      efferentCoupling,
      instability,
      abstractness,
      distanceFromMainSequence,
      fanIn,
      fanOut,
      linesOfCode,
      complexity,
      inCycle,
      cycleId,
    };
  }

  private calculateModuleMetrics(moduleId: string, baseMetrics: NodeMetrics): ModuleMetrics {
    const module = this.findModule(this.crate.rootModule, moduleId);
    if (!module) {
      return {
        ...baseMetrics,
        totalTypes: 0,
        totalTraits: 0,
        totalFunctions: 0,
        publicItems: 0,
        privateItems: 0,
      };
    }

    const totalTypes = module.structs.length + module.enums.length + module.typeAliases.length;
    const totalTraits = module.traits.length;
    const totalFunctions = module.functions.length;

    let publicItems = 0;
    let privateItems = 0;

    for (const struct of module.structs) {
      if (struct.visibility.kind === 'public') publicItems++;
      else privateItems++;
    }
    for (const enumDef of module.enums) {
      if (enumDef.visibility.kind === 'public') publicItems++;
      else privateItems++;
    }
    for (const trait of module.traits) {
      if (trait.visibility.kind === 'public') publicItems++;
      else privateItems++;
    }
    for (const fn of module.functions) {
      if (fn.visibility.kind === 'public') publicItems++;
      else privateItems++;
    }

    const abstractness =
      totalTypes + totalTraits === 0 ? 0 : totalTraits / (totalTypes + totalTraits);

    const distanceFromMainSequence = Math.abs(abstractness + baseMetrics.instability - 1);

    return {
      ...baseMetrics,
      abstractness,
      distanceFromMainSequence,
      totalTypes,
      totalTraits,
      totalFunctions,
      publicItems,
      privateItems,
    };
  }

  private calculateCrateMetrics(
    nodeMetrics: Map<string, NodeMetrics>,
    moduleMetrics: Map<string, ModuleMetrics>
  ): CrateMetrics {
    let totalModules = 0;
    let totalTypes = 0;
    let totalFunctions = 0;
    let totalLines = 0;
    let instabilitySum = 0;
    let abstractnessSum = 0;
    let distanceSum = 0;
    let moduleCount = 0;

    for (const [_, metrics] of moduleMetrics) {
      totalModules++;
      totalTypes += metrics.totalTypes + metrics.totalTraits;
      totalFunctions += metrics.totalFunctions;
      totalLines += metrics.linesOfCode;
      instabilitySum += metrics.instability;
      abstractnessSum += metrics.abstractness;
      distanceSum += metrics.distanceFromMainSequence;
      moduleCount++;
    }

    const mostCoupled = this.getTopMetrics(nodeMetrics, (m) => m.afferentCoupling + m.efferentCoupling, 10);
    const mostUnstable = this.getTopMetrics(nodeMetrics, (m) => m.instability, 10);
    const highestDistance = this.getTopMetrics(nodeMetrics, (m) => m.distanceFromMainSequence, 10);

    return {
      name: this.crate.name,
      totalModules,
      totalTypes,
      totalFunctions,
      totalLines,
      averageInstability: moduleCount === 0 ? 0 : instabilitySum / moduleCount,
      averageAbstractness: moduleCount === 0 ? 0 : abstractnessSum / moduleCount,
      averageDistance: moduleCount === 0 ? 0 : distanceSum / moduleCount,
      cycleCount: this.cycles.length,
      cycles: this.cycles,
      mostCoupled,
      mostUnstable,
      highestDistance,
    };
  }

  private getTopMetrics(
    metrics: Map<string, NodeMetrics>,
    getValue: (m: NodeMetrics) => number,
    limit: number
  ): NodeMetrics[] {
    return Array.from(metrics.values())
      .filter((m) => m.kind !== 'module')
      .sort((a, b) => getValue(b) - getValue(a))
      .slice(0, limit);
  }

  private calculateFanIn(nodeId: string): number {
    let count = 0;
    for (const edge of this.graph.edges) {
      if (edge.to === nodeId) {
        count += edge.count;
      }
    }
    return count;
  }

  private calculateFanOut(nodeId: string): number {
    let count = 0;
    for (const edge of this.graph.edges) {
      if (edge.from === nodeId) {
        count += edge.count;
      }
    }
    return count;
  }

  private estimateLinesOfCode(nodeId: string): number {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return 0;

    if (node.kind === 'module') {
      try {
        const content = readFileSync(node.filePath, 'utf-8');
        return content.split('\n').length;
      } catch {
        return 0;
      }
    }

    return 10;
  }

  private estimateComplexity(nodeId: string): number {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return 0;

    if (node.kind === 'function') {
      const fanOut = this.calculateFanOut(nodeId);
      return 1 + fanOut;
    }

    return 1;
  }

  private findModule(module: ModuleDefinition, targetPath: string): ModuleDefinition | null {
    if (module.path === targetPath) {
      return module;
    }

    for (const submodule of module.submodules) {
      const found = this.findModule(submodule, targetPath);
      if (found) return found;
    }

    return null;
  }
}

export function getMetricsSummary(report: MetricsReport): {
  totalNodes: number;
  totalEdges: number;
  avgCoupling: number;
  avgInstability: number;
  nodesInCycles: number;
} {
  let totalCoupling = 0;
  let totalInstability = 0;
  let nodesInCycles = 0;
  let count = 0;

  for (const [_, metrics] of report.nodeMetrics) {
    totalCoupling += metrics.afferentCoupling + metrics.efferentCoupling;
    totalInstability += metrics.instability;
    if (metrics.inCycle) nodesInCycles++;
    count++;
  }

  return {
    totalNodes: report.nodeMetrics.size,
    totalEdges: 0,
    avgCoupling: count === 0 ? 0 : totalCoupling / count,
    avgInstability: count === 0 ? 0 : totalInstability / count,
    nodesInCycles,
  };
}
