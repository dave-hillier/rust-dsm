export type DependencyType =
  | 'use_import'
  | 'type_reference'
  | 'function_call'
  | 'method_call'
  | 'trait_impl'
  | 'trait_bound'
  | 'field_type'
  | 'return_type'
  | 'parameter_type';

export type NodeKind = 'crate' | 'module' | 'struct' | 'enum' | 'trait' | 'function' | 'impl';

export interface DependencyEdge {
  from: string;
  to: string;
  depType: DependencyType;
  count: number;
  locations: EdgeLocation[];
}

export interface EdgeLocation {
  file: string;
  line: number;
  column: number;
}

export interface GraphNode {
  id: string;
  name: string;
  path: string;
  kind: NodeKind;
  parentId: string | null;
  filePath: string;
  line: number;
  children: string[];
}

export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
  edges: DependencyEdge[];
  adjacencyList: Map<string, Set<string>>;
  reverseAdjacencyList: Map<string, Set<string>>;
}

export interface DsmNode {
  id: string;
  name: string;
  path: string;
  depth: number;
  parentId: string | null;
  kind: NodeKind;
  isExpanded: boolean;
  childIds: string[];
}

export interface SparseCell {
  row: number;
  col: number;
  value: number;
  depTypes: DependencyType[];
  edges: DependencyEdge[];
}

export interface HierarchyGroup {
  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  depth: number;
}

export interface Cycle {
  nodes: string[];
  edges: DependencyEdge[];
}

export interface DsmData {
  nodes: DsmNode[];
  matrix: SparseCell[];
  hierarchy: HierarchyGroup[];
  cycles: Cycle[];
  nodeIndexMap: Map<string, number>;
}

export interface GraphViewNode {
  id: string;
  label: string;
  parent?: string;
  kind: NodeKind;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  children?: GraphViewNode[];
  _children?: GraphViewNode[];
  isGroup?: boolean;
  isHidden?: boolean;
}

export interface GraphViewLink {
  source: string | GraphViewNode;
  target: string | GraphViewNode;
  weight: number;
  depType: DependencyType;
}

export interface GraphViewData {
  nodes: GraphViewNode[];
  links: GraphViewLink[];
}

export interface FileNode {
  name: string;
  path: string;
  children?: FileNode[];
  linesOfCode?: number;
  fileSize?: number;
  complexity?: number;
  afferentCoupling?: number;
  efferentCoupling?: number;
}
