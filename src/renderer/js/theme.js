/**
 * MacroBoard - Blockly theme + toolbox definition.
 *
 * The theme API covers the canvas, grid, blocks and components. Anything the
 * theme API does not reach (toolbox DOM, tooltips, context menus, the flyout
 * background) is handled in css/blockly-dark.css.
 */
(function () {
  'use strict';
  const MB = window.MB;
  const Blockly = window.Blockly;
  const C = MB.constants;
  const catalog = MB.catalog;

  const COLOURS = C.COLOURS;
  const CATS = C.CATEGORIES;

  /** Per-category block styles, so every category reads as its own family. */
  function blockStyles() {
    return {
      mb_start: { colourPrimary: CATS.START.colour, colourSecondary: '#e0577f', colourTertiary: '#b84365' },
      mb_mouse: { colourPrimary: CATS.MOUSE.colour, colourSecondary: '#3d8fd1', colourTertiary: '#2f6fa5' },
      mb_keyboard: { colourPrimary: CATS.KEYBOARD.colour, colourSecondary: '#2bb88f', colourTertiary: '#1f8f6e' },
      mb_control: { colourPrimary: CATS.CONTROL.colour, colourSecondary: '#e08f3c', colourTertiary: '#b56f28' },
      mb_logic: { colourPrimary: CATS.LOGIC.colour, colourSecondary: '#e07a22', colourTertiary: '#b45c14' },
      mb_values: { colourPrimary: CATS.VALUES.colour, colourSecondary: '#8f7ad6', colourTertiary: '#6f5cae' },
    };
  }

  function defineTheme() {
    const theme = Blockly.Theme.defineTheme('MacroBoard-dark', {
      name: 'MacroBoard-dark',
      base: Blockly.Themes.Classic,
      blockStyles: blockStyles(),
      componentStyles: {
        workspaceBackgroundColour: COLOURS.background,
        toolboxBackgroundColour: '#12151f',
        toolboxForegroundColour: COLOURS.textDim,
        flyoutBackgroundColour: '#171b28',
        flyoutForegroundColour: COLOURS.textDim,
        flyoutOpacity: 0.97,
        scrollbarColour: '#333a52',
        insertionMarkerColour: '#9d86ff',
        insertionMarkerOpacity: 0.35,
        cursorColour: '#9d86ff',
        markerColour: '#9d86ff',
      },
      fontStyle: { family: 'Inter, Segoe UI, system-ui, sans-serif', weight: '500', size: 12 },
      // Draw a hat on start blocks, which is what makes them read as "when ... "
      startHats: true,
    });
    return theme;
  }

  /** The toolbox: one category per spec section, loaded from the block catalog. */
  function defineToolbox() {
    const S = catalog.START;
    const M = catalog.MOUSE;
    const K = catalog.KEYBOARD;
    const CT = catalog.CONTROL;
    const V = catalog.VALUE;
    const LG = catalog.LOGIC;

    const blockEntry = (type) => ({ kind: 'block', type });

    return {
      kind: 'categoryToolbox',
      contents: [
        {
          kind: 'category',
          name: 'Start',
          colour: CATS.START.colour,
          contents: [S.RUN, S.PRESS, S.HOLD, S.PIXEL, S.EVERY, S.AT, S.SCROLL].map(blockEntry),
        },
        {
          kind: 'category',
          name: 'Mouse',
          colour: CATS.MOUSE.colour,
          contents: [M.CLICK, M.MOVE_TO, M.MOVE_BY, M.MOVE_WITHIN, M.SCROLL].map(blockEntry),
        },
        {
          kind: 'category',
          name: 'Keyboard',
          colour: CATS.KEYBOARD.colour,
          contents: [K.TYPE, K.PRESS, K.PRESS_TIMES, K.HOLD].map(blockEntry),
        },
        {
          kind: 'category',
          name: 'Control',
          colour: CATS.CONTROL.colour,
          contents: [
            CT.WAIT,
            CT.WAIT_MS,
            CT.REPEAT,
            CT.REPEAT_UNTIL,
            CT.AT_ONCE,
            CT.BREAK,
            CT.CONTINUE,
            CT.WAIT_FOR_WINDOW,
            CT.RUN_MACRO,
            CT.RANDOM_CHOOSER,
            CT.ORGANIZED_CHOOSER,
            CT.IF,
          ].map(blockEntry),
        },
        {
          kind: 'category',
          name: 'Logic',
          colour: CATS.LOGIC.colour,
          contents: [
            { kind: 'label', text: 'Drop these into the <> socket on an if block' },
            LG.PIXEL_IS,
            LG.EQUALS,
            LG.GREATER,
            LG.LESS,
            LG.AND,
            LG.OR,
            LG.NOT,
          ].map((e) => (typeof e === 'string' ? blockEntry(e) : e)),
        },
        {
          kind: 'category',
          name: 'Values',
          colour: CATS.VALUES.colour,
          contents: [
            { kind: 'label', text: 'Chips for a numeric socket' },
            V.NUMBER,
            V.FOREVER,
            V.RANGE,
          ].map((e) => (typeof e === 'string' ? blockEntry(e) : e)),
        },
      ],
    };
  }

  MB.theme = { defineTheme, defineToolbox };
})();



