#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { resolve, basename } from 'path';
import { existsSync } from 'fs';
import { RustParser } from '../parser/rust-parser.js';
import { ModuleResolver } from '../parser/module-resolver.js';
import { buildDependencyGraph, buildWorkspaceGraph } from '../analysis/dependency-graph.js';
import { calculateMetrics } from '../analysis/metrics.js';
import { detectCycles } from '../analysis/cycle-detector.js';
import { generateHtmlReport } from '../renderer/html-generator.js';
import type { FilterConfig } from '../types/filter.js';
import { createDefaultFilterConfig, createNoTestsFilterConfig } from '../types/filter.js';

interface CliOptions {
  output: string;
  format: 'html' | 'json';
  open: boolean;
  workspace: boolean;
  verbose: boolean;
  exclude: string[];
  include: string[];
  noTests: boolean;
}

const program = new Command();

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program
  .name('rust-dsm')
  .description('Analyze Rust codebases and generate interactive DSM reports')
  .version('0.1.0')
  .argument('[path]', 'Path to Rust crate or workspace', '.')
  .option('-o, --output <file>', 'Output file path', './dsm-report.html')
  .option('-f, --format <type>', 'Output format (html | json)', 'html')
  .option('--open', 'Open report in browser after generation', false)
  .option('--workspace', 'Analyze as Cargo workspace', false)
  .option('-v, --verbose', 'Show detailed progress', false)
  .option('--exclude <pattern>', 'Exclude files matching pattern (repeatable)', collect, [])
  .option('--include <pattern>', 'Include only files matching pattern (repeatable)', collect, [])
  .option('--no-tests', 'Exclude test files, tests/ directory, and #[cfg(test)] modules')
  .action(async (inputPath: string, options: CliOptions) => {
    const spinner = ora();
    const verbose = options.verbose;

    try {
      const targetPath = resolve(inputPath);

      if (!existsSync(targetPath)) {
        console.error(chalk.red(`Error: Path does not exist: ${targetPath}`));
        process.exit(1);
      }

      const cargoToml = resolve(targetPath, 'Cargo.toml');
      if (!existsSync(cargoToml)) {
        console.error(chalk.red(`Error: No Cargo.toml found at ${targetPath}`));
        console.error(chalk.yellow('Please run this tool in a Rust crate directory.'));
        process.exit(1);
      }

      // Build filter config
      let filterConfig: FilterConfig;
      if (options.noTests) {
        filterConfig = createNoTestsFilterConfig();
        filterConfig.excludePatterns = options.exclude;
        filterConfig.includePatterns = options.include;
      } else {
        filterConfig = createDefaultFilterConfig();
        filterConfig.excludePatterns = options.exclude;
        filterConfig.includePatterns = options.include;
      }

      const crateName = basename(targetPath);
      const isWorkspace = options.workspace;

      if (isWorkspace) {
        console.log(chalk.blue(`\nAnalyzing Cargo workspace: ${chalk.bold(crateName)}`));
      } else {
        console.log(chalk.blue(`\nAnalyzing Rust crate: ${chalk.bold(crateName)}`));
      }
      console.log(chalk.gray(`Path: ${targetPath}\n`));

      spinner.start('Initializing parser...');
      const parser = new RustParser();
      await parser.initialize();
      spinner.succeed('Parser initialized');

      let crateDefinition;
      let graph;

      if (isWorkspace) {
        spinner.start('Resolving workspace structure...');
        const resolver = new ModuleResolver(parser, targetPath, filterConfig);
        const crates = await resolver.resolveWorkspace();
        const totalModules = crates.reduce((sum, c) => sum + countModules(c.rootModule), 0);
        spinner.succeed(`Found ${crates.length} crates with ${totalModules} total modules`);

        if (verbose) {
          for (const crate of crates) {
            console.log(chalk.cyan(`\n${crate.name}:`));
            printModuleTree(crate.rootModule, 1);
          }
        }

        spinner.start('Building workspace dependency graph...');
        graph = buildWorkspaceGraph(crates);
        spinner.succeed(`Built graph with ${graph.nodes.size} nodes, ${graph.edges.length} edges`);

        // Create a virtual workspace crate that contains all crates
        crateDefinition = {
          name: basename(targetPath),
          rootModule: {
            name: basename(targetPath),
            path: 'workspace',
            filePath: targetPath,
            visibility: { kind: 'public' as const },
            structs: [],
            enums: [],
            traits: [],
            functions: [],
            impls: [],
            uses: [],
            submodules: crates.map(c => c.rootModule),
            constants: [],
            statics: [],
            typeAliases: [],
          },
          cratePath: targetPath,
          isLibrary: false,
        };
      } else {
        spinner.start('Resolving module structure...');
        const resolver = new ModuleResolver(parser, targetPath, filterConfig);
        crateDefinition = await resolver.resolve();
        spinner.succeed(`Found ${countModules(crateDefinition.rootModule)} modules`);

        if (verbose) {
          printModuleTree(crateDefinition.rootModule, 0);
        }

        spinner.start('Building dependency graph...');
        graph = buildDependencyGraph(crateDefinition);
        spinner.succeed(`Built graph with ${graph.nodes.size} nodes, ${graph.edges.length} edges`);
      }

      spinner.start('Detecting cycles...');
      const cycles = detectCycles(graph);
      if (cycles.length > 0) {
        spinner.warn(`Found ${cycles.length} dependency cycles`);
      } else {
        spinner.succeed('No dependency cycles detected');
      }

      spinner.start('Calculating metrics...');
      const metrics = calculateMetrics(graph, crateDefinition, cycles);
      spinner.succeed('Metrics calculated');

      if (verbose) {
        printMetricsSummary(metrics);
      }

      const outputPath = resolve(options.output);

      if (options.format === 'json') {
        spinner.start('Generating JSON report...');
        const { writeFileSync } = await import('fs');
        const jsonOutput = {
          crate: crateDefinition,
          graph: {
            nodes: Array.from(graph.nodes.values()),
            edges: graph.edges,
          },
          cycles,
          metrics: {
            crate: metrics.crateMetrics,
            modules: Object.fromEntries(metrics.moduleMetrics),
            nodes: Object.fromEntries(metrics.nodeMetrics),
          },
        };
        writeFileSync(outputPath.replace('.html', '.json'), JSON.stringify(jsonOutput, null, 2));
        spinner.succeed(`JSON report saved to ${outputPath.replace('.html', '.json')}`);
      } else {
        spinner.start('Generating HTML report...');
        await generateHtmlReport(crateDefinition, graph, cycles, metrics, outputPath);
        spinner.succeed(`HTML report saved to ${outputPath}`);
      }

      if (options.open && options.format === 'html') {
        await open(outputPath);
        console.log(chalk.green('\nReport opened in browser'));
      }

      console.log(chalk.green('\nAnalysis complete!'));
    } catch (error) {
      spinner.fail('Analysis failed');
      if (error instanceof Error) {
        console.error(chalk.red(`\nError: ${error.message}`));
        if (verbose) {
          console.error(chalk.gray(error.stack));
        }
      }
      process.exit(1);
    }
  });

