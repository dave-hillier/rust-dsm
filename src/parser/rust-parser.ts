import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';
import { readFileSync } from 'fs';
import type { SyntaxNode, Tree } from 'tree-sitter';

export interface ParseResult {
  tree: Tree;
  source: string;
  filePath: string;
}

export class RustParser {
  private parser: Parser;
  private initialized = false;

  constructor() {
    this.parser = new Parser();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.parser.setLanguage(Rust as any);
    this.initialized = true;
  }

  parseFile(filePath: string): ParseResult {
    if (!this.initialized) {
      throw new Error('Parser not initialized. Call initialize() first.');
    }

    const source = readFileSync(filePath, 'utf-8');
    const tree = this.parser.parse(source);

    return { tree, source, filePath };
  }

  parseSource(source: string, filePath = '<string>'): ParseResult {
    if (!this.initialized) {
      throw new Error('Parser not initialized. Call initialize() first.');
    }

    const tree = this.parser.parse(source);
    return { tree, source, filePath };
  }

  static getNodeText(node: SyntaxNode, source: string): string {
    return source.slice(node.startIndex, node.endIndex);
  }

  static findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
    for (const child of node.children) {
      if (child.type === type) {
        return child;
      }
    }
    return null;
  }

  static findChildrenByType(node: SyntaxNode, type: string): SyntaxNode[] {
    return node.children.filter((child) => child.type === type);
  }

  static findChildByFieldName(node: SyntaxNode, fieldName: string): SyntaxNode | null {
    return node.childForFieldName(fieldName);
  }

  static walkTree(node: SyntaxNode, callback: (node: SyntaxNode) => void): void {
    callback(node);
    for (const child of node.children) {
      RustParser.walkTree(child, callback);
    }
  }

  static findAllByType(root: SyntaxNode, type: string): SyntaxNode[] {
    const results: SyntaxNode[] = [];
    RustParser.walkTree(root, (node) => {
      if (node.type === type) {
        results.push(node);
      }
    });
    return results;
  }

  static findAllByTypes(root: SyntaxNode, types: string[]): SyntaxNode[] {
    const typeSet = new Set(types);
    const results: SyntaxNode[] = [];
    RustParser.walkTree(root, (node) => {
      if (typeSet.has(node.type)) {
        results.push(node);
      }
    });
    return results;
  }

  static getPosition(node: SyntaxNode): { line: number; column: number } {
    return {
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    };
  }

  static getSpan(node: SyntaxNode): { start: { line: number; column: number }; end: { line: number; column: number } } {
    return {
      start: {
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      },
      end: {
        line: node.endPosition.row + 1,
        column: node.endPosition.column,
      },
    };
  }
}
