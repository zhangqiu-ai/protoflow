// Application implementation: renders from data instead of static markup.
const state = { tasks: ['Review prototype', 'Ship version'] };
const list = document.getElementById('tasks');
function render() {
  list.replaceChildren(...state.tasks.map(title => {
    const item = document.createElement('li');
    item.dataset.testid = 'tasks.item';
    item.textContent = title;
    return item;
  }));
}
document.getElementById('new-task').addEventListener('submit', event => {
  event.preventDefault();
  const field = document.getElementById('title');
  const problem = document.getElementById('problem');
  const title = field.value.trim();
  problem.hidden = Boolean(title);
  if (!title) return;
  state.tasks.push(title);
  field.value = '';
  render();
});
render();
