// The profile picker page's script (CSP: no inline scripts). Talks to the
// main process only through the bridge profile-picker-preload.cjs exposes.
(function () {
  const list = document.getElementById('profiles');
  const form = document.getElementById('create');
  const nameInput = document.getElementById('name');
  const remember = document.getElementById('remember');
  const error = document.getElementById('error');
  const api = window.profilePicker;

  function when(date) {
    if (!date) return 'never opened';
    const d = new Date(date);
    return Number.isNaN(d.getTime()) ? 'never opened' : `last opened ${d.toLocaleString()}`;
  }

  async function render() {
    const profiles = await api.list();
    list.textContent = '';
    for (const profile of profiles) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.profile = profile.name;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = profile.displayName + (profile.isDefault ? ' (default)' : '');
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${profile.name} - ${profile.exists ? when(profile.lastUsedAt) : 'new'}`;
      button.append(name, meta);
      button.addEventListener('click', () => choose(profile.name));
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  async function choose(name) {
    error.textContent = '';
    try {
      await api.choose(name, remember.checked);
    } catch (err) {
      error.textContent = err && err.message ? err.message : String(err);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      const created = await api.create(nameInput.value);
      await api.choose(created.name, remember.checked);
    } catch (err) {
      error.textContent = err && err.message ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(err);
    }
  });

  render().catch((err) => { error.textContent = String(err); });
})();
