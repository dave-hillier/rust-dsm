import type { CrateDefinition, ModuleDefinition, UseDeclaration, TypeReference } from '../types/ast.js';

export interface SymbolIndex {
  types: Map<string, string>;
  functions: Map<string, string>;
  traits: Map<string, string>;
  modules: Map<string, string>;
}

export interface ResolvedUse {
  localName: string;
  resolvedPath: string;
  kind: 'type' | 'function' | 'trait' | 'module' | 'unknown';
}

export class UseResolver {
  private symbolIndex: SymbolIndex;
  private moduleAliases: Map<string, Map<string, string>> = new Map();

  constructor(crate: CrateDefinition) {
    this.symbolIndex = this.buildSymbolIndex(crate.rootModule);
  }

  private buildSymbolIndex(module: ModuleDefinition): SymbolIndex {
    const index: SymbolIndex = {
      types: new Map(),
      functions: new Map(),
      traits: new Map(),
      modules: new Map(),
    };

    this.indexModule(module, index);
    return index;
  }

  private indexModule(module: ModuleDefinition, index: SymbolIndex): void {
    index.modules.set(module.path, module.path);

    for (const struct of module.structs) {
      index.types.set(`${module.path}::${struct.name}`, `${module.path}::${struct.name}`);
    }

    for (const enumDef of module.enums) {
      index.types.set(`${module.path}::${enumDef.name}`, `${module.path}::${enumDef.name}`);
    }

    for (const trait of module.traits) {
      index.traits.set(`${module.path}::${trait.name}`, `${module.path}::${trait.name}`);
    }

    for (const fn of module.functions) {
      index.functions.set(`${module.path}::${fn.name}`, `${module.path}::${fn.name}`);
    }

    for (const alias of module.typeAliases) {
      index.types.set(`${module.path}::${alias.name}`, `${module.path}::${alias.name}`);
    }

    for (const submodule of module.submodules) {
      this.indexModule(submodule, index);
    }
  }

  resolveUsesForModule(module: ModuleDefinition): ResolvedUse[] {
    const resolved: ResolvedUse[] = [];
    const moduleAliases = new Map<string, string>();

    for (const use of module.uses) {
      const resolvedItems = this.resolveUseDeclaration(use, module.path);
      for (const item of resolvedItems) {
        resolved.push(item);
        moduleAliases.set(item.localName, item.resolvedPath);
      }
    }

    this.moduleAliases.set(module.path, moduleAliases);
    return resolved;
  }

  private resolveUseDeclaration(use: UseDeclaration, currentModulePath: string): ResolvedUse[] {
    const resolved: ResolvedUse[] = [];
    const basePath = this.resolveBasePath(use.path, currentModulePath);

    if (use.isGlob) {
      const globResolved = this.resolveGlobImport(basePath);
      resolved.push(...globResolved);
    } else if (use.items.length > 0) {
      for (const item of use.items) {
        const itemPath = `${basePath}::${item.name}`;
        const localName = item.alias ?? item.name;
        const kind = this.determineSymbolKind(itemPath);

        resolved.push({
          localName,
          resolvedPath: itemPath,
          kind,
        });
      }
    } else {
      const lastSegment = use.path[use.path.length - 1];
      const localName = use.alias ?? lastSegment;
      const kind = this.determineSymbolKind(basePath);

      resolved.push({
        localName,
        resolvedPath: basePath,
        kind,
      });
    }

    return resolved;
  }

  private resolveBasePath(pathSegments: string[], currentModulePath: string): string {
    if (pathSegments.length === 0) return currentModulePath;

    const first = pathSegments[0];
    let basePath: string;

    if (first === 'crate') {
      basePath = pathSegments.join('::');
    } else if (first === 'self') {
      basePath = [currentModulePath, ...pathSegments.slice(1)].join('::');
    } else if (first === 'super') {
      const parentPath = currentModulePath.split('::').slice(0, -1).join('::');
      basePath = [parentPath, ...pathSegments.slice(1)].join('::');
    } else if (first === 'std' || first === 'core' || first === 'alloc') {
      basePath = pathSegments.join('::');
    } else {
      basePath = `crate::${pathSegments.join('::')}`;
    }

    return basePath;
  }

  private resolveGlobImport(basePath: string): ResolvedUse[] {
    const resolved: ResolvedUse[] = [];
    const prefix = `${basePath}::`;

    for (const [fullPath, _] of this.symbolIndex.types) {
      if (fullPath.startsWith(prefix)) {
        const remaining = fullPath.slice(prefix.length);
        if (!remaining.includes('::')) {
          resolved.push({
            localName: remaining,
            resolvedPath: fullPath,
            kind: 'type',
          });
        }
      }
    }

    for (const [fullPath, _] of this.symbolIndex.functions) {
      if (fullPath.startsWith(prefix)) {
        const remaining = fullPath.slice(prefix.length);
        if (!remaining.includes('::')) {
          resolved.push({
            localName: remaining,
            resolvedPath: fullPath,
            kind: 'function',
          });
        }
      }
    }

    for (const [fullPath, _] of this.symbolIndex.traits) {
      if (fullPath.startsWith(prefix)) {
        const remaining = fullPath.slice(prefix.length);
        if (!remaining.includes('::')) {
          resolved.push({
            localName: remaining,
            resolvedPath: fullPath,
            kind: 'trait',
          });
        }
      }
    }

    return resolved;
  }

  private determineSymbolKind(path: string): 'type' | 'function' | 'trait' | 'module' | 'unknown' {
    if (this.symbolIndex.types.has(path)) return 'type';
    if (this.symbolIndex.functions.has(path)) return 'function';
    if (this.symbolIndex.traits.has(path)) return 'trait';
    if (this.symbolIndex.modules.has(path)) return 'module';
    return 'unknown';
  }

  resolveTypeReference(typeRef: TypeReference, modulePath: string): string | null {
    const name = typeRef.name;

    if (this.isPrimitive(name)) {
      return `std::${name}`;
    }

    const moduleAliases = this.moduleAliases.get(modulePath);
    if (moduleAliases?.has(name)) {
      return moduleAliases.get(name)!;
    }

    const localPath = `${modulePath}::${name}`;
    if (this.symbolIndex.types.has(localPath) || this.symbolIndex.traits.has(localPath)) {
      return localPath;
    }

    const cratePath = `crate::${name}`;
    if (this.symbolIndex.types.has(cratePath) || this.symbolIndex.traits.has(cratePath)) {
      return cratePath;
    }

    if (name.includes('::')) {
      const fullPath = name.startsWith('crate::') ? name : `crate::${name}`;
      if (this.symbolIndex.types.has(fullPath) || this.symbolIndex.traits.has(fullPath)) {
        return fullPath;
      }
    }

    return null;
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
    ]);
    return primitives.has(name);
  }

  getSymbolIndex(): SymbolIndex {
    return this.symbolIndex;
  }
}
