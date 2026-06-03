// #35 — code palette + theme boards (drag/drop): pure state reducer.

export interface PaletteState {
  // highlight id -> set of code ids
  codesByHighlight: Record<string, string[]>
  // theme id -> code ids on the board
  themeBoards: Record<string, string[]>
}

export type PaletteAction =
  | { type: 'assignCode'; highlightId: string; codeId: string }
  | { type: 'unassignCode'; highlightId: string; codeId: string }
  | { type: 'dropCodeOnTheme'; themeId: string; codeId: string }
  | { type: 'removeCodeFromTheme'; themeId: string; codeId: string }

function uniqPush(arr: string[] | undefined, v: string): string[] {
  const a = arr ?? []
  return a.includes(v) ? a : [...a, v]
}

export function paletteReducer(state: PaletteState, action: PaletteAction): PaletteState {
  switch (action.type) {
    case 'assignCode':
      return {
        ...state,
        codesByHighlight: {
          ...state.codesByHighlight,
          [action.highlightId]: uniqPush(state.codesByHighlight[action.highlightId], action.codeId),
        },
      }
    case 'unassignCode':
      return {
        ...state,
        codesByHighlight: {
          ...state.codesByHighlight,
          [action.highlightId]: (state.codesByHighlight[action.highlightId] ?? []).filter(
            (c) => c !== action.codeId,
          ),
        },
      }
    case 'dropCodeOnTheme':
      return {
        ...state,
        themeBoards: {
          ...state.themeBoards,
          [action.themeId]: uniqPush(state.themeBoards[action.themeId], action.codeId),
        },
      }
    case 'removeCodeFromTheme':
      return {
        ...state,
        themeBoards: {
          ...state.themeBoards,
          [action.themeId]: (state.themeBoards[action.themeId] ?? []).filter(
            (c) => c !== action.codeId,
          ),
        },
      }
  }
}

export const emptyPalette: PaletteState = { codesByHighlight: {}, themeBoards: {} }
