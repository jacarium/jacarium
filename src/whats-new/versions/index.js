/**
 * Version History Index
 *
 * This file exports all version features sorted by newest first.
 * Add new versions at the top of the imports and versions array.
 */

import * as v3_2_4 from './v3.2.4.js';
import * as v3_2_3 from './v3.2.3.js';
import * as v3_2_2 from './v3.2.2.js';
import * as v3_2_1 from './v3.2.1.js';
import * as v3_2_0 from './v3.2.0.js';
import * as v3_1_9 from './v3.1.9.js';
import * as v3_1_8 from './v3.1.8.js';
import * as v3_1_7 from './v3.1.7.js';
import * as v3_1_6 from './v3.1.6.js';
import * as v3_1_5 from './v3.1.5.js';
import * as v3_1_4 from './v3.1.4.js';
import * as v3_1_3 from './v3.1.3.js';
import * as v3_1_2 from './v3.1.2.js';
import * as v3_1_1 from './v3.1.1.js';
import * as v3_1_0 from './v3.1.0.js';
import * as v3_0_3 from './v3.0.3.js';
import * as v3_0_2 from './v3.0.2.js';
import * as v3_0_1 from './v3.0.1.js';
import * as v3_0_0 from './v3.0.0.js';
import * as v2_6_0 from './v2.6.0.js';
import * as v2_5_5 from './v2.5.5.js';
import * as v2_5_4 from './v2.5.4.js';
import * as v2_5_3 from './v2.5.3.js';
import * as v2_5_2 from './v2.5.2.js';
import * as v2_5_1 from './v2.5.1.js';
import * as v2_5_0 from './v2.5.0.js';
import * as v2_4_21 from './v2.4.21.js';
import * as v2_4_20 from './v2.4.20.js';
import * as v2_4_19 from './v2.4.19.js';

// Export all versions sorted by newest first
export const versions = [
  v3_2_4,
  v3_2_3,
  v3_2_2,
  v3_2_1,
  v3_2_0,
  v3_1_9,
  v3_1_8,
  v3_1_7,
  v3_1_6,
  v3_1_5,
  v3_1_4,
  v3_1_3,
  v3_1_2,
  v3_1_1,
  v3_1_0,
  v3_0_3,
  v3_0_2,
  v3_0_1,
  v3_0_0,
  v2_6_0,
  v2_5_5,
  v2_5_4,
  v2_5_3,
  v2_5_2,
  v2_5_1,
  v2_5_0,
  v2_4_21,
  v2_4_20,
  v2_4_19,
];

// Export the latest version info
export const latestVersion = versions[0].version;
export const latestFeatures = versions[0].features;

// Helper to get all features across all versions
export function getAllFeatures() {
  return versions.flatMap(v => v.features);
}
