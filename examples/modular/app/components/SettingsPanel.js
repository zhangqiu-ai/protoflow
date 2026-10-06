export function mountSettingsPanel(container) {
  container.innerHTML = '<h1 id="settings-title">Settings</h1><p class="description">Choose the name shown to your collaborators.</p><form id="settings-form"><label for="display-name">Display name</label><input id="display-name" name="display-name" value="Alex" required><button id="save-settings" type="submit">Save settings</button></form><p id="settings-status" role="status" hidden></p>';
  container.querySelector('#settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = container.querySelector('#display-name').value.trim();
    if (!name) return;
    const status = container.querySelector('#settings-status');
    status.textContent = `Display name saved: ${name}`;
    status.hidden = false;
  });
}
