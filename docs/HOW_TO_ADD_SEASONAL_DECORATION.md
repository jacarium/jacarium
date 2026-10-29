# How to add a seasonal decoration to the logo

The in-app mark (the top-left logo and Settings > About) can wear a
seasonal decoration: the Halloween pumpkin, the Santa hat, the New Year
fireworks, the 4 May light sword. The mark itself never changes - size, position, colours - a
decoration is an extra SVG group drawn after it, allowed to overflow its box.

## Windows (local date, inclusive, every year)

| decoration | id          | window            |
|------------|-------------|-------------------|
| pumpkin    | `pumpkin`   | 20 Oct - 2 Nov    |
| Santa hat  | `christmas` | 1 Dec - 27 Dec    |
| fireworks  | `newyear`   | 28 Dec - 3 Jan    |
| light sword | `may-the-fourth` | 4 May        |

The switch is `src/brand/seasonal/active.js`: `ACTIVE_DECORATION = 'auto'`
follows the dates, `'none'` turns every decoration off, a decoration id
forces that one regardless of the date. For a preview in one browser set
`localStorage['brand-decoration']` to the same values.

## Adding one

1. Create `src/brand/seasonal/<name>.jsx` exporting
   `{ id, name, window: { from: [month, day], to: [month, day] }, colours,
   render }`. `render()` returns a `<g data-decoration="<id>">` in the
   mark's coordinates (the 120 x 120 box; the arch spans 22..98 x 16..110,
   its top is (60, 16)); a window may wrap over New Year (`from` in
   December, `to` in January) or be a single day (`from` equal to `to`).
   Original shapes only - no third-party logos, lettering or characters.
2. Add it to `DECORATIONS` in `src/brand/seasonal/index.js`. Keep the
   windows free of overlaps; if two overlap, the first in the list wins.
3. Run `node tests/brand-seasonal.test.mjs` (the plain mark must stay byte
   for byte the same, every window's boundaries, the overrides, and the
   contrast of every colour on every theme) and look at the rail and About
   on each theme (`node tests/brand-seasonal-visual.test.mjs` takes the
   screenshots and a grid per decoration).

## Colours and themes

The mark sits on very different surfaces: the dark rail (dark in the light
theme too), a gradient theme's top colour (Magma's red, Vulkan's green,
...), the light or the dark About hero, and the arch itself, which the
gradient themes paint tinted white. A decoration's colours are its own on
Light and the dark themes - that look is the approved one and gets no
outline. Where a colour would not read on a gradient theme's rail, it
paints through a CSS variable the theme sets (`src/index.css`, the block
after the mark's gradient variables: the New Year's violet becomes a pale
lilac there); the pumpkin, the Santa hat and the sword are the same
everywhere, by choice. The sword's blade and hilt take a one-unit edge
through `--decor-blade-edge`: a mid blue on Light, so the pale blade reads
on the light About hero, the theme's own deep tone on the gradient themes,
where the blade crosses the tinted-white arch, none on the dark themes. Each
decoration lists its colours (`colours`: the variable if any, the default,
the surfaces the part lies on, whether it takes an edge) and the test
computes, for each theme, that every colour has at least 3:1 against each
surface - by the colour or by the edge - the same way `tests/brand.test.mjs`
measures the mark; the shortfalls the user accepted knowingly (the light
hero under bright shapes, the arch under the parts crossing it, the one
pumpkin and the one hat on the gradients' rails) are listed in the test,
printed with their values, and must not grow.

The app re-reads the date when it starts, when the window regains focus or
becomes visible, and once an hour, so a decoration appears and disappears
on its day without a restart.
