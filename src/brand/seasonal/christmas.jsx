/**
 * Christmas: a Santa hat on the arch. Drawn in the mark's own coordinates
 * (the arch's top is the point (60, 16), the arch spans x = 22..98): the fur
 * band (BAND, a quadratic from (16, 37) over the arch's top to (104, 33),
 * 10 wide - as wide as the mark, tilted a little) covers the arch's top;
 * the body's base runs along the band's own centre line between two inset
 * points on it (t = 0.1 and 0.9 of BAND), so no red lies below or beside
 * the band; the body is broad at the base (x = 24..95), rises to a crown at
 * y = -18 and droops to the right into the tip, the pompom hangs off it at
 * (116, 1). The hat overflows the mark's box upward (to about y = -20, 6 px
 * above a 36 px mark) and slightly to the right; the mark itself is
 * untouched. Red chosen to sit with the brand violet, the fur and pompom an
 * off-white with a pale lilac rim so they read on the dark rail and on the
 * light About hero alike. The same hat on every theme, the gradient ones
 * included - the user's choice, knowing that the red sits under 3:1 on
 * their rails (1.1:1 on Sunset's orange, 1.8:1 on Magma's red) and the
 * fur over their tinted-white arches (the test lists the shortfalls); no
 * theme variables.
 */
const RED = '#D93A3A';
const RED_SHADE = '#B52F2F';
const FUR = '#F5F2FF';
const FUR_RIM = '#D6CCF0';
const BAND = 'M16 37 Q 58 2 104 33';

export default {
  id: 'christmas',
  name: 'Santa hat',
  // 1 - 27 December, inclusive; New Year takes over on the 28th
  window: { from: [12, 1], to: [12, 27] },
  colours: [
    { part: 'body', fallback: RED, on: ['rail', 'hero'] },
    { part: 'fur', fallback: FUR, on: ['rail', 'hero', 'arch'], edged: true, edgeFallback: FUR_RIM },
  ],
  render: () => (
    <g data-decoration="christmas">
      {/* the body: base right (on the band's centre line) -> the right edge up -> the droop's underside out to the tip
          -> the tip's top back to the crown -> the left edge down to base left -> the base along the band's centre line
          (the sub-curve of BAND between t = 0.1 and 0.9: (24.4, 30.7) - ctrl (58.4, 7.9) - (94.8, 27.5)) */}
      <path d="M94.8 27.5 C 93 18, 90 8, 92 0 C 96 -6, 104 -8, 114 -2 C 106 -14, 90 -22, 70 -18 C 50 -14, 32 6, 24.4 30.7 Q 58.4 7.9 94.8 27.5 Z" fill={RED} />
      {/* the fold's shade along the right edge and the droop's underside (ends on the base curve, under the band) */}
      <path d="M94.8 27.5 C 93 18, 90 8, 92 0 C 96 -6, 104 -8, 114 -2 C 106 -4, 100 -2, 97 4 C 94 10, 92 18, 90 24.5 Z" fill={RED_SHADE} />
      {/* the fur band over the arch's top, as wide as the mark: a pale lilac rim (1 unit) under the fur keeps
          it visible on light surfaces such as the About hero, where the fur alone would vanish; on the dark rail
          the rim is one shade off near-white and does not show */}
      <path d={BAND} fill="none" stroke={FUR_RIM} strokeWidth="12" strokeLinecap="round" />
      <path d={BAND} fill="none" stroke={FUR} strokeWidth="10" strokeLinecap="round" />
      {/* the pompom, with the same rim */}
      <circle cx="116" cy="1" r="7" fill={FUR} stroke={FUR_RIM} strokeWidth="2" />
    </g>
  ),
};
