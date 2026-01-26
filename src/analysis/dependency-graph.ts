import type {
  CrateDefinition,
  ModuleDefinition,
  TypeReference,
  StructDef,
  EnumDef,
  TraitDef,
  FunctionDef,
  ImplBlock,
} from '../types/ast.js';
import type { DependencyGraph, GraphNode, DependencyEdge, DependencyType, NodeKind, EdgeLocation } from '../types/graph.js';
import { UseResolver } from '../parser/use-resolver.js';

export function buildDependencyGraph(crate: CrateDefinition): DependencyGraph {
  const builder = new DependencyGraphBuilder(crate);
  return builder.build();
}

class DependencyGraphBuilder {
  private nodes: Map<string, GraphNode> = new Map();
  private edgeMap: Map<string, DependencyEdge> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();
  private reverseAdjacencyList: Map<string, Set<string>> = new Map();
  private useResolver: UseResolver;
  private currentModule: string = '';

  constructor(private crate: CrateDefinition) {
    this.useResolver = new UseResolver(crate);
  }

  build(): DependencyGraph {
    this.buildNodes(this.crate.rootModule, null);

    this.processModule(this.crate.rootModule);

    return {
      nodes: this.nodes,
      edges: Array.from(this.edgeMap.values()),
      adjacencyList: this.adjacencyList,
      reverseAdjacencyList: this.reverseAdjacencyList,
    };
  }

  private buildNodes(module: ModuleDefinition, parentId: string | null): void {
    const moduleId = module.path;

    this.addNode({
      id: moduleId,
      name: module.name,
      path: module.path,
      kind: 'module',
      parentId,
      filePath: module.filePath,
      line: 1,
      children: [],
    });

    for (const struct of module.structs) {
      const structId = `${moduleId}::${struct.name}`;
      this.addNode({
        id: structId,
        name: struct.name,
        path: structId,
        kind: 'struct',
        parentId: moduleId,
        filePath: module.filePath,
        line: struct.span.start.line,
        children: [],
      });
      this.addChild(moduleId, structId);
    }

    for (const enumDef of module.enums) {
      const enumId = `${moduleId}::${enumDef.name}`;
      this.addNode({
        id: enumId,
        name: enumDef.name,
        path: enumId,
        kind: 'enum',
        parentId: moduleId,
        filePath: module.filePath,
        line: enumDef.span.start.line,
        children: [],
      });
      this.addChild(moduleId, enumId);
    }

    for (const trait of module.traits) {
      const traitId = `${moduleId}::${trait.name}`;
      this.addNode({
        id: traitId,
        name: trait.name,
        path: traitId,
        kind: 'trait',
        parentId: moduleId,
        filePath: module.filePath,
        line: trait.span.start.line,
        children: [],
      });
      this.addChild(moduleId, traitId);
    }

    for (const fn of module.functions) {
      const fnId = `${moduleId}::${fn.name}`;
      this.addNode({
        id: fnId,
        name: fn.name,
        path: fnId,
        kind: 'function',
        parentId: moduleId,
        filePath: module.filePath,
        line: fn.span.start.line,
        children: [],
      });
      this.addChild(moduleId, fnId);
    }

    for (const submodule of module.submodules) {
      this.buildNodes(submodule, moduleId);
      this.addChild(moduleId, submodule.path);
    }
  }

