import type { SyntaxNode } from 'tree-sitter';
import { RustParser, type ParseResult } from './rust-parser.js';
import type {
  StructDef,
  EnumDef,
  TraitDef,
  FunctionDef,
  ImplBlock,
  UseDeclaration,
  ConstDef,
  StaticDef,
  TypeAliasDef,
  Visibility,
  TypeReference,
  FieldDef,
  FunctionParam,
  GenericParam,
  EnumVariant,
  Callsite,
  UseItem,
  AssociatedTypeDef,
} from '../types/ast.js';

export class SymbolExtractor {
  private source: string;
  private filePath: string;

  constructor(private parseResult: ParseResult) {
    this.source = parseResult.source;
    this.filePath = parseResult.filePath;
  }

  extractAll(): {
    structs: StructDef[];
    enums: EnumDef[];
    traits: TraitDef[];
    functions: FunctionDef[];
    impls: ImplBlock[];
    uses: UseDeclaration[];
    constants: ConstDef[];
    statics: StaticDef[];
    typeAliases: TypeAliasDef[];
    modDeclarations: string[];
  } {
    const root = this.parseResult.tree.rootNode;

    return {
      structs: this.extractStructs(root),
      enums: this.extractEnums(root),
      traits: this.extractTraits(root),
      functions: this.extractFunctions(root),
      impls: this.extractImpls(root),
      uses: this.extractUses(root),
      constants: this.extractConstants(root),
      statics: this.extractStatics(root),
      typeAliases: this.extractTypeAliases(root),
      modDeclarations: this.extractModDeclarations(root),
    };
  }

  private getText(node: SyntaxNode): string {
    return RustParser.getNodeText(node, this.source);
  }

  private extractVisibility(node: SyntaxNode): Visibility {
    const visMarker = RustParser.findChildByType(node, 'visibility_modifier');
    if (!visMarker) {
      return { kind: 'private' };
    }

    const text = this.getText(visMarker);
    if (text === 'pub') {
      return { kind: 'public' };
    }
    if (text.includes('crate')) {
      return { kind: 'crate' };
    }
    if (text.includes('super')) {
      return { kind: 'super' };
    }
    if (text.includes('in')) {
      const pathMatch = text.match(/in\s+([\w:]+)/);
      return { kind: 'in_path', path: pathMatch?.[1] };
    }
    return { kind: 'public' };
  }

  private extractTypeReference(node: SyntaxNode | null): TypeReference {
    if (!node) {
      return {
        name: 'unknown',
        resolvedPath: null,
        typeParameters: [],
        span: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
      };
    }

    const span = RustParser.getSpan(node);
    const text = this.getText(node);

    if (node.type === 'type_identifier' || node.type === 'identifier') {
      return {
        name: text,
        resolvedPath: null,
        typeParameters: [],
        span,
      };
    }

    if (node.type === 'generic_type') {
      const typeId = RustParser.findChildByType(node, 'type_identifier');
      const typeArgs = RustParser.findChildByType(node, 'type_arguments');
      const params: TypeReference[] = [];

      if (typeArgs) {
        for (const child of typeArgs.children) {
          if (child.type !== '<' && child.type !== '>' && child.type !== ',') {
            params.push(this.extractTypeReference(child));
          }
        }
      }

      return {
        name: typeId ? this.getText(typeId) : text,
        resolvedPath: null,
        typeParameters: params,
        span,
      };
    }

    if (node.type === 'scoped_type_identifier') {
      return {
        name: text,
        resolvedPath: null,
        typeParameters: [],
        span,
      };
    }

    if (node.type === 'reference_type') {
      const innerType = node.children.find(
        (c) => c.type !== '&' && c.type !== 'mutable_specifier' && c.type !== 'lifetime'
      );
      const inner = this.extractTypeReference(innerType ?? null);
      return {
        name: `&${inner.name}`,
        resolvedPath: null,
        typeParameters: inner.typeParameters,
        span,
      };
    }

    if (node.type === 'primitive_type') {
      return {
        name: text,
        resolvedPath: `std::${text}`,
        typeParameters: [],
        span,
      };
    }

    if (node.type === 'unit_type') {
      return {
        name: '()',
        resolvedPath: null,
        typeParameters: [],
        span,
      };
    }

    if (node.type === 'tuple_type') {
      const elements = node.children
        .filter((c) => c.type !== '(' && c.type !== ')' && c.type !== ',')
        .map((c) => this.extractTypeReference(c));
      return {
        name: `(${elements.map((e) => e.name).join(', ')})`,
        resolvedPath: null,
        typeParameters: elements,
        span,
      };
    }

    if (node.type === 'array_type') {
      const elemType = node.children.find(
        (c) => c.type !== '[' && c.type !== ']' && c.type !== ';' && c.type !== 'integer_literal'
      );
      const inner = this.extractTypeReference(elemType ?? null);
      return {
        name: `[${inner.name}]`,
        resolvedPath: null,
        typeParameters: [inner],
        span,
      };
    }

    if (node.type === 'function_type' || node.type === 'closure_type') {
      return {
        name: text,
        resolvedPath: null,
        typeParameters: [],
        span,
      };
    }

    return {
      name: text,
      resolvedPath: null,
      typeParameters: [],
      span,
    };
  }

