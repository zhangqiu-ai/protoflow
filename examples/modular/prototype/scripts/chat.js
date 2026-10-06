document.querySelector('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const field = document.querySelector('#message');
  const value = field.value.trim();
  if (!value) return;
  const item = document.createElement('li');
  const author = document.createElement('strong');
  const message = document.createElement('p');
  author.textContent = 'You';
  message.textContent = value;
  item.append(author, message);
  document.querySelector('#messages').append(item);
  field.value = '';
});