  private addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    this.adjacencyList.set(node.id, new Set());
    this.reverseAdjacencyList.set(node.id, new Set());
  }

  private addChild(parentId: string, childId: string): void {
    const parent = this.nodes.get(parentId);
    if (parent) {
      parent.children.push(childId);
    }
  }

  private processModule(module: ModuleDefinition): void {
    this.currentModule = module.path;
    this.useResolver.resolveUsesForModule(module);

    for (const use of module.uses) {
      this.processUse(module, use);
    }

    for (const struct of module.structs) {
      this.processStruct(module, struct);
    }

    for (const enumDef of module.enums) {
      this.processEnum(module, enumDef);
    }

    for (const trait of module.traits) {
      this.processTrait(module, trait);
    }

    for (const fn of module.functions) {
      this.processFunction(module, fn, module.path);
    }

    for (const impl of module.impls) {
      this.processImpl(module, impl);
    }

    for (const submodule of module.submodules) {
      this.processModule(submodule);
    }
  }

  private processUse(module: ModuleDefinition, use: import('../types/ast.js').UseDeclaration): void {
    const basePath = use.path.join('::');
    const fromId = module.path;

    if (use.items.length > 0) {
      for (const item of use.items) {
        const toPath = `${basePath}::${item.name}`;
        const toId = this.resolveToNodeId(toPath);
        if (toId) {
          this.addEdge(fromId, toId, 'use_import', module.filePath, use.span.start.line, use.span.start.column);
        }
      }
    } else if (!use.isGlob) {
      const toId = this.resolveToNodeId(basePath);
      if (toId) {
        this.addEdge(fromId, toId, 'use_import', module.filePath, use.span.start.line, use.span.start.column);
      }
    }
  }

  private processStruct(module: ModuleDefinition, struct: StructDef): void {
    const structId = `${module.path}::${struct.name}`;

    for (const field of struct.fields) {
      this.processTypeRef(structId, field.typeRef, 'field_type', module.filePath);
    }

    for (const generic of struct.generics) {
      for (const bound of generic.bounds) {
        this.processTypeRef(structId, bound, 'trait_bound', module.filePath);
      }
    }
  }

  private processEnum(module: ModuleDefinition, enumDef: EnumDef): void {
    const enumId = `${module.path}::${enumDef.name}`;

    for (const variant of enumDef.variants) {
      for (const field of variant.fields) {
        this.processTypeRef(enumId, field.typeRef, 'field_type', module.filePath);
      }
    }

    for (const generic of enumDef.generics) {
      for (const bound of generic.bounds) {
        this.processTypeRef(enumId, bound, 'trait_bound', module.filePath);
      }
    }
  }

  private processTrait(module: ModuleDefinition, trait: TraitDef): void {
    const traitId = `${module.path}::${trait.name}`;

    for (const supertrait of trait.supertraits) {
      this.processTypeRef(traitId, supertrait, 'trait_bound', module.filePath);
    }

    for (const method of trait.methods) {
      this.processFunction(module, method, traitId);
    }
  }

  private processFunction(module: ModuleDefinition, fn: FunctionDef, parentId: string): void {
    const fnId = parentId === module.path ? `${module.path}::${fn.name}` : `${parentId}::${fn.name}`;

    for (const param of fn.params) {
      if (!param.isSelf) {
        this.processTypeRef(fnId, param.typeRef, 'parameter_type', module.filePath);
      }
    }

    if (fn.returnType) {
      this.processTypeRef(fnId, fn.returnType, 'return_type', module.filePath);
    }

    for (const generic of fn.generics) {
      for (const bound of generic.bounds) {
        this.processTypeRef(fnId, bound, 'trait_bound', module.filePath);
      }
    }

    for (const callsite of fn.bodyCallsites) {
      const depType: DependencyType = callsite.isMethodCall ? 'method_call' : 'function_call';
      const targetId = this.resolveFunctionCall(callsite.functionPath);
      if (targetId) {
        this.addEdge(fnId, targetId, depType, module.filePath, callsite.span.start.line, callsite.span.start.column);
      }
    }
  }

  private processImpl(module: ModuleDefinition, impl: ImplBlock): void {
    const selfTypeId = this.resolveTypeRefToNodeId(impl.selfType);

    if (impl.traitRef && selfTypeId) {
      const traitId = this.resolveTypeRefToNodeId(impl.traitRef);
      if (traitId) {
        this.addEdge(selfTypeId, traitId, 'trait_impl', module.filePath, impl.span.start.line, impl.span.start.column);
      }
    }

    for (const method of impl.methods) {
      if (selfTypeId) {
        this.processFunction(module, method, selfTypeId);
      }
    }
  }

  private processTypeRef(fromId: string, typeRef: TypeReference, depType: DependencyType, filePath: string): void {
    const toId = this.resolveTypeRefToNodeId(typeRef);
    if (toId && toId !== fromId) {
      this.addEdge(fromId, toId, depType, filePath, typeRef.span.start.line, typeRef.span.start.column);
    }

    for (const param of typeRef.typeParameters) {
      this.processTypeRef(fromId, param, depType, filePath);
    }
  }

  private resolveTypeRefToNodeId(typeRef: TypeReference): string | null {
    const name = typeRef.name;

    if (this.isPrimitive(name) || this.isStdType(name)) {
      return null;
    }

    const resolved = this.useResolver.resolveTypeReference(typeRef, this.currentModule);
    if (resolved && this.nodes.has(resolved)) {
      return resolved;
    }

    const localPath = `${this.currentModule}::${name}`;
    if (this.nodes.has(localPath)) {
      return localPath;
    }

    const cratePath = `crate::${name}`;
    if (this.nodes.has(cratePath)) {
      return cratePath;
    }

    for (const nodeId of this.nodes.keys()) {
      if (nodeId.endsWith(`::${name}`)) {
        return nodeId;
      }
    }

    return null;
  }

  private resolveToNodeId(path: string): string | null {
    let normalizedPath = path;
    if (!path.startsWith('crate::') && !path.startsWith('std::') && !path.startsWith('core::')) {
      normalizedPath = `crate::${path}`;
    }

    if (this.nodes.has(normalizedPath)) {
      return normalizedPath;
    }

    if (this.nodes.has(path)) {
      return path;
    }

    return null;
  }

  private resolveFunctionCall(callPath: string): string | null {
    const localPath = `${this.currentModule}::${callPath}`;
    if (this.nodes.has(localPath)) {
      return localPath;
    }

    const cratePath = `crate::${callPath}`;
    if (this.nodes.has(cratePath)) {
      return cratePath;
    }

    for (const nodeId of this.nodes.keys()) {
      if (nodeId.endsWith(`::${callPath}`)) {
        return nodeId;
      }
    }

    return null;
  }

  private addEdge(
    fromId: string,
    toId: string,
    depType: DependencyType,
    file: string,
    line: number,
    column: number
  ): void {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) {
      return;
    }

    const edgeKey = `${fromId}|${toId}|${depType}`;
    const location: EdgeLocation = { file, line, column };

    if (this.edgeMap.has(edgeKey)) {
      const edge = this.edgeMap.get(edgeKey)!;
      edge.count++;
      edge.locations.push(location);
    } else {
      this.edgeMap.set(edgeKey, {
        from: fromId,
        to: toId,
        depType,
        count: 1,
        locations: [location],
      });
    }

    this.adjacencyList.get(fromId)?.add(toId);
    this.reverseAdjacencyList.get(toId)?.add(fromId);
  }

  private isPrimitive(name: string): boolean {
    const primitives = new Set([
      'bool',
      'char',
      'str',
      'u8',
      'u16',
      'u32',
      'u64',
      'u128',
      'usize',
      'i8',
      'i16',
      'i32',
      'i64',
      'i128',
      'isize',
      'f32',
      'f64',
      '()',
    ]);
    return primitives.has(name) || name.startsWith('&');
  }

  private isStdType(name: string): boolean {
    const stdTypes = new Set([
      'String',
      'Vec',
      'Option',
      'Result',
      'Box',
      'Rc',
      'Arc',
      'Cell',
      'RefCell',
      'Mutex',
      'RwLock',
      'HashMap',
      'HashSet',
      'BTreeMap',
      'BTreeSet',
      'VecDeque',
      'LinkedList',
      'BinaryHeap',
      'Cow',
      'PhantomData',
    ]);
    return stdTypes.has(name);
  }
}

