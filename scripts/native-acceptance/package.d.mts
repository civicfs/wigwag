export function fingerprintPackage(root: string): { files: Record<string, string>; sha256: string };
export function stagePackage(source: string, target: string, expectedHash: string): { code_sha256: string; dependency_root: string | null; previous_package: string };
