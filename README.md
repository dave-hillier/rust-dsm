# rust-dsm

A TypeScript/Node CLI tool that analyzes Rust codebases using tree-sitter and generates interactive HTML reports with DSM (Dependency Structure Matrix) visualization and node-based dependency explorer.

## Features

- **Pure tree-sitter parsing** - No Cargo or rust-analyzer required
- **Full Rust module resolution** - Handles lib.rs, mod.rs, inline modules, and submodules
- **Comprehensive dependency tracking**:
  - `use` imports
  - Type references (fields, parameters, return types)
  - Function and method calls
  - Trait implementations and bounds
- **Software metrics**:
  - Afferent Coupling (Ca) - incoming dependencies
  - Efferent Coupling (Ce) - outgoing dependencies
  - Instability (I) - Ce / (Ca + Ce)
  - Abstractness (A) - ratio of traits to total types
  - Distance from Main Sequence (D)
  - Fan-in / Fan-out
- **Cycle detection** using Tarjan's strongly connected components algorithm
- **Interactive HTML report** with D3.js visualizations

## Installation

```bash
git clone https://github.com/dave-hillier/rust-dsm.git
cd rust-dsm
npm install
npm run build
```

## Usage

```bash
# Analyze a Rust crate
node dist/cli/commands.js /path/to/rust/crate

# With options
node dist/cli/commands.js /path/to/crate -o report.html -v --open
```

### Options

| Option | Description |
|--------|-------------|
| `-o, --output <file>` | Output HTML path (default: `./dsm-report.html`) |
| `-f, --format <type>` | Output format: `html` or `json` |
| `--open` | Open report in browser after generation |
| `--workspace` | Analyze as Cargo workspace |
| `-v, --verbose` | Show detailed progress |

## Report Sections

### Dependencies Tab

**DSM Matrix** (left panel)
- NxN matrix showing dependencies between modules/types
- Cell color intensity indicates dependency count
- Red dashed borders highlight dependency cycles
- Sortable by path, instability, or coupling
- Click labels to select, right-click for context menu

**Graph Explorer** (right panel)
- Interactive node-based visualization
- Three layouts: Force-directed, Tree, Radial
- Drag nodes, pan and zoom
- Nodes colored by type (module, struct, enum, trait, function)
- Node size reflects coupling metrics

**Sidebar**
- Filter nodes by name
- View detailed metrics for selected node

### Structure Tab

**Treemap**
- Rectangles sized by lines of code, file size, or complexity
- Click to zoom into subdirectories
- Color by depth, complexity, or coupling

**Circle Packing**
- Nested circles showing module hierarchy
- Click to zoom in/out
- Same sizing and coloring options as treemap

### Metrics Tab

- Summary cards with totals and averages
- Searchable, sortable table of all metrics
- Click column headers to sort

## Example

```bash
# Clone and build
git clone https://github.com/dave-hillier/rust-dsm.git
cd rust-dsm
npm install
npm run build

# Analyze the included test fixture
node dist/cli/commands.js test-fixtures/simple-crate -v --open
```

## How It Works

1. **Parse** - Tree-sitter parses all `.rs` files into ASTs
2. **Resolve** - Module resolver follows `mod` declarations to build the module tree
3. **Extract** - Symbol extractor pulls out structs, enums, traits, functions, impls, and use statements
4. **Graph** - Dependency graph builder creates nodes and edges for all symbols and their relationships
5. **Analyze** - Cycle detector finds SCCs, metrics calculator computes coupling and instability
6. **Render** - HTML generator produces a single self-contained report with embedded D3.js visualizations

## License

MIT
