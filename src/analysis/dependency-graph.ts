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

export function buildWorkspaceGraph(crates: CrateDefinition[]): DependencyGraph {
  const builder = new WorkspaceGraphBuilder(crates);
  return builder.build();
}

class WorkspaceGraphBuilder {
  private nodes: Map<string, GraphNode> = new Map();
  private edgeMap: Map<string, DependencyEdge> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();
  private reverseAdjacencyList: Map<string, Set<string>> = new Map();
  private crateBuilders: Map<string, DependencyGraphBuilder> = new Map();

  constructor(private crates: CrateDefinition[]) {}

  build(): DependencyGraph {
    // Build graphs for each crate, prefixing node IDs with crate name
    for (const crate of this.crates) {
      const builder = new DependencyGraphBuilder(crate, crate.name);
      const crateGraph = builder.build();
      this.crateBuilders.set(crate.name, builder);

      // Merge nodes
      for (const [id, node] of crateGraph.nodes) {
        this.nodes.set(id, node);
        this.adjacencyList.set(id, new Set());
        this.reverseAdjacencyList.set(id, new Set());
      }

      // Merge edges
      for (const edge of crateGraph.edges) {
        const edgeKey = `${edge.from}|${edge.to}|${edge.depType}`;
        this.edgeMap.set(edgeKey, edge);
        this.adjacencyList.get(edge.from)?.add(edge.to);
        this.reverseAdjacencyList.get(edge.to)?.add(edge.from);
      }
    }

    // Resolve inter-crate dependencies
    this.resolveInterCrateDependencies();

    return {
      nodes: this.nodes,
      edges: Array.from(this.edgeMap.values()),
      adjacencyList: this.adjacencyList,
      reverseAdjacencyList: this.reverseAdjacencyList,
    };
  }

  private resolveInterCrateDependencies(): void {
    // Build a map of type names to their full node IDs across all crates
    const typeNameToNodeId = new Map<string, string[]>();

    for (const [nodeId, node] of this.nodes) {
      const name = node.name;
      if (!typeNameToNodeId.has(name)) {
        typeNameToNodeId.set(name, []);
      }
      typeNameToNodeId.get(name)!.push(nodeId);
    }

    // Build a map of what each crate imports from other crates
    const crateImports = new Map<string, Map<string, string>>();
    for (const crate of this.crates) {
      const imports = new Map<string, string>();
      this.collectCrateImports(crate.rootModule, crate.name, imports, typeNameToNodeId);
      crateImports.set(crate.name, imports);
    }

    // Process all modules for inter-crate type references
    for (const crate of this.crates) {
      const imports = crateImports.get(crate.name) || new Map();
      this.processModuleTypeRefs(crate.rootModule, crate.name, imports, typeNameToNodeId);
    }
  }

  private collectCrateImports(
    module: ModuleDefinition,
    currentCrate: string,
    imports: Map<string, string>,
    typeNameToNodeId: Map<string, string[]>
  ): void {
    // Build a map of normalized crate names (underscores) to actual crate names (hyphens)
    const crateNameMap = new Map<string, string>();
    for (const crate of this.crates) {
      // Rust converts hyphens to underscores in use statements
      const normalizedName = crate.name.replace(/-/g, '_');
      crateNameMap.set(normalizedName, crate.name);
    }

    // Collect imports from use statements
    for (const use of module.uses) {
      const firstSegment = use.path[0];
      // Check if this is an external crate reference
      if (firstSegment !== 'crate' && firstSegment !== 'self' && firstSegment !== 'super' &&
          firstSegment !== 'std' && firstSegment !== 'core' && firstSegment !== 'alloc') {

        // Convert underscore crate name to hyphen version if it's a workspace crate
        const actualCrateName = crateNameMap.get(firstSegment) || firstSegment;

        // Skip if not a workspace crate
        if (!crateNameMap.has(firstSegment) && !this.crates.some(c => c.name === firstSegment)) {
          continue;
        }

        // Get the module ID for creating edges
        const moduleId = `${currentCrate}::${module.path}`;

        if (use.items.length > 0) {
          for (const item of use.items) {
            const itemName = item.alias || item.name;
            // Find the node in the target crate
            const candidates = typeNameToNodeId.get(item.name) || [];
            const targetNode = candidates.find(id => id.startsWith(`${actualCrateName}::`));
            if (targetNode) {
              imports.set(itemName, targetNode);
              // Also create a use_import edge from this module to the target
              if (this.nodes.has(moduleId)) {
                this.addEdge(moduleId, targetNode, 'use_import', module.filePath, use.span.start.line, use.span.start.column);
              }
            }
          }
        } else if (!use.isGlob && use.path.length > 1) {
          const lastName = use.path[use.path.length - 1];
          const candidates = typeNameToNodeId.get(lastName) || [];
          const targetNode = candidates.find(id => id.startsWith(`${actualCrateName}::`));
          if (targetNode) {
            imports.set(lastName, targetNode);
            // Also create a use_import edge from this module to the target
            if (this.nodes.has(moduleId)) {
              this.addEdge(moduleId, targetNode, 'use_import', module.filePath, use.span.start.line, use.span.start.column);
            }
          }
        }
      }
    }

    for (const submodule of module.submodules) {
      this.collectCrateImports(submodule, currentCrate, imports, typeNameToNodeId);
    }
  }

