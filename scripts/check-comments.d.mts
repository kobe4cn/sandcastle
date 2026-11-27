// scripts/check-comments.mjs 的类型声明，给测试用。
// Type declarations for scripts/check-comments.mjs, used by tests.
export interface CommentBlock {
  kind: "line" | "block";
  trailing: boolean;
  line: number;
  endLine: number;
  text: string;
}
export function commentBlocks(text: string, fileName?: string): CommentBlock[];
export function missingLanguage(comment: string): "zh" | "en" | undefined;
