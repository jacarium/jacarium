// Extract each <script> block from the HTML rendered by render_check.py
// (in /tmp/diag-scratch/) and node --check it. Run: node extract_check.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

for (const name of ['rendered_cpu.html', 'rendered_memory.html']) {
  const file = '/tmp/diag-scratch/' + name;
  const html = readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (blocks.length === 0) { console.error(`${file}: NO SCRIPT BLOCKS FOUND`); process.exitCode = 1; continue; }
  blocks.forEach((js, i) => {
    const p = `${file}.script${i}.js`;
    writeFileSync(p, js);
    try {
      execFileSync('node', ['--check', p], { stdio: 'pipe' });
      console.log(`${file} script #${i}: syntax OK (${js.length} bytes)`);
    } catch (e) {
      console.error(`${file} script #${i}: SYNTAX ERROR\n${e.stderr}`);
      process.exitCode = 1;
    }
  });
}