  private extractGenerics(node: SyntaxNode): GenericParam[] {
    const params: GenericParam[] = [];
    const typeParams = RustParser.findChildByType(node, 'type_parameters');
    if (!typeParams) return params;

    for (const child of typeParams.children) {
      if (child.type === 'type_identifier' || child.type === 'constrained_type_parameter') {
        const nameNode =
          child.type === 'type_identifier' ? child : RustParser.findChildByType(child, 'type_identifier');
        const bounds: TypeReference[] = [];

        if (child.type === 'constrained_type_parameter') {
          const traitBounds = RustParser.findChildByType(child, 'trait_bounds');
          if (traitBounds) {
            for (const bound of traitBounds.children) {
              if (bound.type !== '+') {
                bounds.push(this.extractTypeReference(bound));
              }
            }
          }
        }

        if (nameNode) {
          params.push({
            name: this.getText(nameNode),
            bounds,
          });
        }
      }
    }

    return params;
  }

  private extractFields(node: SyntaxNode): FieldDef[] {
    const fields: FieldDef[] = [];
    const fieldList = RustParser.findChildByType(node, 'field_declaration_list');

    if (!fieldList) {
      const tupleFields = RustParser.findChildByType(node, 'ordered_field_declaration_list');
      if (tupleFields) {
        let idx = 0;
        for (const child of tupleFields.children) {
          if (child.type === 'ordered_field_declaration') {
            const visibility = this.extractVisibility(child);
            const typeNode = child.children.find((c) => c.type !== 'visibility_modifier');
            fields.push({
              name: null,
              visibility,
              typeRef: this.extractTypeReference(typeNode ?? null),
              span: RustParser.getSpan(child),
            });
            idx++;
          }
        }
      }
      return fields;
    }

    for (const child of fieldList.children) {
      if (child.type === 'field_declaration') {
        const nameNode = RustParser.findChildByType(child, 'field_identifier');
        const typeNode = child.childForFieldName('type');
        const visibility = this.extractVisibility(child);

        fields.push({
          name: nameNode ? this.getText(nameNode) : null,
          visibility,
          typeRef: this.extractTypeReference(typeNode),
          span: RustParser.getSpan(child),
        });
      }
    }

    return fields;
  }

  extractStructs(root: SyntaxNode): StructDef[] {
    const structs: StructDef[] = [];
    const structNodes = RustParser.findAllByType(root, 'struct_item');

    for (const node of structNodes) {
      const nameNode = RustParser.findChildByType(node, 'type_identifier');
      if (!nameNode) continue;

      structs.push({
        name: this.getText(nameNode),
        visibility: this.extractVisibility(node),
        generics: this.extractGenerics(node),
        fields: this.extractFields(node),
        span: RustParser.getSpan(node),
      });
    }

    return structs;
  }

  extractEnums(root: SyntaxNode): EnumDef[] {
    const enums: EnumDef[] = [];
    const enumNodes = RustParser.findAllByType(root, 'enum_item');

    for (const node of enumNodes) {
      const nameNode = RustParser.findChildByType(node, 'type_identifier');
      if (!nameNode) continue;

      const variants: EnumVariant[] = [];
      const variantList = RustParser.findChildByType(node, 'enum_variant_list');

      if (variantList) {
        for (const child of variantList.children) {
          if (child.type === 'enum_variant') {
            const variantName = RustParser.findChildByType(child, 'identifier');
            if (variantName) {
              variants.push({
                name: this.getText(variantName),
                fields: this.extractFields(child),
                span: RustParser.getSpan(child),
              });
            }
          }
        }
      }

      enums.push({
        name: this.getText(nameNode),
        visibility: this.extractVisibility(node),
        generics: this.extractGenerics(node),
        variants,
        span: RustParser.getSpan(node),
      });
    }

    return enums;
  }

