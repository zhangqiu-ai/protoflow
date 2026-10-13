document.getElementById('form').addEventListener('submit', event => {
  event.preventDefault();
  const input = document.getElementById('task');
  const error = document.getElementById('error');
  if (!input.value.trim()) { error.hidden = false; return; }
  error.hidden = true;
  const item = document.createElement('li');
  item.setAttribute('data-pf', 'tasks.item');
  item.setAttribute('data-pf-repeat', '');
  item.textContent = input.value.trim();
  document.getElementById('list').append(item);
  input.value = '';
});
