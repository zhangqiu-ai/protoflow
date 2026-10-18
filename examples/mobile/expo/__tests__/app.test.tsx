/**
 * The app's own functional tests (ProtoFlow `functional` for the expo target), on the real route tree.
 */
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

const texts = (testID: string) => screen.queryAllByTestId(testID).map(node => node.props.children);
const open = (initialUrl = '/') => renderRouter('./app', { initialUrl });

test('the app starts on the tasks screen', async () => {
  const router = await open();
  expect(router.getPathname()).toBe('/tasks');
  expect(texts('tasks.item')).toEqual(['Review prototype', 'Ship version']);
});

test('adding a task appends it and clears the field', async () => {
  await open('/tasks');
  await fireEvent.changeText(screen.getByTestId('tasks.input'), 'Write tests');
  await fireEvent.press(screen.getByTestId('tasks.add'));
  expect(texts('tasks.item')).toEqual(['Review prototype', 'Ship version', 'Write tests']);
  expect(screen.queryByTestId('tasks.error')).toBeNull();
  expect(screen.getByTestId('tasks.input').props.value).toBe('');
});

test('adding an empty task shows the error', async () => {
  await open('/tasks');
  await fireEvent.press(screen.getByTestId('tasks.add'));
  expect(screen.getByTestId('tasks.error')).toBeTruthy();
  expect(texts('tasks.item')).toHaveLength(2);
});

test('settings can be saved and closed', async () => {
  const router = await open('/tasks');
  await fireEvent.press(screen.getByTestId('tasks.settings'));
  expect(router.getPathname()).toBe('/settings');
  await fireEvent(screen.getByTestId('settings.notify-toggle'), 'valueChange', true);
  await fireEvent.press(screen.getByTestId('settings.save'));
  expect(screen.getByTestId('settings.saved')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('settings.back'));
  expect(router.getPathname()).toBe('/tasks');
});

test('a deep link opens settings directly, and Back still reaches tasks', async () => {
  const router = await open('/settings?state=initial');
  expect(router.getPathname()).toBe('/settings');
  await fireEvent.press(screen.getByTestId('settings.back'));
  expect(router.getPathname()).toBe('/tasks');
});