  private extractFunctionParams(node: SyntaxNode): FunctionParam[] {
    const params: FunctionParam[] = [];
    const paramList = RustParser.findChildByType(node, 'parameters');
    if (!paramList) return params;

    for (const child of paramList.children) {
      if (child.type === 'self_parameter') {
        const text = this.getText(child);
        let selfKind: 'value' | 'ref' | 'mut_ref' = 'value';
        if (text.includes('&mut')) {
          selfKind = 'mut_ref';
        } else if (text.includes('&')) {
          selfKind = 'ref';
        }
        params.push({
          name: 'self',
          typeRef: {
            name: 'Self',
            resolvedPath: null,
            typeParameters: [],
            span: RustParser.getSpan(child),
          },
          isSelf: true,
          selfKind,
        });
      } else if (child.type === 'parameter') {
        const patternNode = child.childForFieldName('pattern');
        const typeNode = child.childForFieldName('type');
        const name = patternNode ? this.getText(patternNode) : '_';

        params.push({
          name,
          typeRef: this.extractTypeReference(typeNode),
          isSelf: false,
        });
      }
    }

    return params;
  }

  private extractCallsites(node: SyntaxNode): Callsite[] {
    const callsites: Callsite[] = [];
    const body = RustParser.findChildByType(node, 'block');
    if (!body) return callsites;

    const callExprs = RustParser.findAllByType(body, 'call_expression');
    for (const call of callExprs) {
      const funcNode = call.childForFieldName('function');
      if (funcNode) {
        callsites.push({
          functionPath: this.getText(funcNode),
          isMethodCall: false,
          receiverType: null,
          span: RustParser.getSpan(call),
        });
      }
    }

    const methodCalls = RustParser.findAllByType(body, 'method_call_expression');
    for (const call of methodCalls) {
      const methodName = RustParser.findChildByType(call, 'field_identifier');
      if (methodName) {
        callsites.push({
          functionPath: this.getText(methodName),
          isMethodCall: true,
          receiverType: null,
          span: RustParser.getSpan(call),
        });
      }
    }

    return callsites;
  }

  extractFunctions(root: SyntaxNode): FunctionDef[] {
    const functions: FunctionDef[] = [];
    const fnNodes = RustParser.findAllByType(root, 'function_item');

    for (const node of fnNodes) {
      const nameNode = RustParser.findChildByType(node, 'identifier');
      if (!nameNode) continue;

      const returnType = node.childForFieldName('return_type');

      functions.push({
        name: this.getText(nameNode),
        visibility: this.extractVisibility(node),
        generics: this.extractGenerics(node),
        params: this.extractFunctionParams(node),
        returnType: returnType ? this.extractTypeReference(returnType.children[1] ?? returnType) : null,
        isAsync: node.children.some((c) => c.type === 'async'),
        isConst: node.children.some((c) => c.type === 'const'),
        isUnsafe: node.children.some((c) => c.type === 'unsafe'),
        bodyCallsites: this.extractCallsites(node),
        span: RustParser.getSpan(node),
      });
    }

    return functions;
  }

  extractTraits(root: SyntaxNode): TraitDef[] {
    const traits: TraitDef[] = [];
    const traitNodes = RustParser.findAllByType(root, 'trait_item');

    for (const node of traitNodes) {
      const nameNode = RustParser.findChildByType(node, 'type_identifier');
      if (!nameNode) continue;

      const supertraits: TypeReference[] = [];
      const traitBounds = RustParser.findChildByType(node, 'trait_bounds');
      if (traitBounds) {
        for (const bound of traitBounds.children) {
          if (bound.type !== '+' && bound.type !== ':') {
            supertraits.push(this.extractTypeReference(bound));
          }
        }
      }

      const methods: FunctionDef[] = [];
      const associatedTypes: AssociatedTypeDef[] = [];
      const body = RustParser.findChildByType(node, 'declaration_list');

      if (body) {
        const fnSigs = RustParser.findAllByType(body, 'function_signature_item');
        const fnItems = RustParser.findAllByType(body, 'function_item');

        for (const sig of [...fnSigs, ...fnItems]) {
          const fnName = RustParser.findChildByType(sig, 'identifier');
          if (fnName) {
            const returnType = sig.childForFieldName('return_type');
            methods.push({
              name: this.getText(fnName),
              visibility: { kind: 'public' },
              generics: this.extractGenerics(sig),
              params: this.extractFunctionParams(sig),
              returnType: returnType ? this.extractTypeReference(returnType.children[1] ?? returnType) : null,
              isAsync: sig.children.some((c) => c.type === 'async'),
              isConst: sig.children.some((c) => c.type === 'const'),
              isUnsafe: sig.children.some((c) => c.type === 'unsafe'),
              bodyCallsites: this.extractCallsites(sig),
              span: RustParser.getSpan(sig),
            });
          }
        }

        const assocTypes = RustParser.findAllByType(body, 'associated_type');
        for (const assoc of assocTypes) {
          const typeName = RustParser.findChildByType(assoc, 'type_identifier');
          if (typeName) {
            associatedTypes.push({
              name: this.getText(typeName),
              bounds: [],
              default: null,
            });
          }
        }
      }

      traits.push({
        name: this.getText(nameNode),
        visibility: this.extractVisibility(node),
        generics: this.extractGenerics(node),
        supertraits,
        methods,
        associatedTypes,
        span: RustParser.getSpan(node),
      });
    }

    return traits;
  }

