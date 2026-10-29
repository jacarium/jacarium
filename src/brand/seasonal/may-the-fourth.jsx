/**
 * 4 May: a generic nod to the day in the flat style - a glowing light sword
 * crossing the bottom right of the mark (a blue glow around a pale core,
 * a light lilac hilt with a dark ring and a short guard) and three small four-point stars around
 * the top. Original shapes only: no lettering, logos, characters or
 * silhouettes of anyone's property. Drawn in the mark's coordinates: the
 * hilt from (72, 120) to (82, 106), the blade from there to (126, 46),
 * overflowing the box to the right; the stars at the top right and left.
 * The mark itself is untouched. The same sword on every theme - the user's
 * choice of the cyan-white, opaque glow that reads on every rail (Nebula's
 * blue above all) and on the violet arch - with a one-unit edge under the
 * blade and the hilt through --decor-blade-edge (src/index.css): a mid blue
 * on Light, where the pale blade would otherwise sink into the light About
 * hero, the theme's deep tone on the gradient themes, where the blade
 * crosses the tinted-white arch, none on the dark themes.
 */
const GLOW = '#9BE7FF';
const CORE = '#F5F2FF';
const HILT = '#D6CCF5';     // light lilac: reads on every rail (3.1:1 on Sunset's orange) and over the arch's corner
const GRIP = '#2A2340';     // the dark ring on the grip
const STAR = '#FFD86B';
const edge = 'var(--decor-blade-edge, none)';

// a four-point star centred on the origin, 1 unit = its half-size
const SPARK = 'M0 -1 C 0.12 -0.3, 0.3 -0.12, 1 0 C 0.3 0.12, 0.12 0.3, 0 1 C -0.12 0.3, -0.3 0.12, -1 0 C -0.3 -0.12, -0.12 -0.3, 0 -1 Z';

export default {
  id: 'may-the-fourth',
  name: 'May the Fourth light sword',
  // 4 May only, every year
  window: { from: [5, 4], to: [5, 4] },
  colours: [
    { part: 'blade glow', fallback: GLOW, on: ['rail', 'hero', 'arch'], edged: 'blade' },
    { part: 'hilt', fallback: HILT, on: ['rail', 'hero', 'arch'], edged: 'blade' },
    { part: 'stars', fallback: STAR, on: ['rail', 'hero'] },
  ],
  render: () => (
    <g data-decoration="may-the-fourth">
      {/* the blade: the edge (where the theme sets one), the glow, then the core */}
      <line x1="82" y1="106" x2="126" y2="46" stroke={edge} strokeWidth="11" strokeLinecap="round" />
      <line x1="82" y1="106" x2="126" y2="46" stroke={GLOW} strokeWidth="9" strokeLinecap="round" />
      <line x1="82" y1="106" x2="126" y2="46" stroke={CORE} strokeWidth="2.2" strokeLinecap="round" />
      {/* the hilt (its edge first): the grip with a dark ring, and the guard across the blade's foot */}
      <line x1="72" y1="120" x2="82" y2="106" stroke={edge} strokeWidth="7" strokeLinecap="round" />
      <line x1="77" y1="103" x2="87" y2="109.5" stroke={edge} strokeWidth="5" strokeLinecap="round" />
      <line x1="72" y1="120" x2="82" y2="106" stroke={HILT} strokeWidth="5" strokeLinecap="round" />
      <line x1="75.5" y1="115" x2="78" y2="111.5" stroke={GRIP} strokeWidth="5.4" strokeLinecap="butt" />
      <line x1="77" y1="103" x2="87" y2="109.5" stroke={HILT} strokeWidth="3" strokeLinecap="round" />
      {/* three small stars around the top */}
      <path d={SPARK} transform="translate(108 10) scale(4)" fill={STAR} />
      <path d={SPARK} transform="translate(122 28) scale(2.6)" fill={STAR} />
      <path d={SPARK} transform="translate(12 24) scale(2.6)" fill={STAR} />
    </g>
  ),
};