  private processModuleTypeRefs(
    module: ModuleDefinition,
    currentCrate: string,
    imports: Map<string, string>,
    typeNameToNodeId: Map<string, string[]>
  ): void {
    // Process structs
    for (const struct of module.structs) {
      const structId = `${currentCrate}::${module.path}::${struct.name}`;
      for (const field of struct.fields) {
        this.resolveExternalTypeRef(structId, field.typeRef, imports, typeNameToNodeId, currentCrate, module.filePath);
      }
    }

    // Process enums
    for (const enumDef of module.enums) {
      const enumId = `${currentCrate}::${module.path}::${enumDef.name}`;
      for (const variant of enumDef.variants) {
        for (const field of variant.fields) {
          this.resolveExternalTypeRef(enumId, field.typeRef, imports, typeNameToNodeId, currentCrate, module.filePath);
        }
      }
    }

    // Process functions
    for (const fn of module.functions) {
      const fnId = `${currentCrate}::${module.path}::${fn.name}`;
      for (const param of fn.params) {
        if (!param.isSelf) {
          this.resolveExternalTypeRef(fnId, param.typeRef, imports, typeNameToNodeId, currentCrate, module.filePath);
        }
      }
      if (fn.returnType) {
        this.resolveExternalTypeRef(fnId, fn.returnType, imports, typeNameToNodeId, currentCrate, module.filePath);
      }
    }

    // Process impl blocks
    for (const impl of module.impls) {
      const selfTypeName = impl.selfType.name;
      const selfTypeId = this.findNodeInCurrentCrate(currentCrate, selfTypeName);

      if (selfTypeId && impl.traitRef) {
        // Check if trait is from another crate
        const traitName = impl.traitRef.name;
        const targetTraitId = imports.get(traitName);
        if (targetTraitId && this.nodes.has(selfTypeId)) {
          this.addEdge(selfTypeId, targetTraitId, 'trait_impl', module.filePath, impl.span.start.line, impl.span.start.column);
        }
      }

      // Process impl methods
      if (selfTypeId) {
        for (const method of impl.methods) {
          const methodId = `${selfTypeId}::${method.name}`;
          for (const param of method.params) {
            if (!param.isSelf) {
              this.resolveExternalTypeRef(methodId, param.typeRef, imports, typeNameToNodeId, currentCrate, module.filePath);
            }
          }
          if (method.returnType) {
            this.resolveExternalTypeRef(methodId, method.returnType, imports, typeNameToNodeId, currentCrate, module.filePath);
          }
        }
      }
    }

    // Process traits
    for (const trait of module.traits) {
      const traitId = `${currentCrate}::${module.path}::${trait.name}`;
      for (const method of trait.methods) {
        for (const param of method.params) {
          if (!param.isSelf) {
            this.resolveExternalTypeRef(traitId, param.typeRef, imports, typeNameToNodeId, currentCrate, module.filePath);
          }
        }
        if (method.returnType) {
          this.resolveExternalTypeRef(traitId, method.returnType, imports, typeNameToNodeId, currentCrate, module.filePath);
        }
      }
    }

    for (const submodule of module.submodules) {
      this.processModuleTypeRefs(submodule, currentCrate, imports, typeNameToNodeId);
    }
  }