  extractImpls(root: SyntaxNode): ImplBlock[] {
    const impls: ImplBlock[] = [];
    const implNodes = RustParser.findAllByType(root, 'impl_item');

    for (const node of implNodes) {
      let traitRef: TypeReference | null = null;
      let selfType: TypeReference | null = null;

      const typeNode = node.childForFieldName('type');
      const traitNode = node.childForFieldName('trait');

      if (traitNode && typeNode) {
        traitRef = this.extractTypeReference(traitNode);
        selfType = this.extractTypeReference(typeNode);
      } else if (typeNode) {
        selfType = this.extractTypeReference(typeNode);
      }

      if (!selfType) continue;

      const methods: FunctionDef[] = [];
      const body = RustParser.findChildByType(node, 'declaration_list');

      if (body) {
        const fnItems = RustParser.findAllByType(body, 'function_item');
        for (const fn of fnItems) {
          const fnName = RustParser.findChildByType(fn, 'identifier');
          if (fnName) {
            const returnType = fn.childForFieldName('return_type');
            methods.push({
              name: this.getText(fnName),
              visibility: this.extractVisibility(fn),
              generics: this.extractGenerics(fn),
              params: this.extractFunctionParams(fn),
              returnType: returnType ? this.extractTypeReference(returnType.children[1] ?? returnType) : null,
              isAsync: fn.children.some((c) => c.type === 'async'),
              isConst: fn.children.some((c) => c.type === 'const'),
              isUnsafe: fn.children.some((c) => c.type === 'unsafe'),
              bodyCallsites: this.extractCallsites(fn),
              span: RustParser.getSpan(fn),
            });
          }
        }
      }

      impls.push({
        traitRef,
        selfType,
        generics: this.extractGenerics(node),
        methods,
        span: RustParser.getSpan(node),
      });
    }

    return impls;
  }

  extractUses(root: SyntaxNode): UseDeclaration[] {
    const uses: UseDeclaration[] = [];
    const useNodes = RustParser.findAllByType(root, 'use_declaration');

    for (const node of useNodes) {
      const visibility = this.extractVisibility(node);
      const useClause = node.children.find(
        (c) =>
          c.type === 'use_as_clause' ||
          c.type === 'scoped_use_list' ||
          c.type === 'use_wildcard' ||
          c.type === 'scoped_identifier' ||
          c.type === 'identifier'
      );

      if (!useClause) continue;

      const decl = this.parseUseClause(useClause, visibility, RustParser.getSpan(node));
      if (decl) {
        uses.push(decl);
      }
    }

    return uses;
  }

  private parseUseClause(
    node: SyntaxNode,
    visibility: Visibility,
    span: { start: { line: number; column: number }; end: { line: number; column: number } }
  ): UseDeclaration | null {
    const text = this.getText(node);

    if (node.type === 'use_wildcard') {
      const path = text.replace('::*', '').split('::');
      return {
        path,
        alias: null,
        isGlob: true,
        items: [],
        visibility,
        span,
      };
    }

    if (node.type === 'use_as_clause') {
      const pathNode = node.children[0];
      const aliasNode = node.children.find((c) => c.type === 'identifier' && c !== pathNode);
      const path = this.getText(pathNode).split('::');
      return {
        path,
        alias: aliasNode ? this.getText(aliasNode) : null,
        isGlob: false,
        items: [],
        visibility,
        span,
      };
    }

    if (node.type === 'scoped_use_list') {
      const pathParts: string[] = [];
      const items: UseItem[] = [];

      for (const child of node.children) {
        if (child.type === 'identifier' || child.type === 'scoped_identifier' || child.type === 'crate') {
          pathParts.push(...this.getText(child).split('::'));
        } else if (child.type === 'use_list') {
          for (const item of child.children) {
            if (item.type === 'identifier') {
              items.push({ name: this.getText(item), alias: null });
            } else if (item.type === 'use_as_clause') {
              const nameNode = item.children[0];
              const aliasNode = item.children.find((c) => c.type === 'identifier' && c !== nameNode);
              items.push({
                name: this.getText(nameNode),
                alias: aliasNode ? this.getText(aliasNode) : null,
              });
            } else if (item.type === 'self') {
              items.push({ name: 'self', alias: null });
            }
          }
        }
      }

      return {
        path: pathParts,
        alias: null,
        isGlob: false,
        items,
        visibility,
        span,
      };
    }

    if (node.type === 'scoped_identifier' || node.type === 'identifier') {
      const path = text.split('::');
      return {
        path,
        alias: null,
        isGlob: false,
        items: [],
        visibility,
        span,
      };
    }

    return null;
  }

