import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import { RustParser } from './rust-parser.js';
import { SymbolExtractor } from './symbol-extractor.js';
import type { ModuleDefinition, CrateDefinition, Visibility } from '../types/ast.js';
import type { FilterConfig } from '../types/filter.js';
import { createDefaultFilterConfig } from '../types/filter.js';

interface CargoToml {
  package?: {
    name: string;
  };
  workspace?: {
    members?: string[];
  };
  lib?: {
    path?: string;
  };
  bin?: Array<{
    name: string;
    path?: string;
  }>;
}

export class ModuleResolver {
  private parser: RustParser;
  private cratePath: string;
  private moduleCache: Map<string, ModuleDefinition> = new Map();
  private filterConfig: FilterConfig;

  constructor(parser: RustParser, cratePath: string, filterConfig?: FilterConfig) {
    this.parser = parser;
    this.cratePath = cratePath;
    this.filterConfig = filterConfig ?? createDefaultFilterConfig();
  }

  private shouldExclude(filePath: string): boolean {
    const relativePath = relative(this.cratePath, filePath);

    // Check test file patterns (*_test.rs, *_tests.rs)
    if (this.filterConfig.excludeTestFiles) {
      const fileName = basename(filePath);
      if (fileName.match(/_tests?\.rs$/)) {
        return true;
      }
    }

    // Check tests/ directory
    if (this.filterConfig.excludeTestsDirectory) {
      if (relativePath.startsWith('tests/') || relativePath.startsWith('tests\\')) {
        return true;
      }
    }

    // Check exclude patterns
    for (const pattern of this.filterConfig.excludePatterns) {
      if (minimatch(relativePath, pattern)) {
        return true;
      }
    }

    // Check include patterns (if any are specified, file must match at least one)
    if (this.filterConfig.includePatterns.length > 0) {
      const matchesInclude = this.filterConfig.includePatterns.some(pattern =>
        minimatch(relativePath, pattern)
      );
      if (!matchesInclude) {
        return true;
      }
    }

    return false;
  }

  async resolve(): Promise<CrateDefinition> {
    const cargoToml = this.parseCargoToml();
    const crateName = cargoToml.package?.name ?? basename(this.cratePath);

    const libPath = this.findLibPath(cargoToml);
    const isLibrary = libPath !== null;
    const entryPoint = libPath ?? this.findMainPath(cargoToml);

    if (!entryPoint) {
      throw new Error(`Could not find lib.rs or main.rs in ${this.cratePath}`);
    }

    const rootModule = await this.resolveModule(entryPoint, 'crate', `crate`);

    return {
      name: crateName,
      rootModule,
      cratePath: this.cratePath,
      isLibrary,
    };
  }

  private parseCargoToml(): CargoToml {
    const tomlPath = join(this.cratePath, 'Cargo.toml');
    if (!existsSync(tomlPath)) {
      return {};
    }

    const content = readFileSync(tomlPath, 'utf-8');
    return this.parseToml(content);
  }

  private parseToml(content: string): CargoToml {
    const result: CargoToml = {};
    let currentSection = '';
    let currentArray: Record<string, unknown>[] | null = null;
    let currentArrayItem: Record<string, unknown> = {};
    let multiLineArrayKey: string | null = null;
    let multiLineArrayValues: string[] = [];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (trimmed.startsWith('#') || trimmed === '') continue;

      // Handle multi-line array continuation
      if (multiLineArrayKey !== null) {
        if (trimmed === ']') {
          // End of multi-line array
          this.setTomlValue(result, currentSection, multiLineArrayKey, multiLineArrayValues, currentArrayItem, currentArray);
          multiLineArrayKey = null;
          multiLineArrayValues = [];
          continue;
        }
        // Parse array item (handles "value", or "value",)
        const itemMatch = trimmed.match(/^"([^"]*)"[,]?$/);
        if (itemMatch) {
          multiLineArrayValues.push(itemMatch[1]);
        }
        continue;
      }

      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        if (currentArray && Object.keys(currentArrayItem).length > 0) {
          currentArray.push(currentArrayItem);
          currentArrayItem = {};
        }
        currentSection = sectionMatch[1];
        currentArray = null;

