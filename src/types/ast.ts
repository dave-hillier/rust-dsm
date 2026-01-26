export interface Position {
  line: number;
  column: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export interface TypeReference {
  name: string;
  resolvedPath: string | null;
  typeParameters: TypeReference[];
  span: Span;
}

export interface Visibility {
  kind: 'public' | 'private' | 'crate' | 'super' | 'in_path';
  path?: string;
}

export interface GenericParam {
  name: string;
  bounds: TypeReference[];
}

export interface FieldDef {
  name: string | null;
  visibility: Visibility;
  typeRef: TypeReference;
  span: Span;
}

export interface StructDef {
  name: string;
  visibility: Visibility;
  generics: GenericParam[];
  fields: FieldDef[];
  span: Span;
}

export interface EnumVariant {
  name: string;
  fields: FieldDef[];
  span: Span;
}

export interface EnumDef {
  name: string;
  visibility: Visibility;
  generics: GenericParam[];
  variants: EnumVariant[];
  span: Span;
}

export interface FunctionParam {
  name: string;
  typeRef: TypeReference;
  isSelf: boolean;
  selfKind?: 'value' | 'ref' | 'mut_ref';
}

export interface FunctionDef {
  name: string;
  visibility: Visibility;
  generics: GenericParam[];
  params: FunctionParam[];
  returnType: TypeReference | null;
  isAsync: boolean;
  isConst: boolean;
  isUnsafe: boolean;
  bodyCallsites: Callsite[];
  span: Span;
}

export interface Callsite {
  functionPath: string;
  isMethodCall: boolean;
  receiverType: TypeReference | null;
  span: Span;
}

export interface TraitDef {
  name: string;
  visibility: Visibility;
  generics: GenericParam[];
  supertraits: TypeReference[];
  methods: FunctionDef[];
  associatedTypes: AssociatedTypeDef[];
  span: Span;
}

export interface AssociatedTypeDef {
  name: string;
  bounds: TypeReference[];
  default: TypeReference | null;
}

export interface ImplBlock {
  traitRef: TypeReference | null;
  selfType: TypeReference;
  generics: GenericParam[];
  methods: FunctionDef[];
  span: Span;
}

export interface UseDeclaration {
  path: string[];
  alias: string | null;
  isGlob: boolean;
  items: UseItem[];
  visibility: Visibility;
  span: Span;
}

export interface UseItem {
  name: string;
  alias: string | null;
}

export interface ModuleDefinition {
  name: string;
  path: string;
  filePath: string;
  visibility: Visibility;
  structs: StructDef[];
  enums: EnumDef[];
  traits: TraitDef[];
  functions: FunctionDef[];
  impls: ImplBlock[];
  uses: UseDeclaration[];
  submodules: ModuleDefinition[];
  constants: ConstDef[];
  statics: StaticDef[];
  typeAliases: TypeAliasDef[];
}

export interface ConstDef {
  name: string;
  visibility: Visibility;
  typeRef: TypeReference;
  span: Span;
}

export interface StaticDef {
  name: string;
  visibility: Visibility;
  typeRef: TypeReference;
  isMut: boolean;
  span: Span;
}

export interface TypeAliasDef {
  name: string;
  visibility: Visibility;
  generics: GenericParam[];
  aliasedType: TypeReference;
  span: Span;
}

export interface CrateDefinition {
  name: string;
  rootModule: ModuleDefinition;
  cratePath: string;
  isLibrary: boolean;
}

export interface WorkspaceDefinition {
  name: string;
  crates: CrateDefinition[];
  workspacePath: string;
}
