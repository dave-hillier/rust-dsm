import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { glob } from 'glob';
import { RustParser } from './rust-parser.js';
import { SymbolExtractor } from './symbol-extractor.js';
import type { ModuleDefinition, CrateDefinition, Visibility } from '../types/ast.js';

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

  constructor(parser: RustParser, cratePath: string) {
    this.parser = parser;
    this.cratePath = cratePath;
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

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      if (trimmed.startsWith('#') || trimmed === '') continue;

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
          value = rawValue
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^"|"$/g, ''))
            .filter((s) => s.length > 0);
        }

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
    }

    if (currentArray && Object.keys(currentArrayItem).length > 0) {
      currentArray.push(currentArrayItem);
    }

    return result;
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
    for (const { name: modName, node } of inlineModules) {
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
            const memberResolver = new ModuleResolver(this.parser, fullPath);
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