        if (currentSection === 'package') {
          result.package = result.package ?? { name: '' };
        } else if (currentSection === 'workspace') {
          result.workspace = result.workspace ?? {};
        } else if (currentSection === 'lib') {
          result.lib = result.lib ?? {};
        }
        continue;
      }

      const arraySectionMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
      if (arraySectionMatch) {
        if (currentArray && Object.keys(currentArrayItem).length > 0) {
          currentArray.push(currentArrayItem);
          currentArrayItem = {};
        }
        currentSection = arraySectionMatch[1];
        if (currentSection === 'bin') {
          result.bin = result.bin ?? [];
          currentArray = result.bin;
        }
        continue;
      }

      const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (kvMatch) {
        const [, key, rawValue] = kvMatch;
        let value: unknown = rawValue;

        if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
          value = rawValue.slice(1, -1);
        } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
          // Single-line array
          value = rawValue
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^"|"$/g, ''))
            .filter((s) => s.length > 0);
        } else if (rawValue === '[') {
          // Start of multi-line array
          multiLineArrayKey = key;
          multiLineArrayValues = [];
          continue;
        }

        this.setTomlValue(result, currentSection, key, value, currentArrayItem, currentArray);
      }
    }

    if (currentArray && Object.keys(currentArrayItem).length > 0) {
      currentArray.push(currentArrayItem);
    }

    return result;
  }

  private setTomlValue(
    result: CargoToml,
    currentSection: string,
    key: string,
    value: unknown,
    currentArrayItem: Record<string, unknown>,
    currentArray: Record<string, unknown>[] | null
  ): void {
    if (currentSection === 'package' && result.package) {
      (result.package as Record<string, unknown>)[key] = value;
    } else if (currentSection === 'workspace' && result.workspace) {
      (result.workspace as Record<string, unknown>)[key] = value;
    } else if (currentSection === 'lib' && result.lib) {
      (result.lib as Record<string, unknown>)[key] = value;
    } else if (currentSection === 'bin' && currentArray) {
      currentArrayItem[key] = value;
    }
  }

  private findLibPath(cargo: CargoToml): string | null {
    if (cargo.lib?.path) {
      const path = join(this.cratePath, cargo.lib.path);
      if (existsSync(path)) return path;
    }

    const defaultLib = join(this.cratePath, 'src', 'lib.rs');
    if (existsSync(defaultLib)) return defaultLib;

    return null;
  }

  private findMainPath(cargo: CargoToml): string | null {
    if (cargo.bin && cargo.bin.length > 0 && cargo.bin[0].path) {
      const path = join(this.cratePath, cargo.bin[0].path);
      if (existsSync(path)) return path;
    }

    const defaultMain = join(this.cratePath, 'src', 'main.rs');
    if (existsSync(defaultMain)) return defaultMain;

    return null;
  }

  private async resolveModule(filePath: string, name: string, modulePath: string): Promise<ModuleDefinition> {
    if (this.moduleCache.has(filePath)) {
      return this.moduleCache.get(filePath)!;
    }

    const parseResult = this.parser.parseFile(filePath);
    const extractor = new SymbolExtractor(parseResult);
    const symbols = extractor.extractAll();

    const submodules: ModuleDefinition[] = [];

    for (const modName of symbols.modDeclarations) {
      const submodPath = this.findSubmodule(filePath, modName);
      if (submodPath) {
        const submod = await this.resolveModule(submodPath, modName, `${modulePath}::${modName}`);
        submodules.push(submod);
      }
    }

    const inlineModules = extractor.extractInlineModules(parseResult.tree.rootNode);
    for (const { name: modName, node, isCfgTest } of inlineModules) {
      // Skip #[cfg(test)] modules if filtering is enabled
      if (isCfgTest && this.filterConfig.excludeCfgTest) {
        continue;
      }

      const inlineExtractor = new SymbolExtractor({
        tree: { rootNode: node } as import('tree-sitter').Tree,
        source: parseResult.source,
        filePath,
      });
      const inlineSymbols = inlineExtractor.extractAll();

      const inlineModule: ModuleDefinition = {
        name: modName,
        path: `${modulePath}::${modName}`,
        filePath,
        visibility: { kind: 'private' },
        ...inlineSymbols,
        submodules: [],
      };
      submodules.push(inlineModule);
    }

    const module: ModuleDefinition = {
      name,
      path: modulePath,
      filePath,
      visibility: { kind: 'public' } as Visibility,
      structs: symbols.structs,
      enums: symbols.enums,
      traits: symbols.traits,
      functions: symbols.functions,
      impls: symbols.impls,
      uses: symbols.uses,
      submodules,
      constants: symbols.constants,
      statics: symbols.statics,
      typeAliases: symbols.typeAliases,
    };

    this.moduleCache.set(filePath, module);
    return module;
  }

  private findSubmodule(parentFile: string, modName: string): string | null {
    const parentDir = dirname(parentFile);
    const parentBasename = basename(parentFile, '.rs');

    const candidates: string[] = [];

    if (parentBasename === 'lib' || parentBasename === 'main' || parentBasename === 'mod') {
      candidates.push(join(parentDir, `${modName}.rs`));
      candidates.push(join(parentDir, modName, 'mod.rs'));
    } else {
      candidates.push(join(parentDir, parentBasename, `${modName}.rs`));
      candidates.push(join(parentDir, parentBasename, modName, 'mod.rs'));
    }

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        // Apply filter
        if (this.shouldExclude(candidate)) {
          return null;
        }
        return candidate;
      }
    }

    return null;
  }

  async resolveWorkspace(): Promise<CrateDefinition[]> {
    const cargo = this.parseCargoToml();
    const crates: CrateDefinition[] = [];

    if (cargo.workspace?.members) {
      for (const memberPattern of cargo.workspace.members) {
        const memberPaths = await glob(memberPattern, { cwd: this.cratePath });
        for (const memberPath of memberPaths) {
          const fullPath = join(this.cratePath, memberPath);
          if (statSync(fullPath).isDirectory() && existsSync(join(fullPath, 'Cargo.toml'))) {
            // Pass the same filter config to member resolvers
            const memberResolver = new ModuleResolver(this.parser, fullPath, this.filterConfig);
            const crate = await memberResolver.resolve();
            crates.push(crate);
          }
        }
      }
    }

    if (crates.length === 0) {
      crates.push(await this.resolve());
    }

    return crates;
  }
}
