// Vite config for the tests/linux harness: the repo's real config, minus file
// watching. The dev server only has to serve the app for a headless browser,
// and watching the whole mounted repo (backend/venv alone has tens of
// thousands of files) blows through the container VM's inotify limit
// (ENOSPC: System limit for number of file watchers reached).
//
// `server.watch: null` is Vite's "disable the watcher" value; it is assigned
// after the merge because mergeConfig() skips null overrides.
import base from '../../../vite.config.js';

const config = { ...base, server: { ...(base.server || {}), watch: null } };

export default config;
