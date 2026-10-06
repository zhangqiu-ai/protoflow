document.querySelector('#settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = document.querySelector('#display-name').value.trim();
  if (!name) return;
  const status = document.querySelector('#settings-status');
  status.textContent = `Display name saved: ${name}`;
  status.hidden = false;
});
