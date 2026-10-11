// Desktop renderer: hash-routed screens built from state, carrying the prototype's anchor IDs as data-testid.
const state = { tasks: ['Review prototype', 'Ship version'], error: false, saved: false, reminder: false };

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'text') node.textContent = value;
    else if (name === 'hidden') node.hidden = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

const screens = {
  tasks() {
    const field = element('input', { 'data-testid': 'tasks.input', type: 'text', placeholder: 'New task' });
    const problem = element('p', { 'data-testid': 'tasks.error', class: 'error', text: 'Enter a task first.', hidden: !state.error });
    const list = element('ul', { 'data-testid': 'tasks.list' }, state.tasks.map(title => element('li', { 'data-testid': 'tasks.item', text: title })));
    const form = element('form', { 'data-testid': 'tasks.form', onsubmit(event) {
      event.preventDefault();
      const title = field.value.trim();
      state.error = !title;
      if (title) state.tasks.push(title);
      render();
    } }, [field, element('button', { 'data-testid': 'tasks.add', type: 'submit', text: 'Add' })]);
    return element('main', { class: 'screen', 'data-testid': 'tasks' }, [
      element('header', { 'data-testid': 'tasks.header' }, [
        element('h1', { 'data-testid': 'tasks.title', text: 'Today' }),
        element('a', { 'data-testid': 'tasks.settings', href: '#/settings', text: 'Settings' })
      ]),
      list, form, problem
    ]);
  },
  settings() {
    const toggle = element('input', { 'data-testid': 'settings.notify-toggle', type: 'checkbox', onchange(event) { state.reminder = event.target.checked; } });
    toggle.checked = state.reminder;
    return element('main', { class: 'screen', 'data-testid': 'settings' }, [
      element('header', { 'data-testid': 'settings.header' }, [
        element('h1', { 'data-testid': 'settings.title', text: 'Settings' }),
        element('a', { 'data-testid': 'settings.back', href: '#/tasks', text: 'Back' })
      ]),
      element('label', { 'data-testid': 'settings.notify' }, [toggle, ' Daily reminder']),
      element('button', { 'data-testid': 'settings.save', type: 'button', text: 'Save', onclick() { state.saved = true; render(); } }),
      element('p', { 'data-testid': 'settings.saved', class: 'saved', text: 'Saved.', hidden: !state.saved })
    ]);
  }
};

function render() {
  const name = location.hash.replace(/^#\/?/, '') || 'tasks';
  document.body.replaceChildren((screens[name] ?? screens.tasks)());
}
window.addEventListener('hashchange', () => { state.error = false; state.saved = false; render(); });
render();