  private resolveExternalTypeRef(
    fromId: string,
    typeRef: TypeReference,
    imports: Map<string, string>,
    typeNameToNodeId: Map<string, string[]>,
    currentCrate: string,
    filePath: string
  ): void {
    const typeName = typeRef.name;

    // Skip primitives and std types
    if (this.isPrimitive(typeName) || this.isStdType(typeName)) {
      return;
    }

    // Check if this type was imported from another crate
    const importedId = imports.get(typeName);
    if (importedId && this.nodes.has(fromId) && this.nodes.has(importedId)) {
      // Don't create edge if it's within the same crate
      if (!importedId.startsWith(`${currentCrate}::`)) {
        this.addEdge(fromId, importedId, 'field_type', filePath, typeRef.span.start.line, typeRef.span.start.column);
      }
    }

    // Process type parameters recursively
    for (const param of typeRef.typeParameters) {
      this.resolveExternalTypeRef(fromId, param, imports, typeNameToNodeId, currentCrate, filePath);
    }
  }

  private findNodeInCurrentCrate(crateName: string, typeName: string): string | null {
    for (const nodeId of this.nodes.keys()) {
      if (nodeId.startsWith(`${crateName}::`) && nodeId.endsWith(`::${typeName}`)) {
        return nodeId;
      }
    }
    return null;
  }

  private isPrimitive(name: string): boolean {
    const primitives = new Set([
      'bool', 'char', 'str', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
      'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'f32', 'f64', '()',
    ]);
    return primitives.has(name) || name.startsWith('&');
  }

  private isStdType(name: string): boolean {
    const stdTypes = new Set([
      'String', 'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'Cell',
      'RefCell', 'Mutex', 'RwLock', 'HashMap', 'HashSet', 'BTreeMap',
      'BTreeSet', 'VecDeque', 'LinkedList', 'BinaryHeap', 'Cow', 'PhantomData',
    ]);
    return stdTypes.has(name);
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
}

class DependencyGraphBuilder {
  private nodes: Map<string, GraphNode> = new Map();
  private edgeMap: Map<string, DependencyEdge> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();
  private reverseAdjacencyList: Map<string, Set<string>> = new Map();
  private useResolver: UseResolver;
  private currentModule: string = '';
  private cratePrefix: string;

  constructor(private crate: CrateDefinition, cratePrefix?: string) {
    this.useResolver = new UseResolver(crate);
    this.cratePrefix = cratePrefix ?? '';
  }

  private prefixId(id: string): string {
    if (this.cratePrefix && !id.startsWith(this.cratePrefix + '::')) {
      return `${this.cratePrefix}::${id}`;
    }
    return id;
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
    const moduleId = this.prefixId(module.path);
    const prefixedParentId = parentId ? this.prefixId(parentId) : null;

    // Use crate name for root module when in workspace mode
    const displayName = (module.name === 'crate' && this.cratePrefix)
      ? this.cratePrefix
      : module.name;

    this.addNode({
      id: moduleId,
      name: displayName,
      path: module.path,
      kind: 'module',
      parentId: prefixedParentId,
      filePath: module.filePath,
      line: 1,
      children: [],
    });

    for (const struct of module.structs) {
      const structId = this.prefixId(`${module.path}::${struct.name}`);
      this.addNode({
        id: structId,
        name: struct.name,
        path: `${module.path}::${struct.name}`,
        kind: 'struct',
        parentId: moduleId,
        filePath: module.filePath,
        line: struct.span.start.line,
        children: [],
      });
      this.addChild(moduleId, structId);
    }

    for (const enumDef of module.enums) {
      const enumId = this.prefixId(`${module.path}::${enumDef.name}`);
      this.addNode({
        id: enumId,
        name: enumDef.name,
        path: `${module.path}::${enumDef.name}`,
        kind: 'enum',
        parentId: moduleId,
        filePath: module.filePath,
        line: enumDef.span.start.line,
        children: [],
      });
      this.addChild(moduleId, enumId);
    }

    for (const trait of module.traits) {
      const traitId = this.prefixId(`${module.path}::${trait.name}`);
      this.addNode({
        id: traitId,
        name: trait.name,
        path: `${module.path}::${trait.name}`,
        kind: 'trait',
        parentId: moduleId,
        filePath: module.filePath,
        line: trait.span.start.line,
        children: [],
      });
      this.addChild(moduleId, traitId);
    }

    for (const fn of module.functions) {
      const fnId = this.prefixId(`${module.path}::${fn.name}`);
      this.addNode({
        id: fnId,
        name: fn.name,
        path: `${module.path}::${fn.name}`,
        kind: 'function',
        parentId: moduleId,
        filePath: module.filePath,
        line: fn.span.start.line,
        children: [],
      });
      this.addChild(moduleId, fnId);
    }

    // Add impl block methods as children of their implementing type
    for (const impl of module.impls) {
      const selfTypeName = impl.selfType.name;
      // Try to find the type node this impl is for
      const selfTypeId = this.findTypeNodeId(module.path, selfTypeName);

      if (selfTypeId) {
        for (const method of impl.methods) {
          const methodId = `${selfTypeId}::${method.name}`;
          // Only add if not already present (avoid duplicates from multiple impl blocks)
          if (!this.nodes.has(methodId)) {
            this.addNode({
              id: methodId,
              name: method.name,
              path: methodId,
              kind: 'function',
              parentId: selfTypeId,
              filePath: module.filePath,
              line: method.span.start.line,
              children: [],
            });
            this.addChild(selfTypeId, methodId);
          }
        }
      }
    }

    for (const submodule of module.submodules) {
      this.buildNodes(submodule, module.path);
      this.addChild(moduleId, this.prefixId(submodule.path));
    }
  }