function countModules(module: import('../types/ast.js').ModuleDefinition): number {
  return 1 + module.submodules.reduce((sum, sub) => sum + countModules(sub), 0);
}

function printModuleTree(module: import('../types/ast.js').ModuleDefinition, depth: number): void {
  const indent = '  '.repeat(depth);
  const stats = [
    module.structs.length > 0 ? `${module.structs.length} structs` : null,
    module.enums.length > 0 ? `${module.enums.length} enums` : null,
    module.traits.length > 0 ? `${module.traits.length} traits` : null,
    module.functions.length > 0 ? `${module.functions.length} fns` : null,
  ].filter(Boolean).join(', ');

  console.log(chalk.cyan(`${indent}${module.name}`) + (stats ? chalk.gray(` (${stats})`) : ''));

  for (const sub of module.submodules) {
    printModuleTree(sub, depth + 1);
  }
}

function printMetricsSummary(metrics: import('../types/metrics.js').MetricsReport): void {
  console.log(chalk.yellow('\n--- Metrics Summary ---'));
  console.log(`Total modules: ${metrics.crateMetrics.totalModules}`);
  console.log(`Total types: ${metrics.crateMetrics.totalTypes}`);
  console.log(`Total functions: ${metrics.crateMetrics.totalFunctions}`);
  console.log(`Avg instability: ${metrics.crateMetrics.averageInstability.toFixed(2)}`);
  console.log(`Avg abstractness: ${metrics.crateMetrics.averageAbstractness.toFixed(2)}`);
  console.log(`Cycles: ${metrics.crateMetrics.cycleCount}`);
}

program.parse();
