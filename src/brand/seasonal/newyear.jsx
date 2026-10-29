/**
 * New Year: a firework burst with sparkles at the top right of the mark,
 * in the brand violet with gold accents (distinct from Christmas red and the
 * Halloween orange). Drawn in the mark's coordinates: the main burst is
 * centred at (112, 12), a smaller one at (126, 36), with four-point sparkles
 * and a few gold dots of confetti between them. It overflows the mark's box
 * to the right and above; the mark is untouched. Chosen over confetti alone
 * because the rays stay readable at the rail's 36 px. The violet paints
 * through a theme variable (src/index.css): the gradient themes set pale
 * lilac sparks that read on their rails; the gold reads on all of them.
 */
const VIOLET = '#8E6CF0';
const GOLD = '#F5C542';
const GOLD_LIGHT = '#FFD86B';
const violet = `var(--decor-spark, ${VIOLET})`;

// a four-point sparkle centred on the origin, 1 unit = its half-size
const SPARK = 'M0 -1 C 0.12 -0.3, 0.3 -0.12, 1 0 C 0.3 0.12, 0.12 0.3, 0 1 C -0.12 0.3, -0.3 0.12, -1 0 C -0.3 -0.12, -0.12 -0.3, 0 -1 Z';
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

export default {
  id: 'newyear',
  name: 'New Year fireworks',
  // 28 December - 3 January, inclusive, wrapping over the year's end
  window: { from: [12, 28], to: [1, 3] },
  colours: [
    { part: 'violet rays and sparkles', variable: '--decor-spark', fallback: VIOLET, on: ['rail', 'hero'] },
    { part: 'gold rays', fallback: GOLD, on: ['rail', 'hero'] },
    { part: 'light gold sparkles', fallback: GOLD_LIGHT, on: ['rail', 'hero'] },
  ],
  render: () => (
    <g data-decoration="newyear">
      {/* the main burst: eight rays, gold and violet alternating */}
      <g transform="translate(112 12)" fill="none" strokeWidth="2.2" strokeLinecap="round">
        {RAYS.map((deg, i) => (
          <line key={deg} x1="0" y1="-5" x2="0" y2="-13" stroke={i % 2 ? violet : GOLD} transform={`rotate(${deg})`} />
        ))}
        <circle r="2.2" fill={GOLD_LIGHT} stroke="none" />
      </g>
      {/* a smaller burst lower right */}
      <g transform="translate(127 38)" fill="none" strokeWidth="1.8" strokeLinecap="round">
        {RAYS.map((deg, i) => (
          <line key={deg} x1="0" y1="-3" x2="0" y2="-8" stroke={i % 2 ? GOLD : violet} transform={`rotate(${deg})`} />
        ))}
      </g>
      {/* sparkles and confetti */}
      <path d={SPARK} transform="translate(96 4) scale(5)" fill={GOLD_LIGHT} />
      <path d={SPARK} transform="translate(132 20) scale(3.5)" fill={violet} />
      <path d={SPARK} transform="translate(104 34) scale(2.8)" fill={GOLD} />
      <circle cx="122" cy="-2" r="1.8" fill={violet} />
      <circle cx="136" cy="6" r="1.5" fill={GOLD} />
      <circle cx="118" cy="26" r="1.4" fill={GOLD_LIGHT} />
    </g>
  ),
};
