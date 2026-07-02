// Ambient module declaration — upstream ships CJS with no types.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  type Plugin = TurndownService.Plugin;
  export const gfm: Plugin;
  export const tables: Plugin;
  export const strikethrough: Plugin;
  export const taskListItems: Plugin;
}
