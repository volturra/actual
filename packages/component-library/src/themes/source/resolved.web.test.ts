import { formatHex, formatHex8 } from 'culori';

import { colors } from './colors';
import { palette } from './palette';
import { resolveToken } from './resolve';
import { themeNames } from './types';

describe('resolved theme colors', () => {
  it.each(themeNames)('%s resolves every token', theme => {
    const resolved = Object.fromEntries(
      Object.entries(colors).map(([name, definition]) => {
        // Tokens mixed from currentColor depend on where they're used, so
        // they have no fixed value; record their CSS instead.
        if (JSON.stringify(definition).includes('currentColor')) {
          return [name, 'depends on currentColor'];
        }
        const color = resolveToken(name, theme, colors, palette);
        const value = { mode: 'rgb' as const, ...color };
        return [name, color.alpha < 1 ? formatHex8(value) : formatHex(value)];
      }),
    );

    expect(resolved).toMatchSnapshot();
  });
});
