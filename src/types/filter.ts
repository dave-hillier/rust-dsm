export interface FilterConfig {
  excludePatterns: string[];
  includePatterns: string[];
  excludeTestFiles: boolean;
  excludeTestsDirectory: boolean;
  excludeCfgTest: boolean;
}

export function createDefaultFilterConfig(): FilterConfig {
  return {
    excludePatterns: [],
    includePatterns: [],
    excludeTestFiles: false,
    excludeTestsDirectory: false,
    excludeCfgTest: false,
  };
}

export function createNoTestsFilterConfig(): FilterConfig {
  return {
    excludePatterns: [],
    includePatterns: [],
    excludeTestFiles: true,
    excludeTestsDirectory: true,
    excludeCfgTest: true,
  };
}
