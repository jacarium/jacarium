/**
 * Halloween: a pumpkin at the bottom right of the mark, the website's own
 * (the 140 x 124 reference box shares the mark's coordinates: the arch at
 * 22..98 x 16..110; the pumpkin is translated to (80, 66.7) and scaled 2.36
 * there, which is what this group does inside the mark's 120 x 120 box -
 * it overflows the box to the right and below, as intended). A violet stem
 * instead of a green one, orange lobes, a near-black face that reads on the
 * dark rail and on light surfaces alike. The same pumpkin on every theme,
 * the gradient ones included - the user's choice, knowing that the orange
 * sits under 3:1 on Sunset's orange and Vulkan's green rail (the test lists
 * the shortfalls); no theme variables, no edge.
 */
const STEM = '#8E6CF0';
const LOBE = '#E8702A';
const LOBE_FRONT = '#FF8A3D';
const FACE = '#0F0D16';

export default {
  id: 'pumpkin',
  name: 'Halloween pumpkin',
  // 20 October - 2 November, inclusive, every year
  window: { from: [10, 20], to: [11, 2] },
  // the colours, for tests/brand-seasonal.test.mjs's contrast check: each part's colour (a theme variable where
  // one paints it), the surfaces the part lies on (the rail, the About hero, the arch), whether it takes an edge
  colours: [
    { part: 'lobe', fallback: LOBE, on: ['rail', 'hero', 'arch'] },
    { part: 'front lobe', fallback: LOBE_FRONT, on: ['rail', 'hero', 'arch'] },
    { part: 'stem', fallback: STEM, on: ['rail', 'hero'] },
  ],
  render: () => (
    <g data-decoration="pumpkin" transform="translate(80 66.7) scale(2.36)">
      <path d="M12.3 7.2c-.3-2.2.5-3.9 2.3-5" fill="none" stroke={STEM} strokeWidth="2.2" strokeLinecap="round" />
      <ellipse cx="7.2" cy="14.5" rx="5.6" ry="7.4" fill={LOBE} />
      <ellipse cx="16.8" cy="14.5" rx="5.6" ry="7.4" fill={LOBE} />
      <ellipse cx="12" cy="14.5" rx="5.8" ry="8" fill={LOBE_FRONT} />
      <path d="M8 13.4l1.9-2.8 1.9 2.8zM12.2 13.4l1.9-2.8 1.9 2.8z" fill={FACE} />
      <path d="M7.8 16.6l1.5 1.3 1.4-1.3 1.3 1.3 1.3-1.3 1.4 1.3 1.5-1.3" fill="none" stroke={FACE} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </g>
  ),
};
