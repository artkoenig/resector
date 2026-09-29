// Markdown files imported as text (`with { type: 'text' }`): prompts live in their own files, easy to edit.
declare module '*.md' {
  const text: string;
  export default text;
}
