export function mountChatPanel(container) {
  container.innerHTML = '<h1 id="chat-title">Chat</h1><p class="description">Discuss one prototype decision at a time.</p><ul id="messages" aria-label="Messages"><li><strong>Design team</strong><p>Prototype decisions stay visible.</p></li></ul><form id="chat-form"><label for="message">Message</label><textarea id="message" name="message" rows="3" placeholder="Write a message" required></textarea><button id="send-message" type="submit">Send message</button></form>';
  const form = container.querySelector('#chat-form');
  const field = container.querySelector('#message');
  const messages = container.querySelector('#messages');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    const item = document.createElement('li');
    const author = document.createElement('strong');
    const message = document.createElement('p');
    author.textContent = 'You';
    message.textContent = value;
    item.append(author, message);
    messages.append(item);
    field.value = '';
  });
}