export function aggregateToModuleLevel(graph: DependencyGraph): DependencyGraph {
  const moduleNodes = new Map<string, GraphNode>();
  const moduleEdges: DependencyEdge[] = [];
  const edgeMap = new Map<string, DependencyEdge>();

  for (const [id, node] of graph.nodes) {
    if (node.kind === 'module') {
      moduleNodes.set(id, { ...node, children: [] });
    }
  }

  for (const edge of graph.edges) {
    const fromModule = getModulePath(edge.from, graph);
    const toModule = getModulePath(edge.to, graph);

    if (fromModule && toModule && fromModule !== toModule) {
      const key = `${fromModule}|${toModule}`;
      if (edgeMap.has(key)) {
        const existing = edgeMap.get(key)!;
        existing.count += edge.count;
        existing.locations.push(...edge.locations);
      } else {
        edgeMap.set(key, {
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

  for (const edge of edgeMap.values()) {
    moduleEdges.push(edge);
    adjacencyList.get(edge.from)?.add(edge.to);
    reverseAdjacencyList.get(edge.to)?.add(edge.from);
  }

  return {
    nodes: moduleNodes,
    edges: moduleEdges,
    adjacencyList,
    reverseAdjacencyList,
  };
}

function getModulePath(nodeId: string, graph: DependencyGraph): string | null {
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
