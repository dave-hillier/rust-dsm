import type { NodeKind, Cycle } from './graph.js';

export interface NodeMetrics {
  id: string;
  name: string;
  path: string;
  kind: NodeKind;

  afferentCoupling: number;
  efferentCoupling: number;
  instability: number;

  abstractness: number;
  distanceFromMainSequence: number;

  fanIn: number;
  fanOut: number;

  linesOfCode: number;
  complexity: number;

  inCycle: boolean;
  cycleId: number | null;
}

export interface ModuleMetrics extends NodeMetrics {
  totalTypes: number;
  totalTraits: number;
  totalFunctions: number;
  publicItems: number;
  privateItems: number;
}

export interface CrateMetrics {
  name: string;
  totalModules: number;
  totalTypes: number;
  totalFunctions: number;
  totalLines: number;

  averageInstability: number;
  averageAbstractness: number;
  averageDistance: number;

  cycleCount: number;
  cycles: Cycle[];

  mostCoupled: NodeMetrics[];
  mostUnstable: NodeMetrics[];
  highestDistance: NodeMetrics[];
}

export interface MetricsReport {
  generated: string;
  crateName: string;
  crateMetrics: CrateMetrics;
  moduleMetrics: Map<string, ModuleMetrics>;
  nodeMetrics: Map<string, NodeMetrics>;
}

export interface MetricsSummary {
  totalNodes: number;
  totalEdges: number;
  totalCycles: number;
  avgInstability: number;
  avgAbstractness: number;
  avgDistance: number;
  maxFanIn: number;
  maxFanOut: number;
}