  private findTypeNodeId(modulePath: string, typeName: string): string | null {
    // Try local path first
    const localPath = this.prefixId(`${modulePath}::${typeName}`);
    if (this.nodes.has(localPath)) {
      return localPath;
    }

    // Try crate-level path
    const cratePath = this.prefixId(`crate::${typeName}`);
    if (this.nodes.has(cratePath)) {
      return cratePath;
    }

    // Search for any node ending with this type name
    for (const nodeId of this.nodes.keys()) {
      const node = this.nodes.get(nodeId);
      if (node && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'trait') &&
          nodeId.endsWith(`::${typeName}`)) {
        return nodeId;
      }
    }

    return null;
  }

  private addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    this.adjacencyList.set(node.id, new Set());
    this.reverseAdjacencyList.set(node.id, new Set());
  }

  private addChild(parentId: string, childId: string): void {
    const parent = this.nodes.get(parentId);
    if (parent && !parent.children.includes(childId)) {
      parent.children.push(childId);
    }
  }

  private processModule(module: ModuleDefinition): void {
    this.currentModule = module.path;
    this.useResolver.resolveUsesForModule(module);

    const moduleId = this.prefixId(module.path);

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
      this.processFunction(module, fn, moduleId);
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
    const fromId = this.prefixId(module.path);

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
    const structId = this.prefixId(`${module.path}::${struct.name}`);

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
    const enumId = this.prefixId(`${module.path}::${enumDef.name}`);

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
    const traitId = this.prefixId(`${module.path}::${trait.name}`);

    for (const supertrait of trait.supertraits) {
      this.processTypeRef(traitId, supertrait, 'trait_bound', module.filePath);
    }

    for (const method of trait.methods) {
      this.processFunction(module, method, traitId);
    }
  }

  private processFunction(module: ModuleDefinition, fn: FunctionDef, parentId: string): void {
    const moduleId = this.prefixId(module.path);
    const fnId = parentId === moduleId ? this.prefixId(`${module.path}::${fn.name}`) : `${parentId}::${fn.name}`;

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
    if (resolved) {
      const prefixedResolved = this.prefixId(resolved);
      if (this.nodes.has(prefixedResolved)) {
        return prefixedResolved;
      }
    }

    const localPath = this.prefixId(`${this.currentModule}::${name}`);
    if (this.nodes.has(localPath)) {
      return localPath;
    }

    const cratePath = this.prefixId(`crate::${name}`);
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

    const prefixedNormalized = this.prefixId(normalizedPath);
    if (this.nodes.has(prefixedNormalized)) {
      return prefixedNormalized;
    }

    const prefixedPath = this.prefixId(path);
    if (this.nodes.has(prefixedPath)) {
      return prefixedPath;
    }

    return null;
  }

  private resolveFunctionCall(callPath: string): string | null {
    const localPath = this.prefixId(`${this.currentModule}::${callPath}`);
    if (this.nodes.has(localPath)) {
      return localPath;
    }

    const cratePath = this.prefixId(`crate::${callPath}`);
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