  extractConstants(root: SyntaxNode): ConstDef[] {
    const constants: ConstDef[] = [];
    const constNodes = RustParser.findAllByType(root, 'const_item');

    for (const node of constNodes) {
      const nameNode = RustParser.findChildByType(node, 'identifier');
      const typeNode = node.childForFieldName('type');

      if (nameNode) {
        constants.push({
          name: this.getText(nameNode),
          visibility: this.extractVisibility(node),
          typeRef: this.extractTypeReference(typeNode),
          span: RustParser.getSpan(node),
        });
      }
    }

    return constants;
  }

  extractStatics(root: SyntaxNode): StaticDef[] {
    const statics: StaticDef[] = [];
    const staticNodes = RustParser.findAllByType(root, 'static_item');

    for (const node of staticNodes) {
      const nameNode = RustParser.findChildByType(node, 'identifier');
      const typeNode = node.childForFieldName('type');
      const isMut = node.children.some((c) => c.type === 'mutable_specifier');

      if (nameNode) {
        statics.push({
          name: this.getText(nameNode),
          visibility: this.extractVisibility(node),
          typeRef: this.extractTypeReference(typeNode),
          isMut,
          span: RustParser.getSpan(node),
        });
      }
    }

    return statics;
  }

  extractTypeAliases(root: SyntaxNode): TypeAliasDef[] {
    const aliases: TypeAliasDef[] = [];
    const aliasNodes = RustParser.findAllByType(root, 'type_item');

    for (const node of aliasNodes) {
      const nameNode = RustParser.findChildByType(node, 'type_identifier');
      const typeNode = node.childForFieldName('type');

      if (nameNode) {
        aliases.push({
          name: this.getText(nameNode),
          visibility: this.extractVisibility(node),
          generics: this.extractGenerics(node),
          aliasedType: this.extractTypeReference(typeNode),
          span: RustParser.getSpan(node),
        });
      }
    }

    return aliases;
  }

  extractModDeclarations(root: SyntaxNode): string[] {
    const mods: string[] = [];
    const modNodes = RustParser.findAllByType(root, 'mod_item');

    for (const node of modNodes) {
      const nameNode = RustParser.findChildByType(node, 'identifier');
      const hasBody = RustParser.findChildByType(node, 'declaration_list') !== null;

      if (nameNode && !hasBody) {
        mods.push(this.getText(nameNode));
      }
    }

    return mods;
  }

  extractInlineModules(root: SyntaxNode): { name: string; node: SyntaxNode; isCfgTest: boolean }[] {
    const mods: { name: string; node: SyntaxNode; isCfgTest: boolean }[] = [];
    const modNodes = RustParser.findAllByType(root, 'mod_item');

    for (const node of modNodes) {
      const nameNode = RustParser.findChildByType(node, 'identifier');
      const body = RustParser.findChildByType(node, 'declaration_list');

      if (nameNode && body) {
        const isCfgTest = this.hasCfgTestAttribute(node);
        mods.push({
          name: this.getText(nameNode),
          node: body,
          isCfgTest,
        });
      }
    }

    return mods;
  }

  private hasCfgTestAttribute(node: SyntaxNode): boolean {
    // Look for attribute_item siblings before this node
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.type === 'attribute_item') {
        const text = this.getText(sibling);
        // Match #[cfg(test)] pattern
        if (text.includes('cfg') && text.includes('test')) {
          return true;
        }
      } else if (sibling.type !== 'line_comment' && sibling.type !== 'block_comment') {
        // Stop if we hit something other than attributes or comments
        break;
      }
      sibling = sibling.previousSibling;
    }
    return false;
  }

  extractAttributes(node: SyntaxNode): string[] {
    const attributes: string[] = [];
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.type === 'attribute_item') {
        attributes.push(this.getText(sibling));
      } else if (sibling.type !== 'line_comment' && sibling.type !== 'block_comment') {
        break;
      }
      sibling = sibling.previousSibling;
    }
    return attributes;
  }
}
